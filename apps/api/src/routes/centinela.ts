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
import { getUserFromRequest, getUserIdFromRequest, type AuthedUser } from '../services/auth.js';
import { logger } from '../services/logger.js';

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
centinelaUserRouter.get('/watchlist', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const { data, error } = await supa()
      .from('centinela_watchlist')
      .select('id, entity_type, entity_id, label, notes, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── POST /api/centinela/watchlist ──────────────────────────────────────────
//
// Body: { entity_type, entity_id, label?, notes? }
// Conflict on (user_id, entity_type, entity_id) returns 200 with existing row
// rather than 409 — the UX of "add to watchlist" should be idempotent from
// the user's perspective.
centinelaUserRouter.post('/watchlist', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { entity_type, entity_id, label, notes } = (req.body ?? {}) as {
    entity_type?: string; entity_id?: string; label?: string; notes?: string;
  };
  if (!entity_type || !entity_id) {
    res.status(400).json({ ok: false, error: 'entity_type and entity_id required' });
    return;
  }
  if (!['expediente', 'diputado', 'tema'].includes(entity_type)) {
    res.status(400).json({ ok: false, error: 'invalid entity_type', hint: 'expediente|diputado|tema' });
    return;
  }
  try {
    const { data, error } = await supa()
      .from('centinela_watchlist')
      .upsert(
        { user_id: userId, entity_type, entity_id, label: label ?? null, notes: notes ?? null },
        { onConflict: 'user_id,entity_type,entity_id', ignoreDuplicates: false },
      )
      .select('id, entity_type, entity_id, label, notes, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, item: data });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
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
