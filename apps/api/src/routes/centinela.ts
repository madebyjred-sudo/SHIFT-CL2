/**
 * Centinela scheduler + admin trigger endpoints.
 *
 * TWO routers are exported from this file:
 *
 *   centinelaAdminRouter    → mounted at /api/admin/centinela
 *     POST /sync-now        — manual trigger: syncCentinelaWatchlist. Auth: logged-in user.
 *     POST /scrape-agenda   — manual trigger: scrapeAgenda.            Auth: logged-in user.
 *     POST /detect-similar  — manual trigger: detectSimilarExpedientes. Auth: logged-in user.
 *
 *   centinelaInternalRouter → mounted at /api/internal/centinela (within /api/internal)
 *     POST /sil-sync        — Cloud Scheduler every 30 min. Auth: X-Internal-Trigger.
 *     POST /agenda-scrape   — Cloud Scheduler daily 22:00 CR. Auth: X-Internal-Trigger.
 *     POST /similar-detect  — Cloud Scheduler every 30 min. Auth: X-Internal-Trigger.
 *
 * centinela-mentions is NOT here — it is triggered inline from transcriptProcess.ts.
 *
 * Auth model:
 *   Internal endpoints: shared-secret header (X-Internal-Trigger vs INTERNAL_TRIGGER_SECRET).
 *   Admin endpoints: getUserFromRequest() — any authenticated user (demo convention).
 *
 * Handler pattern:
 *   1. Validate auth → 401 on failure.
 *   2. Parse body (typed cast — matches existing route style, no zod dependency added).
 *   3. Call underlying job with options.
 *   4. Return JSON { ok: true, result: <jobResult> }.
 *   5. Unhandled exception → 500 with error message.
 */

import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { syncCentinelaWatchlist } from '../jobs/centinelaSilSync.js';
import { scrapeAgenda } from '../jobs/agendaScrape.js';
import { detectSimilarExpedientes } from '../jobs/centinelaSimilarDetect.js';
import { runSilDiscovery } from '../jobs/silDiscovery.js';
import { enrichExpedientesBulk } from '../jobs/silEnrichExpediente.js';
import { createClient as createSupaClient } from '@supabase/supabase-js';
import { getUserFromRequest, getUserIdFromRequest, type AuthedUser } from '../services/auth.js';
import { logger } from '../services/logger.js';
import { insertAndDispatch } from '../services/centinelaNotifier.js';
import { inferPriority, type CentinelaEventType } from '../services/centinelaMatchEngine.js';

// ── Lazy Supabase client (service role) ──────────────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for centinela router');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) { res.status(401).json({ ok: false, error: 'auth_required' }); return null; }
  return userId;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Validate the X-Internal-Trigger shared-secret header.
 * Returns true when the request is authorized, false otherwise.
 * Sends the appropriate error response on failure.
 */
function validateInternalTrigger(req: Request, res: Response): boolean {
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!secret) {
    req.log?.error('internal_trigger_secret_not_set');
    res.status(503).json({ ok: false, error: 'server_misconfigured' });
    return false;
  }

  const incoming = req.headers['x-internal-trigger'];
  if (!incoming || incoming !== secret) {
    req.log?.warn('centinela_internal_trigger_unauthorized', {
      has_header: !!incoming,
      ip: req.ip,
    });
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }

  return true;
}

// ── /api/internal/centinela router ───────────────────────────────────────────

export const centinelaInternalRouter = Router();

/**
 * POST /api/internal/centinela/sil-sync
 *
 * Called by Cloud Scheduler every 30 min. Runs syncCentinelaWatchlist().
 *
 * Cloud Scheduler reference (not code — deploy concern):
 *   gcloud scheduler jobs create http centinela-sil-sync \
 *     --schedule='*\/30 * * * *' \
 *     --uri="https://<service>/api/internal/centinela/sil-sync" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
centinelaInternalRouter.post('/sil-sync', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    const result = await syncCentinelaWatchlist();
    logger.info('centinela_internal_sil_sync_complete', {
      state_changes: result.state_changes.length,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_sil_sync_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/sil-enrich
 *
 * Llamado por Cloud Scheduler cada hora. Para cada expediente sin proponentes
 * registrados (entre los más recientes), llama al SIL WebForms y persiste el
 * enriched data (proponentes con orden, comisiones, fechas oficiales, gaceta,
 * número de ley, etc.). Procesa hasta N expedientes por run para no exceder
 * el timeout de 600s de Cloud Run.
 *
 * Cloud Scheduler reference:
 *   gcloud scheduler jobs create http centinela-sil-enrich \
 *     --schedule='0 * * * *' --time-zone='America/Costa_Rica' \
 *     --uri="https://<service>/api/internal/centinela/sil-enrich" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 *
 * Body opcional: { limit?: number, min_id?: number }
 *   - limit: máximo de expedientes a procesar (default 80, cabe en 600s)
 *   - min_id: solo procesar expedientes con id >= min_id (default 25000 = recientes)
 */
