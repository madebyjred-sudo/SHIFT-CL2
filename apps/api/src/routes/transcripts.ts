/**
 * Transcript pipeline endpoints — Fase 0, Task 6.
 *
 * TWO routers are exported from this file:
 *
 *   transcriptsAdminRouter  → mounted at /api/admin/transcripts
 *     POST /sync — manual trigger from the admin UI. Auth: logged-in user.
 *
 *   internalTriggersRouter  → mounted at /api/internal
 *     POST /youtube-sync — called by Cloud Scheduler. Auth: X-Internal-Trigger header.
 *
 * Auth model note:
 *   The internal endpoint uses a shared-secret header (X-Internal-Trigger) rather
 *   than OIDC token validation for MVP. Cloud Scheduler is configured to send the
 *   secret via --headers. Production-grade hardening: swap for OIDC token
 *   verification against the GCP service-account email (gcp-metadata + tokeninfo).
 *
 * Concurrency:
 *   processSession is called sequentially (no Promise.all fan-out). At 3-5 new
 *   sessions per cron run, sequential is fine and avoids OpenRouter burst issues.
 *   Upgrade path: replace the for-loop with a p-limit(3) fan-out when volume grows.
 */

import { Router } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { syncYoutubeChannel } from '../jobs/youtubeSync.js';
import { processSession } from '../jobs/transcriptProcess.js';
import type { TranscriptProcessResult } from '../jobs/transcriptProcess.js';
import { getUserFromRequest } from '../services/auth.js';
import { logger } from '../services/logger.js';

// ── Supabase (lazy, service role) ─────────────────────────────────────────────
// Used only for the force=true status reset and videoId→sessionId lookup.
let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for transcripts router');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── /api/internal router ──────────────────────────────────────────────────────

export const internalTriggersRouter = Router();

/**
 * POST /api/internal/youtube-sync
 *
 * Triggered by Cloud Scheduler (every 6h). Validates X-Internal-Trigger header,
 * runs the full sync+process pipeline, and returns a JSON summary.
 *
 * Cloud Scheduler config (reference — deploy concern, not code):
 *   --headers "X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET"
 */
internalTriggersRouter.post('/youtube-sync', async (req, res) => {
  // ── Auth: shared-secret header ─────────────────────────────────────────────
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!secret) {
    // Misconfigured server — fail closed
    req.log?.error('internal_trigger_secret_not_set');
    res.status(503).json({ ok: false, error: 'server_misconfigured' });
    return;
  }

  const incoming = req.headers['x-internal-trigger'];
  if (!incoming || incoming !== secret) {
    req.log?.warn('internal_trigger_unauthorized', {
      has_header: !!incoming,
      ip: req.ip,
    });
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  // ── Sync ───────────────────────────────────────────────────────────────────
  let syncResult;
  try {
    syncResult = await syncYoutubeChannel({ daysBack: 7 });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('internal_youtube_sync_failed', { error: message });
    res.status(502).json({ ok: false, error: 'sync_failed', detail: message });
    return;
  }

  // ── Process each new session ───────────────────────────────────────────────
  const newSessionIds = syncResult.videoIds.new;
  const processed: TranscriptProcessResult[] = [];

  for (const videoId of newSessionIds) {
    // Resolve the session UUID from the youtube_video_id we just inserted.
    // syncYoutubeChannel returns video IDs, not session UUIDs, so we need
    // a quick lookup. The INSERT just happened so the row is guaranteed present.
    let sessionId: string | null = null;
    try {
      const { data, error } = await supa()
        .from('sessions')
        .select('id')
        .eq('youtube_video_id', videoId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? 'session lookup returned null');
      }
      sessionId = (data as { id: string }).id;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      req.log?.error('internal_session_lookup_failed', { videoId, error: message });
      // Continue with remaining videos
      continue;
    }

    try {
      const result = await processSession(sessionId);
      processed.push(result);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      req.log?.error('internal_process_session_failed', {
        sessionId,
        videoId,
        error: message,
      });
      // One bad session must not kill the batch — log + continue
      processed.push({
        session_id: sessionId,
        status: 'permanent_failure',
        segments_inserted: 0,
        corrections_inserted: 0,
        llm_run_id: null,
        duration_ms: 0,
        error: message,
      });
    }
  }

  logger.info('internal_youtube_sync_complete', {
    sync_new: syncResult.new,
    sync_skipped: syncResult.skipped,
    processed: processed.length,
    failures: processed.filter((p) => p.status === 'permanent_failure').length,
  });

  res.json({ ok: true, sync: syncResult, processed });
});

// ── /api/admin/transcripts router ─────────────────────────────────────────────

export const transcriptsAdminRouter = Router();

