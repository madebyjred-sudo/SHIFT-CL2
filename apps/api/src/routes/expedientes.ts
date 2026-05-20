/**
 * Expedientes BFF — our own canonical view of a SIL expediente.
 *
 * Why: ASP.NET WebForms (consultassil3) is stateful — there is no
 * deep-linkable URL per expediente. Instead of dropping users on the
 * SIL search page, we serve the expediente from our own data:
 *   - metadata from sil_expedientes (Supabase)
 *   - attached docs list from sil_documentos
 *   - PDF originals streamed from gs://shift-cl2-sil/docs/<doc.id>.pdf
 *
 * Auth: every endpoint requires a valid Supabase JWT. Service-role on
 * Supabase + bucket-level access on GCS — clients never get the SA.
 *
 * Endpoints:
 *   GET /:numero          — legacy single-doc view (integer id)
 *   GET /:numero/full     — NEW: unified dashboard, all detail tables
 *                           in one round-trip (Track B Sprint 1)
 *   GET /:numero/docs/:id — PDF proxy / GCS signed URL
 */
import { Router, type Request, type Response } from 'express';
import { Storage } from '@google-cloud/storage';
import { getUserIdFromRequest } from '../services/auth.js';
import { getExpedienteById } from '../services/silClient.js';
import { withTimeout } from '../services/resilience.js';
import { createClient } from '@supabase/supabase-js';

export const expedientesRouter = Router();

const GCS_BUCKET_SIL = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';
const SIGNED_URL_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for the user to click
const STREAM_TIMEOUT_MS = 30_000;