centinelaInternalRouter.post('/sil-enrich', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  const body = (req.body ?? {}) as {
    limit?: number;
    min_id?: number;
    /**
     * Cuando se activa, en lugar de excluir expedientes ya con proponentes
     * (modo default que cubre el backfill inicial), el endpoint TARGETEA
     * expedientes que SÍ tienen proponentes pero NO tienen consultas
     * todavía. Sirve para backfillear Pedidos 04 + 16k sobre los
     * expedientes ya procesados antes del deploy del parser nuevo
     * (2026-05-20). El enricher es idempotente (DELETE+INSERT en todas
     * las tablas) así que re-correrlo no rompe nada.
     */
    re_enrich_for_consultas?: boolean;
  };
  const limit = Math.min(Math.max(body.limit ?? 80, 1), 200);
  const minId = body.min_id ?? 25000;
  const reEnrichForConsultas = body.re_enrich_for_consultas === true;

  try {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) throw new Error('supabase env missing');
    const s = createSupaClient(supaUrl, supaKey, { auth: { persistSession: false, autoRefreshToken: false } });

    let targets: string[];

    if (reEnrichForConsultas) {
      // Backfill de Pedidos 04 + 16k sobre expedientes ya procesados.
      // Pedimos los expedientes que SÍ tienen proponentes pero NO tienen
      // consultas. (Algunos tendrán 0 consultas reales — los marcamos como
      // "intentados" via cualquier otra señal, pero por simplicidad acá
      // el reintento sobre los que ya intentamos no rompe nada porque el
      // enricher es idempotente.)
      const { data: withProp } = await s.from('sil_expediente_proponentes').select('expediente_id');
      const propSet = new Set((withProp ?? []).map((r) => r.expediente_id as string));
      const { data: withCons } = await s.from('sil_expediente_consultas').select('expediente_id');
      const consSet = new Set((withCons ?? []).map((r) => r.expediente_id as string));

      const { data: candidates } = await s
        .from('sil_expedientes')
        .select('numero, id')
        .gte('id', minId)
        .order('id', { ascending: false })
        .limit(limit * 5);

      targets = (candidates ?? [])
        .filter((r) => propSet.has(r.numero as string) && !consSet.has(r.numero as string))
        .slice(0, limit)
        .map((r) => r.numero as string);
    } else {
      // Modo default: enrich inicial — expedientes SIN proponentes.
      const { data: withProp } = await s.from('sil_expediente_proponentes').select('expediente_id');
      const enrichedSet = new Set((withProp ?? []).map((r) => r.expediente_id as string));

      const { data: candidates } = await s
        .from('sil_expedientes')
        .select('numero, id')
        .gte('id', minId)
        .order('id', { ascending: false })
        .limit(limit * 5); // sobre-pedimos porque algunos ya están enriched

      targets = (candidates ?? [])
        .filter((r) => !enrichedSet.has(r.numero as string))
        .slice(0, limit)
        .map((r) => r.numero as string);
    }

    if (targets.length === 0) {
      res.json({
        ok: true,
        result: {
          enriched: 0,
          message: reEnrichForConsultas
            ? 'no targets — todos los expedientes ya tienen consultas registradas'
            : 'no targets — all up to date',
        },
      });
      return;
    }

    const result = await enrichExpedientesBulk(s, targets, { politenessMs: 700 });
    logger.info('centinela_internal_sil_enrich_complete', {
      ...result,
      mode: reEnrichForConsultas ? 're_enrich_for_consultas' : 'initial',
      processed: targets.length,
    });
    res.json({ ok: true, result, processed: targets.length, mode: reEnrichForConsultas ? 're_enrich_for_consultas' : 'initial' });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_sil_enrich_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/scan-mociones
 *
 * Pedido 11 / 11bis del cliente CL2: alerta cuando se presenta una
 * moción en un expediente del watchlist. Corre cada 30min (Cloud
 * Scheduler) o on-demand.
 *
 * Body opcional: { since?: string, limit?: number }
 *   - since: ISO timestamp — solo mociones scraped después. Default = hace 24h.
 *   - limit: cap de mociones (default 500).
 */
centinelaInternalRouter.post('/scan-mociones', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  const body = (req.body ?? {}) as { since?: string; limit?: number };

  try {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) throw new Error('supabase env missing');
    const s = createSupaClient(supaUrl, supaKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { scanMocionesParaAlertas } = await import('../jobs/mocionAlertScan.js');
    const result = await scanMocionesParaAlertas(s, {
      since: body.since,
      limit: body.limit,
    });

    logger.info('centinela_internal_scan_mociones_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_scan_mociones_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/extract-fechas-dictamen
 *
 * Pedido 07 / 16g / 16h del cliente CL2.
 *
 * Corre el extractor de "fecha estimada de dictamen" sobre los documentos
 * del SIL (sil_documentos.text_extracted) y persiste a
 * sil_expediente_fechas_extraidas con campo='fecha_dictamen_estimada'.
 * Si la fecha cambió respecto a la vigente, marca la previa como
 * superseded_by → la nueva (chain histórico — Pedido 16h).
 *
 * Body opcional: { limit?: number, since?: string, force_reextract?: boolean,
 *                  expediente_filter?: string[] }
 *   - limit: máximo de docs a procesar (default 500, cap 2000)
 *   - since: ISO date — solo docs creados después
 *   - force_reextract: ignora caché y re-procesa docs ya intentados
 *   - expediente_filter: lista de numeros (ej. ['23.511', '24.982'])
 *     para procesar SOLO esos
 */
centinelaInternalRouter.post('/extract-fechas-dictamen', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  const body = (req.body ?? {}) as {
    limit?: number;
    since?: string;
    force_reextract?: boolean;
    expediente_filter?: string[];
  };
  const limit = Math.min(Math.max(body.limit ?? 500, 1), 2000);

  try {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) throw new Error('supabase env missing');
    const s = createSupaClient(supaUrl, supaKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { extractFechasDictamenBulk } = await import('../jobs/extractFechasDictamen.js');

    const result = await extractFechasDictamenBulk(s, {
      limit,
      since: body.since,
      forceReextract: body.force_reextract === true,
      expedienteFilter: body.expediente_filter,
    });

    logger.info('centinela_internal_extract_fechas_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_extract_fechas_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/sil-discovery
 *
 * Llamado por Cloud Scheduler diariamente. Descubre expedientes nuevos
 * presentados en la Asamblea desde el último ingest (busca números
 * consecutivos arriba del max actual en DB).
 *
 * Cloud Scheduler reference:
 *   gcloud scheduler jobs create http centinela-sil-discovery \
 *     --schedule='0 7 * * *' --time-zone='America/Costa_Rica' \
 *     --uri="https://<service>/api/internal/centinela/sil-discovery" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
centinelaInternalRouter.post('/sil-discovery', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    const result = await runSilDiscovery();
    logger.info('centinela_internal_sil_discovery_complete', {
      discovered: result.discovered_count,
      empty: result.empty_count,
      failed: result.failed_count,
      starting_numero: result.starting_numero,
      ending_numero: result.ending_numero,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_sil_discovery_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/agenda-scrape
 *
 * Called by Cloud Scheduler daily at 22:00 CR time. Runs scrapeAgenda().
 *
 * Cloud Scheduler reference:
 *   gcloud scheduler jobs create http centinela-agenda-scrape \
 *     --schedule='0 22 * * *' --time-zone='America/Costa_Rica' \
 *     --uri="https://<service>/api/internal/centinela/agenda-scrape" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
centinelaInternalRouter.post('/agenda-scrape', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    const result = await scrapeAgenda();
    logger.info('centinela_internal_agenda_scrape_complete', {
      scraped_count: result.scraped_count,
      agenda_inserted: result.agenda_inserted,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_agenda_scrape_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/similar-detect
 *
 * Called by Cloud Scheduler every 30 min, after sil-sync. Runs detectSimilarExpedientes().
 *
 * Cloud Scheduler reference:
 *   gcloud scheduler jobs create http centinela-similar-detect \
 *     --schedule='15 * * * *' \
 *     --uri="https://<service>/api/internal/centinela/similar-detect" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
centinelaInternalRouter.post('/similar-detect', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    const result = await detectSimilarExpedientes();
    logger.info('centinela_internal_similar_detect_complete', {
      candidates_processed: result.candidates_processed,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_similar_detect_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/novelty-scan
 *
 * Sprint 2 Track I — cron 30 min que corre noveltyDetector sobre cada
 * expediente en watchlist activa y persiste novedades nuevas a
 * `centinela_eventos` (con dedup_key). Reemplaza el detect-on-read del
 * endpoint /full por una tabla pre-populated.
 *
 * Cloud Scheduler reference:
 *   gcloud scheduler jobs create http cl2-novelty-scan \
 *     --schedule='*\/30 * * * *' --time-zone='America/Costa_Rica' \
 *     --uri="https://<service>/api/internal/centinela/novelty-scan" \
 *     --http-method=POST \
 *     --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
centinelaInternalRouter.post('/novelty-scan', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    // Import lazy para evitar coupling fuerte con el job module
    const { runNoveltyScan } = await import('../jobs/noveltyScan.js');
    const result = await runNoveltyScan();
    logger.info('centinela_internal_novelty_scan_complete', {
      users: result.users,
      expedientes: result.expedientes,
      novedades_new: result.novedades_new,
      novedades_skipped_dup: result.novedades_skipped_dup,
      errors: result.errors,
      duration_ms: result.duration_ms,
    });
    res.json({ ok: true, started_at: new Date().toISOString(), result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_novelty_scan_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/daily-health-report
 *
 * Llamado por Cloud Scheduler una vez al día a las 6am CR. Captura un
 * snapshot del estado del backend (counts, freshness por tabla, alertas
 * por freshness threshold) y lo persiste en `cl2_daily_health`.
 *
 * Por qué existe: agregar 1 query timeseries en lugar de revisar logs
 * job por job para ver si algo se rompió silenciosamente. Ver
 * `dailyHealthReport.ts` para el contrato completo.
 *
 * Body: ninguno. Devuelve { ok, result: { status, alerts, snapshot_id, ... } }.
 */
centinelaInternalRouter.post('/daily-health-report', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;

  try {
    const { runDailyHealthReport } = await import('../jobs/dailyHealthReport.js');
    const result = await runDailyHealthReport();
    logger.info('centinela_internal_daily_health_complete', {
      status: result.status,
      alerts_count: result.alerts.length,
      duration_ms: result.duration_ms,
      snapshot_id: result.snapshot_id,
    });
    res.json({ ok: true, started_at: new Date().toISOString(), result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_daily_health_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/llm-enrich-docs
 *
 * Llamado por Cloud Scheduler cada 30 min. Procesa un batch de docs SIL sin
 * resumen/POR TANTO/decisión vía LLM (Haiku 4.5 vía OpenRouter). Page size
 * bajo (50) para no triggerar PostgreSQL statement timeout. Cost por batch:
 * ~$0.30. Si bg backfill cubre los 22K primero, el cron solo procesa los
 * nuevos docs que entran al sistema (~ centavos/día).
 *
 * Body opcional: { limit?: number, dry_run?: bool, tipo?: string[] }
 */
centinelaInternalRouter.post('/llm-enrich-docs', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;
  const body = (req.body ?? {}) as { limit?: number; dry_run?: boolean; tipo?: string[] };
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 500);
  try {
    const { runLlmEnrichDocs } = await import('../jobs/llmEnrichDocs.js');
    const result = await runLlmEnrichDocs({
      limit,
      dry_run: body.dry_run ?? false,
      tipo_filter: body.tipo,
      concurrency: 5,
    });
    logger.info('centinela_internal_llm_enrich_complete', { ...result, requested_limit: limit });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_llm_enrich_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/categorize-expedientes
 *
 * Diario 4am. Clasifica expedientes nuevos/desactualizados en N de las 51
 * categorías canónicas CL2 vía LLM. Sprint 3 Track P.
 */
centinelaInternalRouter.post('/categorize-expedientes', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;
  try {
    const { runCategorizeExpedientes } = await import('../jobs/categorizeExpedientes.js');
    const result = await runCategorizeExpedientes({});
    logger.info('centinela_internal_categorize_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_categorize_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/resumen-mixto
 *
 * Diario 5am. Genera resumen editorial 3-párrafos por expediente (contexto,
 * posturas, próximos pasos) vía LLM. Sprint 3 Track P.
 */
centinelaInternalRouter.post('/resumen-mixto', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;
  try {
    const { runGenerateResumenes } = await import('../jobs/generateResumenMixto.js');
    const result = await runGenerateResumenes({});
    logger.info('centinela_internal_resumen_mixto_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_resumen_mixto_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/informe-semanal
 *
 * Lunes 6am. Genera informe semanal por cada user con watchlist activa.
 * Sprint 3 Track P.
 */
centinelaInternalRouter.post('/informe-semanal', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;
  try {
    const { runGenerateInformesSemanales } = await import('../jobs/generateInformeSemanal.js');
    const result = await runGenerateInformesSemanales({});
    logger.info('centinela_internal_informe_semanal_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_informe_semanal_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/internal/centinela/ingest-transcript-chunks
 *
 * Cada 30 min. Detecta sesiones plenarias con `transcript_segments` pero SIN
 * chunks en `legislative_chunks` (delta-only), las agrupa en bloques de
 * ~3000 chars, genera embeddings vía Vertex e inserta a la tabla — para que
 * Lexa pueda citar lo que se dijo en sesiones nuevas.
 *
 * Body opcional: { limit_sessions?: number } (default 8, max 50)
 */
centinelaInternalRouter.post('/ingest-transcript-chunks', async (req, res) => {
  if (!validateInternalTrigger(req, res)) return;
  const body = (req.body ?? {}) as { limit_sessions?: number };
  try {
    const { runIngestTranscriptChunks } = await import('../jobs/ingestTranscriptChunks.js');
    const result = await runIngestTranscriptChunks({ limit_sessions: body.limit_sessions });
    logger.info('centinela_internal_ingest_transcripts_complete', { ...result });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_internal_ingest_transcripts_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// NOTA: download-sil-docs y ingest-ral-chunks no tienen scheduler (a hoy).
// Para download-sil-docs: el script `download-sil-bulk.ts` necesita ejecutarse
// como Cloud Run Job (no HTTP service) por OOM y permissions GCS. Manual por
// ahora: `npm run download:sil:bulk`. Pendiente: migrarlo a Cloud Run Job +
// Scheduler para automatización completa.
// Para ingest-ral-chunks: Reglamento estable, manual con `npm run ingest:ral`.

// ── /api/admin/centinela router ───────────────────────────────────────────────

export const centinelaAdminRouter = Router();

/**
 * POST /api/admin/centinela/sync-now
 *
 * Manual admin trigger for the SIL watchlist sync.
 *
 * Body (optional):
 *   dryRun?  boolean   if true, no DB writes; returns what-would-change summary
 *   limit?   number    cap on distinct expedientes to process (for targeted re-runs)
 */
centinelaAdminRouter.post('/sync-now', async (req, res) => {
  const user = await getUserFromRequest(req) as AuthedUser | null;
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const dryRun: boolean = req.body?.dryRun === true;
  const limit: number | undefined =
    typeof req.body?.limit === 'number' ? req.body.limit : undefined;

  logger.info('centinela_admin_sync_now_start', {
    actor: user.email,
    dryRun,
    limit,
  });

  try {
    const result = await syncCentinelaWatchlist({ dryRun, limit });
    logger.info('centinela_admin_sync_now_complete', {
      actor: user.email,
      state_changes: result.state_changes.length,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
      dryRun,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_admin_sync_now_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/admin/centinela/scrape-agenda
 *
 * Manual admin trigger for the agenda scrape.
 *
 * Body (optional):
 *   dryRun?    boolean   if true, no DB writes
 *   daysAhead? number    how many days ahead to accept (default 14)
 */
centinelaAdminRouter.post('/scrape-agenda', async (req, res) => {
  const user = await getUserFromRequest(req) as AuthedUser | null;
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const dryRun: boolean = req.body?.dryRun === true;
  const daysAhead: number | undefined =
    typeof req.body?.daysAhead === 'number' ? req.body.daysAhead : undefined;

  logger.info('centinela_admin_scrape_agenda_start', {
    actor: user.email,
    dryRun,
    daysAhead,
  });

  try {
    const result = await scrapeAgenda({ dryRun, daysAhead });
    logger.info('centinela_admin_scrape_agenda_complete', {
      actor: user.email,
      scraped_count: result.scraped_count,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
      dryRun,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_admin_scrape_agenda_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /api/admin/centinela/detect-similar
 *
 * Manual admin trigger for similar-expediente detection.
 *
 * Body (optional):
 *   dryRun?                  boolean    if true, no DB writes
 *   candidateExpedienteIds?  number[]   if provided, scan only these expedientes
 *   similarityThreshold?     number     cosine similarity threshold (default 0.75)
 */
centinelaAdminRouter.post('/detect-similar', async (req, res) => {
  const user = await getUserFromRequest(req) as AuthedUser | null;
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const dryRun: boolean = req.body?.dryRun === true;
  const candidateExpedienteIds: number[] | undefined = Array.isArray(
    req.body?.candidateExpedienteIds,
  )
    ? (req.body.candidateExpedienteIds as number[])
    : undefined;
  const similarityThreshold: number | undefined =
    typeof req.body?.similarityThreshold === 'number'
      ? req.body.similarityThreshold
      : undefined;

  logger.info('centinela_admin_detect_similar_start', {
    actor: user.email,
    dryRun,
    candidateCount: candidateExpedienteIds?.length ?? 'auto',
    similarityThreshold,
  });

  try {
    const result = await detectSimilarExpedientes({
      dryRun,
      candidateExpedienteIds,
      similarityThreshold,
    });
    logger.info('centinela_admin_detect_similar_complete', {
      actor: user.email,
      candidates_processed: result.candidates_processed,
      alerts_inserted: result.alerts_inserted,
      errors: result.errors.length,
      dryRun,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_admin_detect_similar_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// USER-FACING ROUTER — /api/centinela
// ═══════════════════════════════════════════════════════════════════════════
//
// Powers the /centinela page in the SPA: alerts feed, watchlist CRUD, prefs,
// and a summary endpoint that drives the dynamic page header (counts).
//
// All endpoints are RLS-aware: we always scope by `user_id = auth.uid()`
// pulled from the Supabase JWT. We use the service-role client for writes
// (because some related tables don't expose RLS-friendly read paths) but
// every query carries an explicit user_id filter so a leaked token can't
// see another user's data.

export const centinelaUserRouter = Router();

// ── GET /api/centinela/summary ─────────────────────────────────────────────
//
// Drives the page hero copy: "X alertas nuevas · Y en tu watchlist".
// Cheap and chatty — UI fetches this on mount and after any watchlist /
// alerts mutation to refresh the header.
centinelaUserRouter.get('/summary', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const [unreadAlerts, totalAlerts, watchlistItems, prefs] = await Promise.all([
      supa().from('centinela_alerts').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).is('read_at', null),
      supa().from('centinela_alerts').select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      supa().from('centinela_watchlist').select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      supa().from('centinela_alert_prefs').select('digest_enabled, channels, alert_types_on')
        .eq('user_id', userId).maybeSingle(),
    ]);

    // Severity breakdown for the unread bucket — drives the "X críticas, Y
    // info" subline in the hero.
    const { data: severityRows } = await supa()
      .from('centinela_alerts')
      .select('severity')
      .eq('user_id', userId)
      .is('read_at', null);

    const severity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    for (const r of (severityRows ?? []) as Array<{ severity: string }>) {
      severity[r.severity] = (severity[r.severity] ?? 0) + 1;
    }

    res.json({
      ok: true,
      unread: unreadAlerts.count ?? 0,
      total: totalAlerts.count ?? 0,
      watchlist: watchlistItems.count ?? 0,
      severity,
      prefs: prefs.data ?? null,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_summary_failed', { userId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/feed ────────────────────────────────────────────────
//
// Paginated alerts feed. Default sort is created_at DESC (newest first).
// Filters: type, severity, unread_only.
//
// Query params:
//   limit         number  default 20, max 100
//   cursor        ISO timestamp; returns alerts created_at < cursor
//   type          'state_change' | 'deadline' | 'mention' | 'agenda' | 'similar' | 'digest_weekly'
//   severity      'info' | 'warning' | 'critical'
//   unread_only   '1' to filter to unread only
centinelaUserRouter.get('/feed', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '20', 10) || 20, 1), 100);
  const cursor = (req.query.cursor as string) ?? null;
  const type = (req.query.type as string) ?? null;
  const severity = (req.query.severity as string) ?? null;
  const unreadOnly = (req.query.unread_only as string) === '1';

  try {
    let q = supa()
      .from('centinela_alerts')
      .select('id, alert_type, entity_type, entity_id, severity, payload, dedup_key, read_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (cursor) q = q.lt('created_at', cursor);
    if (type) q = q.eq('alert_type', type);
    if (severity) q = q.eq('severity', severity);
    if (unreadOnly) q = q.is('read_at', null);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const items = data ?? [];
    const nextCursor = items.length === limit
      ? (items[items.length - 1] as { created_at: string }).created_at
      : null;

    res.json({ ok: true, items, nextCursor });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_feed_failed', { userId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── POST /api/centinela/alerts/:id/read ────────────────────────────────────
centinelaUserRouter.post('/alerts/:id/read', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  try {
    const { error } = await supa()
      .from('centinela_alerts')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── POST /api/centinela/alerts/read-all ────────────────────────────────────
centinelaUserRouter.post('/alerts/read-all', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const { error } = await supa()
      .from('centinela_alerts')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/watchlist ───────────────────────────────────────────
//
// The schema stores label/notes inside `metadata jsonb` (see migration 0019).
// We unwrap it here so the client gets a flat shape — keeps the UI simple
// and means we can evolve metadata without breaking the API contract.
centinelaUserRouter.get('/watchlist', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const { data, error } = await supa()
      .from('centinela_watchlist')
      .select('id, entity_type, entity_id, source, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((r) => {
      const meta = (r.metadata ?? {}) as { label?: string; notes?: string };
      return {
        id: r.id as string,
        entity_type: r.entity_type as string,
        entity_id: r.entity_id as string,
        label: meta.label ?? null,
        notes: meta.notes ?? null,
        created_at: r.created_at as string,
      };
    });
    res.json({ ok: true, items });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── POST /api/centinela/watchlist ──────────────────────────────────────────
//
// Body: { entity_type, entity_id, label?, notes? }
//
// IMPORTANT (2026-04-29 bug fix): the actual unique constraint is on
// (user_id, entity_type, entity_id, source) — NOT just the first three.
// Earlier code used the wrong onConflict columns AND tried to insert
// `label`/`notes` as flat columns. Both wrong: those fields live inside
// `metadata jsonb`, and `source` defaults to 'manual' so we can include
// it explicitly in the conflict key.
centinelaUserRouter.post('/watchlist', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { entity_type, entity_id, label, notes, client_id } = (req.body ?? {}) as {
    entity_type?: string; entity_id?: string; label?: string; notes?: string;
    client_id?: string | null;
  };
  if (!entity_type || !entity_id) {
    res.status(400).json({ ok: false, error: 'entity_type_and_entity_id_required' });
    return;
  }
  if (!['expediente', 'diputado', 'tema'].includes(entity_type)) {
    res.status(400).json({ ok: false, error: 'invalid_entity_type', hint: 'expediente|diputado|tema' });
    return;
  }

  const metadata: Record<string, unknown> = {};
  if (label) metadata.label = label;
  if (notes) metadata.notes = notes;

  // client_id (opcional, 2026-05-11) — scopa la entrada a un cliente
  // del consultor. La misma entidad puede aparecer scopeada a varios
  // clientes con intereses distintos. Si viene `null` o no viene, queda
  // como watchlist "general" del consultor (compat con el modelo viejo).
  const insertRow: Record<string, unknown> = {
    user_id: userId,
    entity_type,
    entity_id,
    source: 'manual',
    metadata,
  };
  if (client_id) insertRow.client_id = client_id;

  try {
    const { data, error } = await supa()
      .from('centinela_watchlist')
      .upsert(insertRow, {
        // Con migration 0027, el unique cambió a (user_id, entity_type,
        // entity_id, source, client_id). Reflejamos eso acá para que el
        // upsert no choque cuando agregás la misma entidad para dos
        // clientes distintos.
        onConflict: 'user_id,entity_type,entity_id,source,client_id',
        ignoreDuplicates: false,
      })
      .select('id, entity_type, entity_id, source, metadata, client_id, created_at')
      .single();
    if (error) throw new Error(error.message);
    const meta = (data.metadata ?? {}) as { label?: string; notes?: string };
    res.json({
      ok: true,
      item: {
        id: data.id,
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        label: meta.label ?? null,
        notes: meta.notes ?? null,
        created_at: data.created_at,
      },
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_watchlist_add_failed', {
      userId, entity_type, entity_id, error: message,
    });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── DELETE /api/centinela/watchlist/:id ────────────────────────────────────
centinelaUserRouter.delete('/watchlist/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  try {
    const { error } = await supa()
      .from('centinela_watchlist')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/prefs ───────────────────────────────────────────────
centinelaUserRouter.get('/prefs', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const { data, error } = await supa()
      .from('centinela_alert_prefs')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Return defaults when the user has never opened settings — saves a
    // separate "have you initialized?" round-trip on the client.
    const prefs = data ?? {
      user_id: userId,
      channels: { in_app: true, email: false, slack: false, whatsapp: false, telegram: false },
      alert_types_on: ['state_change', 'deadline', 'mention', 'agenda'],
      digest_enabled: false,
      quiet_hours: null,
    };
    res.json({ ok: true, prefs });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/autocomplete?type=expediente|diputado&q=… ───────────
//
// Powers the watchlist add field's typeahead. Two modes:
//
//   type=expediente  Match by numero prefix ("24.4" → 24.400-24.499) AND by
//                    titulo ILIKE. Combined into one ranked list. Returns
//                    `entity_id` (the canonical "24.429" form) + `label`
//                    (titulo).
//
//   type=diputado    Distinct values from sil_expedientes.proponente
//                    (we don't have a clean diputados table yet). Returns
//                    `entity_id` and `label` set equal — we use the
//                    apellido string as both the human label and the watch
//                    key. Sufficient for matching mentions in transcripts
//                    via pg_trgm fuzzy.
//
// No auth gate beyond requireUser — these are list reads of public-ish
// legislative data. Limit 8 hardcoded.
centinelaUserRouter.get('/autocomplete', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const type = (req.query.type as string) ?? '';
  const q = ((req.query.q as string) ?? '').trim();
  if (!type || !['expediente', 'diputado'].includes(type)) {
    res.status(400).json({ ok: false, error: 'invalid_type', hint: 'type=expediente|diputado' });
    return;
  }
  if (q.length < 2) {
    // Bail early on too-short queries — saves DB hits and avoids noise.
    res.json({ ok: true, items: [] });
    return;
  }

  try {
    if (type === 'expediente') {
      // Numero match is anchored — "24.4" should beat free-text matches that
      // happen to contain "24.4" inside a paragraph. Two queries, dedup.
      const [byNumero, byTitle] = await Promise.all([
        supa()
          .from('sil_expedientes')
          .select('numero, titulo, proponente, fecha_presentacion')
          .ilike('numero', `${q}%`)
          .limit(8),
        supa()
          .from('sil_expedientes')
          .select('numero, titulo, proponente, fecha_presentacion')
          .ilike('titulo', `%${q}%`)
          .limit(8),
      ]);
      const seen = new Set<string>();
      const items: Array<{ entity_id: string; label: string; hint: string }> = [];
      for (const row of [...(byNumero.data ?? []), ...(byTitle.data ?? [])]) {
        const r = row as { numero: string; titulo: string; proponente: string | null; fecha_presentacion: string | null };
        if (seen.has(r.numero)) continue;
        seen.add(r.numero);
        const fechaSlim = r.fecha_presentacion?.slice(0, 4) ?? '';
        const hintParts: string[] = [];
        if (r.proponente) hintParts.push(r.proponente);
        if (fechaSlim) hintParts.push(fechaSlim);
        items.push({
          entity_id: r.numero,
          label: r.titulo ?? r.numero,
          hint: hintParts.join(' · '),
        });
        if (items.length >= 8) break;
      }
      res.json({ ok: true, items });
      return;
    }

    if (type === 'diputado') {
      // No clean diputados table yet — derive from sil_expedientes.proponente.
      // ILIKE on the source column with DISTINCT-on at the app layer (Postgres
      // doesn't expose distinct() on PostgREST cleanly).
      const { data, error } = await supa()
        .from('sil_expedientes')
        .select('proponente')
        .ilike('proponente', `%${q}%`)
        .not('proponente', 'is', null)
        .limit(120);
      if (error) throw new Error(error.message);

      // Rank by occurrence count (more bills authored = more likely match).
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as Array<{ proponente: string }>) {
        const key = row.proponente.trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const items = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({
          entity_id: name,
          label: name,
          hint: `${count} expediente${count === 1 ? '' : 's'}`,
        }));
      res.json({ ok: true, items });
      return;
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_autocomplete_failed', { type, q, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── PATCH /api/centinela/prefs ─────────────────────────────────────────────
//
// Body: subset of {channels, alert_types_on, digest_enabled, quiet_hours}.
// Upsert semantics — first call creates the row.
centinelaUserRouter.patch('/prefs', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { channels, alert_types_on, digest_enabled, quiet_hours } = (req.body ?? {}) as {
    channels?: Record<string, boolean>;
    alert_types_on?: string[];
    digest_enabled?: boolean;
    quiet_hours?: { start?: string; end?: string; tz?: string } | null;
  };

  // Build a sparse update — only include fields that were explicitly sent.
  // This lets the client toggle a single channel without re-sending the rest.
  const update: Record<string, unknown> = { user_id: userId };
  if (channels !== undefined) update.channels = channels;
  if (alert_types_on !== undefined) update.alert_types_on = alert_types_on;
  if (digest_enabled !== undefined) update.digest_enabled = digest_enabled;
  if (quiet_hours !== undefined) update.quiet_hours = quiet_hours;

  try {
    const { data, error } = await supa()
      .from('centinela_alert_prefs')
      .upsert(update, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, prefs: data });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NUEVOS ENDPOINTS TRACK C — centinela_eventos + centinela_alerts_v2
// Agregados 2026-05-14 por pedido 16d: prioridades estructuradas.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/centinela/eventos?priority=critical&limit=50 ─────────────────
//
// Audit/dev-friendly: lista los eventos del sistema (tabla centinela_eventos).
// Filtros: priority, event_type, expediente_id, limit, cursor (detected_at).
// Auth: usuario logueado (los eventos son datos públicos).
centinelaUserRouter.get('/eventos', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '50', 10) || 50, 1), 200);
  const priority = (req.query.priority as string) ?? null;
  const event_type = (req.query.event_type as string) ?? null;
  const expediente_id = (req.query.expediente_id as string) ?? null;
  const cursor = (req.query.cursor as string) ?? null;

  try {
    let q = supa()
      .from('centinela_eventos')
      .select('id, event_type, priority, expediente_id, payload, source_url, comision, diputado, materia, detected_at')
      .order('detected_at', { ascending: false })
      .limit(limit);

    if (priority) q = q.eq('priority', priority);
    if (event_type) q = q.eq('event_type', event_type);
    if (expediente_id) q = q.eq('expediente_id', expediente_id);
    if (cursor) q = q.lt('detected_at', cursor);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const items = data ?? [];
    const nextCursor = items.length === limit
      ? (items[items.length - 1] as { detected_at: string }).detected_at
      : null;

    res.json({ ok: true, items, nextCursor });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_eventos_list_failed', { userId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/alertas ────────────────────────────────────────────
//
// Alertas del usuario actual (tabla centinela_alerts_v2), no leídas primero.
// Filtros: priority, unread_only, limit, cursor.
centinelaUserRouter.get('/alertas', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '30', 10) || 30, 1), 100);
  const priority = (req.query.priority as string) ?? null;
  const unreadOnly = (req.query.unread_only as string) === '1';
  const cursor = (req.query.cursor as string) ?? null;

  try {
    let q = supa()
      .from('centinela_alerts_v2')
      .select('id, event_id, watch_id, priority, title, body, delivered_at, read_at, snoozed_until, channel')
      .eq('user_id', userId)
      // No leídas primero, luego por fecha desc
      .order('read_at', { ascending: true, nullsFirst: true })
      .order('delivered_at', { ascending: false })
      .limit(limit);

    if (priority) q = q.eq('priority', priority);
    if (unreadOnly) q = q.is('read_at', null);
    if (cursor) q = q.lt('delivered_at', cursor);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const items = data ?? [];
    const nextCursor = items.length === limit
      ? (items[items.length - 1] as { delivered_at: string }).delivered_at
      : null;

    res.json({ ok: true, items, nextCursor });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.warn('centinela_alertas_list_failed', { userId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── PATCH /api/centinela/alertas/:id/read ─────────────────────────────────
//
// Marca una alerta (centinela_alerts_v2) como leída.
centinelaUserRouter.patch('/alertas/:id/read', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  try {
    const { error } = await supa()
      .from('centinela_alerts_v2')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── PATCH /api/centinela/alertas/:id/snooze ───────────────────────────────
//
// Snooze una alerta por X horas.
// Body: { hours: 1 | 24 | 48 }
centinelaUserRouter.patch('/alertas/:id/snooze', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  const hours = Math.max(1, Math.min(168, Number(req.body?.hours ?? 1)));
  const snoozedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  try {
    const { error } = await supa()
      .from('centinela_alerts_v2')
      .update({ snoozed_until: snoozedUntil })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true, snoozed_until: snoozedUntil });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/centinela/alertas/badge ─────────────────────────────────────
//
// Conteo rápido de alertas no leídas por priority. Alimenta el AlertasBadge.
// Muy liviano: solo COUNT, sin datos.
centinelaUserRouter.get('/alertas/badge', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    // Excluir leídas y snoozeadas activas (snoozed_until en el futuro).
    // Alertas con snooze ya vencido (snoozed_until en el pasado) SÍ se cuentan.
    const now = new Date().toISOString();
    const { data, error } = await supa()
      .from('centinela_alerts_v2')
      .select('priority')
      .eq('user_id', userId)
      .is('read_at', null)
      .or(`snoozed_until.is.null,snoozed_until.lte.${now}`);

    if (error) throw new Error(error.message);

    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, info: 0 };
    for (const row of (data ?? []) as Array<{ priority: string }>) {
      counts[row.priority] = (counts[row.priority] ?? 0) + 1;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const highestPriority =
      counts.critical > 0 ? 'critical'
      : counts.high > 0 ? 'high'
      : counts.medium > 0 ? 'medium'
      : counts.info > 0 ? 'info'
      : null;

    res.json({ ok: true, total, counts, highestPriority });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── POST /api/centinela/eventos (admin / dev) ─────────────────────────────
//
// Inserta un evento manualmente y dispara el match engine.
// SOLO para testing y demo. En producción, los eventos los inserta el crawler.
// Auth: usuario logueado (se valida; en prod proteger con admin gate).
centinelaUserRouter.post('/eventos', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const {
    event_type,
    expediente_id,
    payload,
    source_url,
    comision,
    diputado,
    materia,
    priority: priorityOverride,
  } = (req.body ?? {}) as {
    event_type?: string;
    expediente_id?: string;
    payload?: Record<string, unknown>;
    source_url?: string;
    comision?: string;
    diputado?: string;
    materia?: string;
    priority?: string;
  };

  if (!event_type) {
    res.status(400).json({ ok: false, error: 'event_type_required' });
    return;
  }

  const validTypes: CentinelaEventType[] = [
    'orden_dia_publicada', 'cambio_estado', 'mocion_fondo_presentada',
    'audiencia_confirmada', 'resolucion_sala_constitucional', 'ley_publicada',
    'decreto_convocatoria', 'fecha_dictamen_proxima', 'plazo_cuatrienal_proximo',
    'desviacion_procedimental',
  ];

  if (!validTypes.includes(event_type as CentinelaEventType)) {
    res.status(400).json({ ok: false, error: 'invalid_event_type', valid: validTypes });
    return;
  }

  const typedPayload = (payload ?? {}) as Record<string, unknown>;
  const inferredPriority = inferPriority(event_type as CentinelaEventType, typedPayload);
  const finalPriority = (['critical', 'high', 'medium', 'info'].includes(priorityOverride ?? ''))
    ? priorityOverride as 'critical' | 'high' | 'medium' | 'info'
    : inferredPriority;

  try {
    const result = await insertAndDispatch({
      event_type: event_type as CentinelaEventType,
      priority: finalPriority,
      expediente_id: expediente_id ?? null,
      payload: typedPayload,
      source_url: source_url ?? null,
      comision: comision ?? null,
      diputado: diputado ?? null,
      materia: materia ?? null,
    }, supa());

    logger.info('centinela_evento_manual_insert', {
      actor: userId,
      event_id: result.evento.id,
      event_type,
      priority: finalPriority,
      matches: result.matches,
      persisted: result.persisted,
    });

    res.json({
      ok: true,
      evento: result.evento,
      matches: result.matches,
      persisted: result.persisted,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('centinela_evento_manual_insert_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});