/**
 * POST /api/admin/transcripts/sync
 *
 * Manual admin trigger. Auth: any logged-in user (matches admin.ts convention).
 *
 * Body:
 *   daysBack?      number   default 7
 *   videoIds?      string[] if set, skip channel listing and process only these videos
 *   force?         boolean  if true, reset status='pending' before processSession
 *   skipLlmReview? boolean  pass through to processSession
 *   dryRun?        boolean  run syncYoutubeChannel with dryRun:true, skip processSession
 */
transcriptsAdminRouter.post('/sync', async (req, res) => {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  // ── Parse + validate body ──────────────────────────────────────────────────
  const daysBack: number = typeof req.body?.daysBack === 'number' ? req.body.daysBack : 7;
  const videoIds: string[] | undefined = Array.isArray(req.body?.videoIds)
    ? (req.body.videoIds as string[])
    : undefined;
  const force: boolean = req.body?.force === true;
  const skipLlmReview: boolean = req.body?.skipLlmReview === true;
  const dryRun: boolean = req.body?.dryRun === true;

  logger.info('admin_transcripts_sync_start', {
    actor: user.email,
    daysBack,
    videoIds,
    force,
    skipLlmReview,
    dryRun,
  });

  // ── Collect session IDs to process ────────────────────────────────────────
  // Two paths: explicit videoIds vs channel sync
  let syncResult = null;
  let sessionIds: string[] = [];
  const errors: Array<{ videoId: string; error: string }> = [];

  if (videoIds && videoIds.length > 0) {
    // Path A: explicit video IDs — look up their session UUIDs
    for (const videoId of videoIds) {
      try {
        const { data, error } = await supa()
          .from('sessions')
          .select('id')
          .eq('youtube_video_id', videoId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (error || !data) {
          throw new Error(error?.message ?? `no session found for videoId=${videoId}`);
        }
        sessionIds.push((data as { id: string }).id);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        errors.push({ videoId, error: message });
        req.log?.warn('admin_transcripts_sync_lookup_failed', { videoId, error: message });
      }
    }
  } else {
    // Path B: sync channel first, then process new sessions
    try {
      syncResult = await syncYoutubeChannel({ daysBack, dryRun });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      res.status(502).json({ ok: false, error: 'sync_failed', detail: message });
      return;
    }

    if (dryRun) {
      // dryRun: return the diff without processing anything
      res.json({ ok: true, sync: syncResult, processed: [], errors: [] });
      return;
    }

    // Resolve new video IDs to session UUIDs
    for (const videoId of syncResult.videoIds.new) {
      try {
        const { data, error } = await supa()
          .from('sessions')
          .select('id')
          .eq('youtube_video_id', videoId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (error || !data) {
          throw new Error(error?.message ?? 'session lookup returned null');
        }
        sessionIds.push((data as { id: string }).id);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        errors.push({ videoId, error: message });
        req.log?.warn('admin_transcripts_sync_lookup_failed', { videoId, error: message });
      }
    }
  }

  // ── force=true: reset status to 'pending' before processSession ──────────
  // This bypasses the idempotency guard in processSession (status === 'indexed'
  // early-return). Existing corrections will remain; the LLM run will insert
  // new ones with a new llm_run_id. Admin can clean up old runs from the UI.
  //
  // Optional enhancement: also DELETE transcript_corrections WHERE session_id=$1
  // before the reset if duplicate corrections are confusing in the audit UI.
  if (force && sessionIds.length > 0) {
    try {
      const { error } = await supa()
        .from('sessions')
        .update({ status: 'pending' })
        .in('id', sessionIds);

      if (error) throw new Error(error.message);
      req.log?.info('admin_transcripts_force_reset', { count: sessionIds.length });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      res.status(500).json({ ok: false, error: 'force_reset_failed', detail: message });
      return;
    }
  }

  // ── Process each session ───────────────────────────────────────────────────
  const processed: TranscriptProcessResult[] = [];

  for (const sessionId of sessionIds) {
    try {
      const result = await processSession(sessionId, { skipLlmReview });
      processed.push(result);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      req.log?.error('admin_transcripts_process_failed', { sessionId, error: message });
      processed.push({
        session_id: sessionId,
        status: 'permanent_failure',
        segments_inserted: 0,
        corrections_inserted: 0,
        llm_run_id: null,
        duration_ms: 0,
        error: message,
      });
    }
  }

  logger.info('admin_transcripts_sync_complete', {
    actor: user.email,
    sync_new: syncResult?.new ?? sessionIds.length,
    processed: processed.length,
    failures: processed.filter((p) => p.status === 'permanent_failure').length,
    errors: errors.length,
  });

  res.json({ ok: true, sync: syncResult, processed, errors });
});

// ── Reset supabase client for tests ───────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}