let _storage: Storage | null = null;
function storage(): Storage {
  if (_storage) return _storage;
  _storage = new Storage();
  return _storage;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

function getSupabase() {
  // El repo usa NEXT_PUBLIC_SUPABASE_URL (Vite + Next prefix) en .env.local y
  // en Cloud Run. SUPABASE_URL no existe — fix 2026-05-15 después de smoke
  // del Sprint v3 con Playwright (devolvía http 500 al frontend).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}

/**
 * GET /api/expedientes/:numero/full
 *
 * Unified dashboard endpoint — all detail tables in one round-trip.
 * Used by ExpedienteDashboardPage (Track B, Sprint 1).
 *
 * The `:numero` param accepts both the integer id (e.g. "23511") and the
 * dot-formatted numero (e.g. "23.511") — we look up sil_expedientes by
 * the `numero` text field to normalise.
 *
 * Returns an empty array (not 404) for tables that have no rows yet —
 * the frontend shows empty states until the scraper backfill runs.
 */
expedientesRouter.get('/:numero/full', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  // Accept "23511" (integer form from old links) or "23.511" (SIL canonical).
  const rawNumero = req.params.numero;
  // Normalise: if no dot and pure digits, convert "23511" → "23.511" style.
  // The DB stores the dot-formatted numero as the FK. The integer `id` field
  // is a separate column. We query by `numero` (text) for new tables and by
  // `id` (int) for the old sil_expedientes table.
  const isInt = /^\d+$/.test(rawNumero);
  const supClientRaw = getSupabase();

  try {
    // Resolve the expediente: accept both id (int) and numero (text).
    const generalQuery = isInt
      ? supClientRaw.from('sil_expedientes').select('*').eq('id', Number(rawNumero)).single()
      : supClientRaw.from('sil_expedientes').select('*').eq('numero', rawNumero).single();

    const { data: general, error: generalErr } = await generalQuery;

    if (generalErr || !general) {
      res.status(404).json({ ok: false, error: 'expediente_not_found', numero: rawNumero });
      return;
    }

    const numero: string = general.numero as string; // canonical "23.511" form

    // Fetch all detail tables in parallel — empty array if no rows.
    //
    // Sprint 2 Track H: además de las 5 tablas core (tramite, proponentes,
    // consultas, ley, documentos), intentamos leer de las tablas DEDICADAS
    // del Sprint v3 (migrations 0037 + 0038). Si la migration aún no se
    // aplicó en este ambiente, el `.from(...)` devuelve error `relation does
    // not exist` — lo capturamos y dejamos los datos vacíos. El fallback al
    // `metadata` jsonb pasa más abajo si las tablas estaban vacías Y el
    // expediente tiene metadata seedeada (data demo).
    const safeQuery = async <T>(p: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> => {
      try {
        const r = await p;
        if (r.error) return [];
        return r.data ?? [];
      } catch { return []; }
    };

    const [
      tramiteRes, proponentesRes, consultasRes, leyRes, documentosRes,
      // Sprint v3 — tablas dedicadas (0037 + 0038)
      fechasRes, audienciasRes, actasRes, salaRes, ordenDiaRes,
      // Sprint 3 Track R — Lista de despacho
      despachoRes,
    ] = await Promise.all([
      supClientRaw
        .from('sil_expediente_tramite')
        .select('*')
        .eq('expediente_id', numero)
        .order('orden', { ascending: true, nullsFirst: false })
        .order('fecha_inicio', { ascending: true }),

      supClientRaw
        .from('sil_expediente_proponentes')
        .select('*')
        .eq('expediente_id', numero)
        .order('firma_orden', { ascending: true }),

      supClientRaw
        .from('sil_expediente_consultas')
        .select('*')
        .eq('expediente_id', numero),

      supClientRaw
        .from('sil_leyes')
        .select('*, sil_leyes_afectaciones(*)')
        .eq('expediente_origen_id', numero)
        .maybeSingle(),

      supClientRaw
        .from('sil_expediente_documentos')
        .select('*')
        .eq('expediente_id', numero)
        .order('tipo', { ascending: true }),

      // ── Sprint v3 dedicated tables (graceful degradation si 0037+0038 no aplicadas) ──
      safeQuery(supClientRaw
        .from('sil_expediente_fechas_vigentes')  // VIEW de 0037
        .select('*')
        .eq('expediente_id', numero)),

      safeQuery(supClientRaw
        .from('sil_expediente_audiencias')
        .select('*')
        .eq('expediente_id', numero)
        .order('fecha', { ascending: true })),

      safeQuery(supClientRaw
        .from('sil_expediente_actas_indexadas')
        .select('*')
        .eq('expediente_id', numero)
        .order('fecha_sesion', { ascending: false })),

      safeQuery(supClientRaw
        .from('sil_expediente_consultas_sala')
        .select('*')
        .eq('expediente_id', numero)
        .order('fecha_resolucion', { ascending: false })),

      safeQuery(supClientRaw
        .from('sil_expediente_orden_dia_apariciones')
        .select('*')
        .eq('expediente_id', numero)
        .order('fecha_sesion', { ascending: false })),

      // Sprint 3 Track R — historial de la lista de despacho. Graceful
      // degradation si 0043 no se aplicó todavía (safeQuery devuelve []).
      safeQuery(supClientRaw
        .from('lista_despacho_items')
        .select('id, expediente_id, fecha_entrada, fecha_salida, status, fuente_pdf_url, comentario_diputado, detectado_at')
        .eq('expediente_id', numero)
        .order('fecha_entrada', { ascending: false })),
    ]);

    // Pedido 16j ("algoritmo Carlos") — fuente principal: `centinela_eventos`
    // poblada por el cron Sprint 2 Track I (`runNoveltyScan`). La tabla
    // tiene una fila por (user_id, dedup_key) — sólo levantamos las del
    // user actual que cubren este expediente.
    //
    // Fallback: si la tabla no tiene rows para este expediente+user (porque
    // el cron aún no corrió, o porque es un expediente nuevo que recién
    // entró a watchlist), llamamos detectNovedades(numero) live como hoy.
    // Esto preserva el contrato del endpoint mientras el cron alcanza el
    // estado estable.
    //
    // Shape de salida (novedades_detectadas[]) se mantiene idéntico para
    // backward-compat con la UI; sólo cambia la fuente.
    const NOVELTY_TIPOS = [
      'mocion_137_no_reflejada_en_tramite',
      'consulta_177_no_reflejada_en_tramite',
      'acta_sin_evento_tramite',
      'mocion_segundo_dia_sin_primer_dia',
    ] as const;

    let novedadesDetectadas: unknown[] = [];
    let novedadesSource: 'centinela_eventos' | 'detector_live' | 'none' = 'none';

    try {
      const { data: persistedRows } = await supClientRaw
        .from('centinela_eventos')
        .select('event_type, payload, priority, detected_at, source_url')
        .eq('expediente_id', numero)
        .eq('user_id', userId)
        .in('event_type', NOVELTY_TIPOS as unknown as string[])
        .order('detected_at', { ascending: false });

      if (persistedRows && persistedRows.length > 0) {
        // Reconstituir el shape NovedadDetectada desde la fila persistida.
        // El payload jsonb tiene descripcion/algoritmo/confidence/fuentes/
        // fecha_deteccion — la UI espera todos esos campos top-level.
        novedadesDetectadas = persistedRows.map((row: any) => {
          const p = (row.payload ?? {}) as Record<string, unknown>;
          return {
            tipo: row.event_type,
            expediente_numero: numero,
            descripcion: p.descripcion,
            algoritmo: p.algoritmo,
            confidence: p.confidence,
            fecha_deteccion: p.fecha_deteccion ?? row.detected_at,
            fuentes: p.fuentes,
          };
        });
        novedadesSource = 'centinela_eventos';
      } else {
        // Fallback: detector live (mismo flujo de Sprint v3).
        const { detectNovedades } = await import('../services/noveltyDetector.js');
        const detected = await detectNovedades(numero);
        novedadesDetectadas = detected;
        novedadesSource = detected.length > 0 ? 'detector_live' : 'none';
      }
    } catch (err) {
      req.log?.warn('novelty_detector_failed', {
        error: (err as Error).message,
        numero,
        user_id: userId,
      });
    }

    // ── Sprint 2 Track H — Merge tablas dedicadas + fallback metadata jsonb ──
    //
    // Política: si la tabla dedicada tiene datos para este expediente, esos
    // mandan. Si está vacía Y el expediente tiene metadata.<key> seedeada,
    // ese es el fallback (data demo / pre-migration). Cuando el script
    // migrate-metadata-to-dedicated.ts corra una vez, las tablas dedicadas
    // quedan con todos los datos y el fallback puede borrarse.
    const meta = (general?.metadata ?? {}) as Record<string, any>;

    // Helper para vista de fechas extraídas — la VIEW devuelve filas planas;
    // el frontend espera shape { vigente: {...}, historial: [...], otras_fechas: {...} }.
    // Si la tabla 0037 está vacía, usamos `metadata.fechas_extraidas` tal cual.
    const fechasExtraidas = fechasRes.length > 0
      ? (() => {
          const byCampo = Object.fromEntries(fechasRes.map((f: any) => [f.campo, f]));
          // Pedido 07 — preferencia explícita por la fecha estimada de dictamen
          // cuando está extraída del documento (negrita/regex/llm). Fallback en
          // orden: vencimiento ordinario (deadline procesal de 60 días, el
          // mismo número que la fecha estimada en la mayoría de los casos),
          // luego cuatrienal (deadline máximo del cuatrienio).
          // Mientras el extractor de texto-de-documento no esté listo, este
          // fallback evita que TODOS los expedientes muestren "sin fechas"
          // — al menos los enriquecidos ven el vencimiento del SIL oficial.
          const vigenteRow =
            byCampo['fecha_dictamen_estimada']
            ?? byCampo['vence_subcomision']
            ?? byCampo['fecha_cuatrienal']
            ?? null;
          return {
            vigente: vigenteRow ? {
              campo: vigenteRow.campo,
              valor_fecha: vigenteRow.valor_fecha,
              valor_texto_original: vigenteRow.valor_texto_original,
              visual_marker: vigenteRow.visual_marker,
              fuente_documento_url: vigenteRow.fuente_documento_url,
              fuente_pagina: vigenteRow.fuente_pagina,
              extraction_method: vigenteRow.extraction_method,
              extraction_confidence: vigenteRow.extraction_confidence,
            } : undefined,
            historial: [], // historial detallado: 0037 lo soporta pero requiere query separada
            otras_fechas: {
              fecha_cuatrienal: byCampo['fecha_cuatrienal']?.valor_fecha,
              vence_subcomision: byCampo['vence_subcomision']?.valor_fecha,
            },
          };
        })()
      : (meta.fechas_extraidas ?? null);

    const audiencias = audienciasRes.length > 0
      ? audienciasRes
      : (meta.audiencias ?? []);

    const actasComision = actasRes.length > 0
      ? actasRes
      : (meta.actas_comision ?? []);

    const consultasSalaConst = salaRes.length > 0
      ? salaRes.map((r: any) => ({
          numero_resolucion: r.numero_resolucion,
          fecha_resolucion: r.fecha_resolucion,
          fecha_consulta: r.fecha_consulta,
          decision: r.decision,
          por_tanto_extracto: r.por_tanto_extracto,
          magistrados: r.magistrados,
          voto_completo_url: r.voto_completo_url,
        }))
      : (meta.consultas_sala_constitucional ?? []);

    const ordenDiaApariciones = ordenDiaRes.length > 0
      ? ordenDiaRes
      : (meta.orden_dia_apariciones ?? []);

    // Novedades: orden de prioridad
    //   1. centinela_eventos persistidos por el cron noveltyScan (Track I).
    //   2. detector live como fallback de compatibilidad (cron aún no corrió).
    //   3. metadata.novedades_detectadas seedeada (demo data).
    const novedadesFinales = novedadesDetectadas.length > 0
      ? novedadesDetectadas
      : (meta.novedades_detectadas ?? []);

    res.json({
      ok: true,
      expediente: {
        general, // metadata sigue presente en general para backward-compat
        tramite: tramiteRes.data ?? [],
        proponentes: proponentesRes.data ?? [],
        consultas: consultasRes.data ?? [],
        ley: leyRes.data ?? null,
        documentos: documentosRes.data ?? [],
        // Sprint v3 — keys top-level, fuente: tablas dedicadas con fallback metadata
        fechas_extraidas: fechasExtraidas,
        audiencias,
        actas_comision: actasComision,
        consultas_sala_constitucional: consultasSalaConst,
        orden_dia_apariciones: ordenDiaApariciones,
        novedades_detectadas: novedadesFinales,
        // Sprint 3 Track R — historial completo de lista de despacho
        despacho_historial: despachoRes,
        // Diagnóstico de fuente — útil en dev/admin para saber qué se sirvió
        _source: {
          fechas: fechasRes.length > 0 ? 'tabla_dedicada' : 'metadata_jsonb',
          audiencias: audienciasRes.length > 0 ? 'tabla_dedicada' : 'metadata_jsonb',
          actas: actasRes.length > 0 ? 'tabla_dedicada' : 'metadata_jsonb',
          sala: salaRes.length > 0 ? 'tabla_dedicada' : 'metadata_jsonb',
          orden_dia: ordenDiaRes.length > 0 ? 'tabla_dedicada' : 'metadata_jsonb',
          novedades: novedadesDetectadas.length > 0 ? novedadesSource : 'metadata_jsonb',
          despacho: despachoRes.length > 0 ? 'tabla_dedicada' : 'sin_datos',
        },
      },
    });
  } catch (err) {
    req.log.error('expediente_full_failed', { error: (err as Error).message, numero: rawNumero });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/expedientes/:numero/despacho — Sprint 3 Track R.
 *
 * Devuelve el historial completo de la lista de despacho para este expediente.
 * Cada item representa una entrada/salida (UNIQUE por expediente + fecha_entrada).
 *
 * Ordenado por fecha_entrada desc — más reciente primero. El primer item con
 * status='a_despacho' y fecha_salida=null es el "activo" actual.
 *
 * Devuelve `[]` si el expediente nunca entró a la lista (no es 404 — es estado
 * normal y la UI necesita poder mostrarlo).
 */
expedientesRouter.get('/:numero/despacho', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const rawNumero = req.params.numero;
  const isInt = /^\d+$/.test(rawNumero);
  const sb = getSupabase();

  try {
    // Resolver el canonical numero (acepta tanto "23511" como "23.511").
    const expQuery = isInt
      ? sb.from('sil_expedientes').select('numero').eq('id', Number(rawNumero)).maybeSingle()
      : sb.from('sil_expedientes').select('numero').eq('numero', rawNumero).maybeSingle();

    const { data: expRow, error: expErr } = await expQuery;
    if (expErr || !expRow) {
      res.status(404).json({ ok: false, error: 'expediente_not_found', numero: rawNumero });
      return;
    }
    const numero = (expRow as { numero: string }).numero;

    const { data, error } = await sb
      .from('lista_despacho_items')
      .select(
        'id, expediente_id, fecha_entrada, fecha_salida, status, fuente_pdf_url, comentario_diputado, detectado_at',
      )
      .eq('expediente_id', numero)
      .order('fecha_entrada', { ascending: false });

    if (error) {
      req.log.warn('expediente_despacho_query_failed', {
        error: error.message,
        numero,
      });
      // Si la migration 0043 aún no se aplicó (tabla no existe), devolver []
      // en lugar de 500 — mismo pattern que /full con safeQuery.
      res.json({ ok: true, historial: [] });
      return;
    }

    res.json({ ok: true, historial: data ?? [] });
  } catch (err) {
    req.log.error('expediente_despacho_failed', {
      error: (err as Error).message,
      numero: rawNumero,
    });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/expedientes/:numero/editorial — Sprint 3 Track P.
 *
 * Devuelve el resumen mixto + categorías CL2 para mostrar en el dashboard
 * del expediente. Lee de la VIEW `cl2_expediente_editorial` que ya joinea
 * cl2_resumenes con cl2_expediente_categorias.
 *
 * 404 cuando el expediente no tiene resumen aún. El frontend muestra un
 * empty state "Resumen pendiente — corré el job admin".
 */
expedientesRouter.get('/:numero/editorial', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const rawNumero = req.params.numero;
  // Acepta tanto "23511" (int) como "23.511" (canonical dot form).
  const isInt = /^\d+$/.test(rawNumero);
  const sb = getSupabase();

  try {
    // Resolver el canonical numero primero (acepta ambos formatos).
    const expQuery = isInt
      ? sb.from('sil_expedientes').select('numero').eq('id', Number(rawNumero)).maybeSingle()
      : sb.from('sil_expedientes').select('numero').eq('numero', rawNumero).maybeSingle();
    const { data: expRow } = await expQuery;
    if (!expRow) {
      res.status(404).json({ ok: false, error: 'expediente_not_found', numero: rawNumero });
      return;
    }
    const numero = (expRow as { numero: string }).numero;

    const { data: editorial, error } = await sb
      .from('cl2_expediente_editorial')
      .select('*')
      .eq('expediente_id', numero)
      .maybeSingle();

    if (error) {
      req.log?.error('editorial_view_failed', { error: error.message, numero });
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    if (!editorial) {
      res.status(404).json({
        ok: false,
        error: 'editorial_not_ready',
        numero,
        hint: 'No hay resumen ni categorías generadas todavía para este expediente.',
      });
      return;
    }

    res.json({ ok: true, editorial });
  } catch (err) {
    req.log?.error('editorial_endpoint_threw', {
      error: (err as Error).message,
      numero: rawNumero,
    });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * GET /api/expedientes/:numero
 * Returns the expediente row + docs list. Each doc carries a relative
 * `view_url` that the client can fetch (also gated by JWT).
 */
expedientesRouter.get('/:numero', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const numero = Number(req.params.numero);
  if (!Number.isInteger(numero) || numero <= 0) {
    res.status(400).json({ ok: false, error: 'bad_numero' });
    return;
  }

  try {
    const exp = await getExpedienteById(numero);
    if (!exp) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({
      ok: true,
      expediente: {
        ...exp,
        // Augment each document with the canonical "view this PDF" URL
        // pointing back to our BFF, not to asamblea.go.cr.
        documentos: exp.documentos.map((d) => ({
          ...d,
          view_url: `/api/expedientes/${numero}/docs/${d.id}`,
        })),
      },
    });
  } catch (err) {
    req.log.error('expediente_detail_failed', { error: (err as Error).message, numero });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/expedientes/:numero/docs/:docId
 * Streams the PDF (or HTML) we mirrored to GCS during process-sil-docs.
 * Falls back to a 302 redirect to the original asamblea.go.cr URL when
 * the doc isn't yet mirrored (gcs_path empty) — keeps the link useful
 * even before the embeddings backfill catches up to that expediente.
 */
expedientesRouter.get('/:numero/docs/:docId', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const numero = Number(req.params.numero);
  const docId = String(req.params.docId);
  if (!Number.isInteger(numero) || numero <= 0 || !docId) {
    res.status(400).json({ ok: false, error: 'bad_params' });
    return;
  }

  try {
    const exp = await getExpedienteById(numero);
    if (!exp) {
      res.status(404).json({ ok: false, error: 'expediente_not_found' });
      return;
    }
    // We re-fetch the doc row from the joined result (avoids a second
    // round-trip to Supabase). silClient.getExpedienteById already pulls
    // sil_documentos for this expediente.
    const doc = exp.documentos.find((d) => d.id === docId);
    if (!doc) {
      res.status(404).json({ ok: false, error: 'doc_not_found' });
      return;
    }

    // The client may pass `?json=1` to ask for the resolved URL as JSON
    // instead of a 302. We need this because <a href> navigations don't
    // carry the Bearer token — the auth-gated browser nav would 401. The
    // SPA fetches `?json=1` with the JWT, gets the (self-authenticating)
    // signed URL, and opens it in a new tab. Plain 302 mode is preserved
    // for any server-to-server caller / future direct embed scenarios.
    const wantsJson = req.query.json === '1';

    // The doc row has a gcs_path field once process-sil-docs has run for it.
    // Until then, fall back to the asamblea.go.cr source — better than a 404.
    const gcsPath = (doc as unknown as { gcs_path?: string | null }).gcs_path ?? null;
    if (!gcsPath) {
      if (wantsJson) {
        res.json({ ok: true, url: doc.source_url, mirrored: false });
        return;
      }
      res.redirect(302, doc.source_url);
      return;
    }

    // gs://bucket/path → bucket + path
    const m = gcsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) {
      req.log.warn('expediente_doc_bad_gcs_path', { docId, gcsPath });
      if (wantsJson) {
        res.json({ ok: true, url: doc.source_url, mirrored: false });
        return;
      }
      res.redirect(302, doc.source_url);
      return;
    }
    const [, bucketName, objectPath] = m;
    const file = storage().bucket(bucketName).file(objectPath);

    // Sign a short-lived URL. With ?json=1 we return it as JSON so the SPA
    // can window.open() it; otherwise we 302 (legacy embed path). Keeps
    // the BFF off the data path (no Express stream chunking through our
    // process), gives Google's CDN a chance to cache, and the URL expires
    // after SIGNED_URL_TTL_MS so sharing it accidentally has bounded impact.
    const [signedUrl] = await withTimeout(
      () =>
        file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + SIGNED_URL_TTL_MS,
        }),
      { ms: STREAM_TIMEOUT_MS, label: 'gcs:signed_url' },
    );
    if (wantsJson) {
      res.json({ ok: true, url: signedUrl, mirrored: true });
      return;
    }
    res.redirect(302, signedUrl);
  } catch (err) {
    req.log.error('expediente_doc_failed', { error: (err as Error).message, numero, docId });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
