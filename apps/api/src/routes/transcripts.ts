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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/transcripts/sessions
//
// List sessions with pipeline state. Efficient aggregation via Supabase RPC
// equivalent — two parallel queries (sessions metadata + aggregated counts),
// then joined in-process to avoid N+1.
//
// Query params:
//   status  — comma-separated, e.g. "indexed,processing"
//   source  — "youtube" | "legacy"
//   limit   — default 50, max 200
//   offset  — default 0
// ─────────────────────────────────────────────────────────────────────────────
transcriptsAdminRouter.get('/sessions', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const offset = Number(req.query.offset ?? 0) || 0;
  const statusFilter =
    typeof req.query.status === 'string' && req.query.status.trim().length > 0
      ? req.query.status.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
  const sourceFilter =
    typeof req.query.source === 'string' && req.query.source.trim().length > 0
      ? req.query.source.trim()
      : null;

  try {
    const s = supa();

    // Build main query — grab session rows
    let q = s
      .from('sessions')
      .select(
        'id, titulo, youtube_video_id, status, source, fecha, comision, tipo, llm_reviewed_at, llm_review_model, metadata',
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter) {
      q = q.in('status', statusFilter);
    }
    if (sourceFilter) {
      q = q.eq('source', sourceFilter);
    }

    const { data: sessionRows, count, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (sessionRows ?? []) as Array<{
      id: string;
      titulo: string | null;
      youtube_video_id: string | null;
      status: string;
      source: string | null;
      fecha: string | null;
      comision: string | null;
      tipo: string | null;
      llm_reviewed_at: string | null;
      llm_review_model: string | null;
      metadata: Record<string, unknown> | null;
    }>;

    if (rows.length === 0) {
      res.json({ ok: true, sessions: [], total: count ?? 0 });
      return;
    }

    // Aggregate segments and corrections counts in two parallel queries
    const sessionIds = rows.map((r) => r.id);

    const [segCountRes, corrCountRes] = await Promise.all([
      // Segments count per session
      s
        .from('transcript_segments')
        .select('session_id')
        .in('session_id', sessionIds),
      // Corrections count per session, grouped by human_review status
      s
        .from('transcript_corrections')
        .select('session_id, human_review')
        .in('session_id', sessionIds),
    ]);

    // Build lookup maps from the flat arrays
    const segsBySession: Record<string, number> = {};
    for (const row of (segCountRes.data ?? []) as Array<{ session_id: string }>) {
      segsBySession[row.session_id] = (segsBySession[row.session_id] ?? 0) + 1;
    }

    const corrsBySession: Record<string, { total: number; pending: number }> = {};
    for (const row of (corrCountRes.data ?? []) as Array<{
      session_id: string;
      human_review: string | null;
    }>) {
      const entry = corrsBySession[row.session_id] ?? { total: 0, pending: 0 };
      entry.total += 1;
      if (row.human_review === 'pending') entry.pending += 1;
      corrsBySession[row.session_id] = entry;
    }

    const sessions = rows.map((r) => ({
      id: r.id,
      title: r.titulo ?? r.youtube_video_id ?? r.id,
      youtube_video_id: r.youtube_video_id,
      source: r.source ?? 'unknown',
      status: r.status,
      fecha: r.fecha,
      comision: r.comision,
      tipo: r.tipo,
      llm_reviewed_at: r.llm_reviewed_at,
      llm_review_model: r.llm_review_model,
      segments_count: segsBySession[r.id] ?? 0,
      corrections_count: corrsBySession[r.id]?.total ?? 0,
      corrections_pending: corrsBySession[r.id]?.pending ?? 0,
    }));

    res.json({ ok: true, sessions, total: count ?? 0 });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('admin_transcripts_sessions_failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/transcripts/sessions/:id
//
// Drill-down for one session: metadata + segments (capped at 200) + corrections
// grouped by human_review status.
// ─────────────────────────────────────────────────────────────────────────────
transcriptsAdminRouter.get('/sessions/:id', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const sessionId = req.params.id as string;

  try {
    const s = supa();

    const [sessionRes, segmentsRes, correctionsRes] = await Promise.all([
      s
        .from('sessions')
        .select(
          'id, titulo, youtube_video_id, status, source, fecha, comision, tipo, llm_reviewed_at, llm_review_model, metadata',
        )
        .eq('id', sessionId)
        .maybeSingle(),
      s
        .from('transcript_segments')
        .select('id, session_id, segment_idx, start_seconds, end_seconds, text, source')
        .eq('session_id', sessionId)
        .order('segment_idx', { ascending: true })
        .limit(200),
      s
        .from('transcript_corrections')
        .select(
          'id, session_id, segment_id, kind, span_start, span_end, original_text, suggested_text, confidence, reasoning, human_review, reviewed_by, reviewed_at, model, llm_run_id',
        )
        .eq('session_id', sessionId)
        .order('segment_id', { ascending: true }),
    ]);

    if (sessionRes.error) throw new Error(sessionRes.error.message);
    if (!sessionRes.data) {
      res.status(404).json({ ok: false, error: 'session_not_found' });
      return;
    }

    if (segmentsRes.error) throw new Error(segmentsRes.error.message);
    if (correctionsRes.error) throw new Error(correctionsRes.error.message);

    const session = sessionRes.data as {
      id: string;
      titulo: string | null;
      youtube_video_id: string | null;
      status: string;
      source: string | null;
      fecha: string | null;
      comision: string | null;
      tipo: string | null;
      llm_reviewed_at: string | null;
      llm_review_model: string | null;
      metadata: Record<string, unknown> | null;
    };

    type CorrRow = {
      id: string;
      session_id: string;
      segment_id: string | null;
      kind: string;
      span_start: number | null;
      span_end: number | null;
      original_text: string;
      suggested_text: string;
      confidence: number;
      reasoning: string | null;
      human_review: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
      model: string | null;
      llm_run_id: string | null;
    };

    const allCorrections = (correctionsRes.data ?? []) as CorrRow[];
    const corrections = {
      pending: allCorrections.filter((c) => c.human_review === 'pending'),
      accepted: allCorrections.filter((c) => c.human_review === 'accepted'),
      rejected: allCorrections.filter((c) => c.human_review === 'rejected'),
    };

    res.json({
      ok: true,
      session: {
        id: session.id,
        title: session.titulo ?? session.youtube_video_id ?? session.id,
        youtube_video_id: session.youtube_video_id,
        source: session.source ?? 'unknown',
        status: session.status,
        fecha: session.fecha,
        comision: session.comision,
        tipo: session.tipo,
        llm_reviewed_at: session.llm_reviewed_at,
        llm_review_model: session.llm_review_model,
        metadata: session.metadata,
      },
      segments: segmentsRes.data ?? [],
      corrections,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('admin_transcripts_session_detail_failed', { sessionId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/transcripts/corrections/:id
//
// Accept or reject a single correction. Updates human_review, reviewed_by,
// reviewed_at.
//
// Body: { action: 'accept' | 'reject' }
// Returns: { ok: true, correction: <updated row> }
// ─────────────────────────────────────────────────────────────────────────────
transcriptsAdminRouter.patch('/corrections/:id', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  const correctionId = req.params.id as string;
  const action = req.body?.action as string | undefined;
  if (action !== 'accept' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action must be accept|reject' });
    return;
  }

  try {
    const s = supa();
    const humanReview = action === 'accept' ? 'accepted' : 'rejected';

    const { data, error } = await s
      .from('transcript_corrections')
      .update({
        human_review: humanReview,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', correctionId)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ ok: false, error: 'correction_not_found' });
      return;
    }

    res.json({ ok: true, correction: data });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    req.log?.error('admin_transcripts_patch_correction_failed', { correctionId, error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// ── Reset supabase client for tests ───────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}
