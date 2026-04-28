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
import { syncCentinelaWatchlist } from '../jobs/centinelaSilSync.js';
import { scrapeAgenda } from '../jobs/agendaScrape.js';
import { detectSimilarExpedientes } from '../jobs/centinelaSimilarDetect.js';
import { getUserFromRequest, type AuthedUser } from '../services/auth.js';
import { logger } from '../services/logger.js';

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
