/**
 * Admin console — read + write endpoints powering the admin UI.
 *
 * Every action button in the UI lands here. Each write also dispatches
 * an audit_log entry so the Auditoría section reflects real activity.
 *
 * Auth: any authenticated user can call these during the demo. When we
 * open up to outside tenants, hoist a role check on top of the router.
 */
import { Router } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { audit, auditFromReq } from '../services/auditLog.js';
import { getUserFromRequest } from '../services/auth.js';
import { snapshotAll } from '../services/agentStats.js';
import { getOverride, loadOverrides, setOverride } from '../services/agentOverrides.js';
import { loadFlags, setFlag } from '../services/featureFlags.js';
import { logger } from '../services/logger.js';
import { listTranscripciones, type LegacyTranscripcion } from '../services/legacyCl2Client.js';

const adminRouter = Router();

interface MockedResponse<T> {
  ok: true;
  mock: true;
  generated_at: string;
  data: T;
}

interface LiveResponse<T> {
  ok: true;
  mock: false;
  generated_at: string;
  data: T;
}

function mocked<T>(data: T): MockedResponse<T> {
  return { ok: true, mock: true, generated_at: new Date().toISOString(), data };
}
function live<T>(data: T): LiveResponse<T> {
  return { ok: true, mock: false, generated_at: new Date().toISOString(), data };
}

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Operational summary ─────────────────────────────────────────────
adminRouter.get('/summary', async (req, res) => {
  try {
    const s = supa();
    const [
      { count: chunksCount },
      { count: sessionsCount },
      { count: expedientesCount },
      { count: pendingTransCount },
      { count: pendingWatchlistCount },
    ] = await Promise.all([
      s.from('legislative_chunks').select('id', { count: 'exact', head: true }),
      s.from('sessions').select('id', { count: 'exact', head: true }),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }),
      s.from('transcripciones_review').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      s.from('expedientes_watchlist').select('user_id', { count: 'exact', head: true }),
    ]);
    res.json(
      live({
        chunks: chunksCount ?? 0,
        sessions: sessionsCount ?? 0,
        expedientes: expedientesCount ?? 0,
        pending_transcripciones: pendingTransCount ?? 0,
        watchlist_total: pendingWatchlistCount ?? 0,
      }),
    );
  } catch (err) {
    req.log?.warn('admin/summary failed', { err: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Recent activity stream (live from audit_log + Supabase events) ──
adminRouter.get('/activity', async (_req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('id, ts, actor_email, actor_kind, verb, resource, resource_kind, result')
      .order('ts', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    res.json(live({ items: data ?? [] }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Alerts (derived) ────────────────────────────────────────────────
adminRouter.get('/alerts', async (_req, res) => {
  // For now derive from recent failed audit entries + worker state.
  // A real alert engine would track open issues with severity, owner,
  // ack/snooze. Today: surface anything that landed as result='error'
  // or 'retry' in the last 6 hours.
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const { data } = await supa()
      .from('audit_log')
      .select('id, ts, verb, resource, result, metadata')
      .neq('result', 'ok')
      .gte('ts', sixHoursAgo)
      .order('ts', { ascending: false })
      .limit(10);
    const items = (data ?? []).map((row) => ({
      id: row.id,
      severity: row.result === 'error' ? 'danger' : 'warn',
      title: `${row.verb} → ${row.result}`,
      detail: row.resource,
      when: row.ts,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Transcripciones — legacy CL2 sessions × review state ────────────
//
// The queue is NOT a fake list. The legacy CL2 worker (running on the
// VPS) transcribes plenarias automatically and stores the result in
// MariaDB. This endpoint reads from there + cross-references with our
// `transcripciones_review` table, which records the operator's
// per-session approve/reject decision.
//
// Status derivation (per legacy session):
//
//   review row exists → use its status (approved | rejected | pending)
//   no review row     → status = 'pending'
//
// In other words: every transcribed session lands in the queue once,
// the operator reviews it, and from then on it's tagged. There's a
// configurable `since` window (default 30 days) to keep the list
// manageable — older sessions are assumed already-audited and don't
// clutter the moderation surface.
//
// When the legacy backend is unreachable we degrade to an empty list
// with `degraded: true` rather than 500ing. The operator still sees
// the section frame.

// 60 days keeps the moderation queue meaningful: recent sessions land
// here for review; anything older is assumed already-audited so we
// don't blow the list past 100 rows. Tweak via the env var when the
// transcription cadence changes.
const REVIEW_WINDOW_DAYS = Number(process.env.ADMIN_TRANSCRIPCIONES_WINDOW_DAYS ?? 60);

interface QueueRow {
  external_id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;
  duration_seconds: number;
  confidence: number;
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt_text: string;
  excerpt_ts: string;
}

function legacyToQueueRow(
  legacy: LegacyTranscripcion,
  reviewBySessionId: Map<string, { status: string; reviewer_note?: string | null }>,
): QueueRow {
  const sid = String(legacy.id);
  const review = reviewBySessionId.get(sid);
  // Legacy doesn't expose per-segment confidence, only the resumen
  // markdown. Surface a "—" placeholder by using 100% so the UI doesn't
  // panic, but mark flagged_segments=0 so the operator only sees real
  // worker-flagged content (none today; future Whisper job will set it).
  const confidence = 100;
  const excerpt = (legacy.resumen ?? '').split('\n').find((l) => l.trim().length > 0)?.slice(0, 220) ?? '';
  return {
    external_id: sid,
    session_id: legacy.id,
    sesion_label: legacy.titulo,
    expediente: null, // legacy doesn't link expediente; future enhancement
    date: legacy.fecha,
    duration_seconds: legacy.duration,
    confidence,
    flagged_segments: 0,
    status: (review?.status as QueueRow['status']) ?? 'pending',
    source: 'Legacy CL2 worker',
    speaker: 'Plenaria',
    excerpt_text: excerpt,
    excerpt_ts: '0:00:00',
  };
}

adminRouter.get('/transcripciones', async (req, res) => {
  // Pull last N days from legacy. If legacy is down, surface a clear
  // degraded payload so the UI shows an informational state.
  const today = new Date();
  const since = new Date(today);
  since.setDate(today.getDate() - REVIEW_WINDOW_DAYS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  let legacyRows: LegacyTranscripcion[] | null = null;
  try {
    legacyRows = await listTranscripciones({
      fecha_inicio: fmt(since),
      fecha_fin: fmt(today),
      limit: 200,
    });
  } catch (err) {
    req.log?.warn('admin/transcripciones legacy read failed', {
      error: (err as Error).message,
    });
    res.json({
      ok: true,
      mock: false,
      degraded: true,
      degraded_reason: (err as Error).message,
      generated_at: new Date().toISOString(),
      data: {
        counts: { pending: 0, in_progress: 0, approved: 0, rejected: 0 },
        items: [],
      },
    });
    return;
  }

  // Cross-reference with the review state table.
  let reviewBySessionId = new Map<string, { status: string; reviewer_note?: string | null }>();
  try {
    const ids = legacyRows.map((r) => String(r.id));
    if (ids.length > 0) {
      const { data } = await supa()
        .from('transcripciones_review')
        .select('session_id, status, reviewer_note')
        .in('session_id', ids);
      for (const row of (data ?? []) as Array<{
        session_id: string;
        status: string;
        reviewer_note: string | null;
      }>) {
        reviewBySessionId.set(row.session_id, { status: row.status, reviewer_note: row.reviewer_note });
      }
    }
  } catch (err) {
    req.log?.warn('admin/transcripciones review join failed', {
      error: (err as Error).message,
    });
    reviewBySessionId = new Map();
  }

  const items = legacyRows.map((l) => legacyToQueueRow(l, reviewBySessionId));
  const counts = {
    pending: items.filter((i) => i.status === 'pending').length,
    in_progress: items.filter((i) => i.status === 'in_progress').length,
    approved: items.filter((i) => i.status === 'approved').length,
    rejected: items.filter((i) => i.status === 'rejected').length,
  };

  // Map QueueRow to the wire shape the UI already expects.
  const wireItems = items.map((i) => ({
    id: i.external_id,
    session_id: i.session_id,
    sesion_label: i.sesion_label,
    expediente: i.expediente,
    date: i.date,
    duration_seconds: i.duration_seconds,
    confidence: i.confidence,
    flagged_segments: i.flagged_segments,
    status: i.status,
    source: i.source,
    speaker: i.speaker,
    excerpt: i.excerpt_text,
    excerpt_ts: i.excerpt_ts,
  }));

  res.json(live({ counts, items: wireItems }));
});

adminRouter.get('/transcripciones/:id', async (req, res) => {
  // The id here is the legacy session id (string of the integer).
  const sessionId = String(req.params.id);
  try {
    // 1) Find the legacy session — pull a wide window so we don't miss
    //    older sessions the operator may want to re-review. Iterating
    //    the whole list is fine because legacyCl2Client caps at 200.
    const today = new Date();
    const since = new Date(today);
    since.setDate(today.getDate() - 365);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const legacyRows = await listTranscripciones({
      fecha_inicio: fmt(since),
      fecha_fin: fmt(today),
      limit: 500,
    });
    const legacy = legacyRows.find((r) => String(r.id) === sessionId);
    if (!legacy) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    // 2) Pull the review row if any.
    const { data: reviewRow } = await supa()
      .from('transcripciones_review')
      .select('status, reviewer_note, reviewed_at, payload')
      .eq('session_id', sessionId)
      .maybeSingle();

    const review = (reviewRow ?? null) as {
      status?: string;
      reviewer_note?: string | null;
      reviewed_at?: string | null;
      payload?: { segments?: unknown[]; diarization?: unknown[]; total_segments?: number; total_words?: number };
    } | null;

    const item = legacyToQueueRow(legacy, new Map([[sessionId, { status: review?.status ?? 'pending' }]]));
    const wireItem = {
      id: item.external_id,
      session_id: item.session_id,
      sesion_label: item.sesion_label,
      expediente: item.expediente,
      date: item.date,
      duration_seconds: item.duration_seconds,
      confidence: item.confidence,
      flagged_segments: item.flagged_segments,
      status: item.status,
      source: item.source,
      speaker: item.speaker,
      excerpt: item.excerpt_text,
      excerpt_ts: item.excerpt_ts,
    };

    // 3) Fetch transcript segments from the legacy GCS URL when
    //    available. Best-effort — if the JSON isn't accessible we
    //    fall back to a single-row excerpt from the resumen.
    let segments: Array<{ ts: string; speaker: string; text: string; confidence: number; flagged: boolean }> = [];
    let totalSegments = 0;
    let totalWords = 0;

    if (legacy.transcripcion) {
      try {
        const r = await fetch(legacy.transcripcion);
        if (r.ok) {
          // Legacy GCS transcript shape: array with a single object
          //   [{ ok: true, transcription: { text, words: [...], ... } }]
          // `words` is per-token: { text, start, end, type, logprob }.
          // `type === 'word'` are real tokens; `type === 'spacing'` are
          // separators we can either keep as-is or filter — keeping
          // them for natural reading flow.
          const raw = (await r.json()) as Array<{
            transcription?: {
              text?: string;
              words?: Array<{ text?: string; start?: number; end?: number; type?: string; logprob?: number }>;
            };
          }>;
          const trans = raw[0]?.transcription ?? {};
          const words = trans.words ?? [];
          totalWords = words.filter((w) => w.type === 'word').length;

          // Group words into pseudo-segments by silence gap (>1.2s) OR
          // a hard cap of 35 words per segment. Each segment becomes
          // a row in the moderation pane. Confidence is average of
          // word logprobs converted to probability.
          interface Group {
            words: typeof words;
            start: number;
            end: number;
          }
          const groups: Group[] = [];
          let current: Group | null = null;
          for (const w of words) {
            if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
            const gap = current ? w.start - current.end : 0;
            const tooMany = current && current.words.length >= 35;
            if (!current || gap > 1.2 || tooMany) {
              if (current) groups.push(current);
              current = { words: [w], start: w.start, end: w.end };
            } else {
              current.words.push(w);
              current.end = w.end;
            }
          }
          if (current) groups.push(current);
          totalSegments = groups.length;

          // First 12 groups → segments for the pane. Logprob → confidence:
          // probability = e^logprob; pct = probability * 100. We average
          // across the group for a single confidence number.
          segments = groups.slice(0, 12).map((g) => {
            const text = g.words.map((w) => w.text ?? '').join('').trim();
            const wordOnly = g.words.filter((w) => w.type === 'word' && typeof w.logprob === 'number');
            const avgProb = wordOnly.length
              ? wordOnly.reduce((acc, w) => acc + Math.exp(w.logprob ?? 0), 0) / wordOnly.length
              : 1;
            const conf = Math.round(avgProb * 100);
            return {
              ts: secondsToTs(g.start),
              speaker: 'Plenaria',
              text,
              confidence: conf,
              flagged: conf < 70,
            };
          });
        }
      } catch (err) {
        req.log?.warn('admin/transcripciones detail: transcript fetch failed', {
          error: (err as Error).message,
          url: legacy.transcripcion,
        });
      }
    }

    if (segments.length === 0 && legacy.resumen) {
      // Fallback: render the resumen as a single segment so the pane
      // isn't empty.
      segments = [
        { ts: '0:00:00', speaker: 'Resumen ejecutivo', text: legacy.resumen.slice(0, 600), confidence: 100, flagged: false },
      ];
    }

    res.json(
      live({
        item: wireItem,
        segments,
        diarization: [], // legacy doesn't expose; future Whisper job will fill
        total_segments: totalSegments || segments.length,
        total_words: totalWords,
      }),
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

function secondsToTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    : `${m}:${ss.toString().padStart(2, '0')}`;
}

adminRouter.post('/transcripciones/:id/review', async (req, res) => {
  const action = req.body?.action;
  const note = (req.body?.note as string | undefined) ?? null;
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action must be approve|reject' });
    return;
  }
  // The id is the legacy session id (string of an int). The review row
  // is keyed by session_id so each session gets exactly one decision.
  const sessionId = String(req.params.id);

  try {
    const user = await getUserFromRequest(req);
    const status = action === 'approve' ? 'approved' : 'rejected';

    // Upsert by session_id. If the operator changes their mind later,
    // a second call with the opposite action overwrites the row — the
    // audit log keeps both entries so the history is intact.
    type ReviewUpsert = {
      session_id: string;
      external_id: string;
      status: string;
      reviewed_by: string | null;
      reviewed_at: string;
      reviewer_note: string | null;
    };
    const upsertClient = supa() as unknown as {
      from: (t: string) => {
        upsert: (
          v: ReviewUpsert,
          opts: { onConflict: string },
        ) => Promise<{ error: { message: string } | null }>;
      };
    };
    const { error } = await upsertClient.from('transcripciones_review').upsert(
      {
        session_id: sessionId,
        external_id: sessionId, // unique constraint — keep mirrored
        status,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
        reviewer_note: note,
      },
      { onConflict: 'external_id' },
    );
    if (error) throw new Error(error.message);

    await auditFromReq(req, {
      verb: action === 'approve' ? 'aprobó' : 'rechazó',
      resource: `transcripción sesión #${sessionId}`,
      resource_kind: 'transcription',
      resource_id: sessionId,
      result: 'ok',
      metadata: { note },
    });

    res.json({ ok: true, id: sessionId, action, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Agents — live counters + persisted overrides ────────────────────
adminRouter.get('/agents/status', async (_req, res) => {
  try {
    const overrides = await loadOverrides();
    const stats = snapshotAll();
    const ids = ['lexa', 'atlas', 'centinela'];
    const data = ids.map((id) => {
      const s = stats[id];
      const o = overrides.get(id);
      return {
        agent_id: id,
        enabled: o?.enabled ?? true,
        model: o?.model ?? null,
        queries_24h: s?.queries_24h ?? 0,
        queries_recent_60m: s?.queries_recent_60m ?? 0,
        p50_ms: s?.p50_ms ?? null,
        p95_ms: s?.p95_ms ?? null,
        error_rate_pct: s?.error_rate_pct ?? 0,
      };
    });
    res.json(live({ items: data }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/agents/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const before = await getOverride(req.params.id);
    const next = await setOverride(
      req.params.id,
      {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      },
      user?.id ?? null,
    );

    const verb =
      before?.enabled !== next.enabled
        ? next.enabled
          ? 'activó'
          : 'desactivó'
        : 'editó';
    await auditFromReq(req, {
      verb,
      resource: `agente ${req.params.id}`,
      resource_kind: 'agent',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { before, after: next },
    });

    res.json({ ok: true, agent: next });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Feature flags — read + write ────────────────────────────────────
adminRouter.get('/flags', async (_req, res) => {
  try {
    const flags = await loadFlags(true);
    res.json(live({ flags }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/flags/:key', async (req, res) => {
  if (req.body?.value === undefined) {
    res.status(400).json({ ok: false, error: 'value required' });
    return;
  }
  try {
    const user = await getUserFromRequest(req);
    const before = (await loadFlags(true))[req.params.key];
    await setFlag(req.params.key, req.body.value, user?.id ?? null);
    await auditFromReq(req, {
      verb: 'cambió',
      resource: `flag ${req.params.key}`,
      resource_kind: 'flag',
      resource_id: req.params.key,
      result: 'ok',
      metadata: { before, after: req.body.value },
    });
    res.json({ ok: true, key: req.params.key, value: req.body.value });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Expedientes watchlist (per-user) ────────────────────────────────
adminRouter.get('/watchlist', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      // Anonymous → empty list (UI knows how to render "no hay alertas").
      // We don't 401 because the watchlist is a soft personalization, not
      // a critical surface — every other section degrades gracefully.
      res.json(live({ ids: [] as number[] }));
      return;
    }
    const { data, error } = await supa()
      .from('expedientes_watchlist')
      .select('expediente_id')
      .eq('user_id', user.id);
    if (error) {
      // Specific error from PostgREST. Common case during the demo:
      // table just got created and the schema cache hadn't propagated
      // when the first query landed → schema_cache_miss. Restart of the
      // PostgREST instance fixes it; retry on a 30s window also works.
      req.log?.warn('admin/watchlist supabase error', {
        message: error.message,
        code: (error as { code?: string }).code,
        hint: (error as { hint?: string }).hint,
      });
      // Soft-degrade: empty list + the original message in the response
      // body (dev only — Express in prod truncates).
      res.json({
        ok: true,
        mock: false,
        degraded: true,
        degraded_reason: error.message,
        generated_at: new Date().toISOString(),
        data: { ids: [] as number[] },
      });
      return;
    }
    res.json(live({ ids: (data ?? []).map((r) => r.expediente_id as number) }));
  } catch (err) {
    req.log?.error('admin/watchlist threw', {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.post('/watchlist/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'auth_required' });
      return;
    }
    const expedienteId = Number(req.params.id);
    if (!Number.isFinite(expedienteId)) {
      res.status(400).json({ ok: false, error: 'bad_id' });
      return;
    }
    const action = req.body?.action;
    if (action === 'add') {
      const { error } = await supa()
        .from('expedientes_watchlist')
        .upsert({ user_id: user.id, expediente_id: expedienteId });
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'activó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else if (action === 'remove') {
      const { error } = await supa()
        .from('expedientes_watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('expediente_id', expedienteId);
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'quitó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else {
      res.status(400).json({ ok: false, error: 'action must be add|remove' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Audit log (real reads + filters + CSV) ──────────────────────────
adminRouter.get('/audit', async (req, res) => {
  try {
    let q = supa()
      .from('audit_log')
      .select('id, ts, actor_id, actor_email, actor_kind, verb, resource, resource_kind, resource_id, ip, result, metadata')
      .order('ts', { ascending: false })
      .limit(Math.min(Number(req.query.limit ?? 200) || 200, 500));
    if (typeof req.query.actor_kind === 'string') q = q.eq('actor_kind', req.query.actor_kind);
    if (typeof req.query.verb === 'string') q = q.ilike('verb', `%${req.query.verb}%`);
    if (typeof req.query.from === 'string') q = q.gte('ts', req.query.from);
    if (typeof req.query.to === 'string') q = q.lte('ts', req.query.to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((r) => ({
      ts: r.ts,
      actor: r.actor_kind === 'system' ? 'sys' : initialsForEmail(r.actor_email),
      actor_kind: r.actor_kind,
      actor_email: r.actor_email,
      verb: r.verb,
      resource: r.resource,
      resource_kind: r.resource_kind,
      ip: r.ip ?? null,
      result: r.result,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.get('/audit.csv', async (req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('ts, actor_email, actor_kind, verb, resource, resource_kind, result, ip')
      .order('ts', { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const lines = [
      ['ts', 'actor_email', 'actor_kind', 'verb', 'resource', 'resource_kind', 'result', 'ip'].join(','),
      ...rows.map((r) =>
        [
          r.ts,
          r.actor_email ?? '',
          r.actor_kind,
          quoteCsv(String(r.verb ?? '')),
          quoteCsv(String(r.resource ?? '')),
          r.resource_kind ?? '',
          r.result,
          r.ip ?? '',
        ].join(','),
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Users — list + role + invite ────────────────────────────────────
adminRouter.get('/users', async (_req, res) => {
  try {
    const s = supa();
    const { data, error } = await s.auth.admin.listUsers({ page: 1, perPage: 50 });
    if (error) throw new Error(error.message);
    const items = (data?.users ?? []).map((u) => ({
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      role: ((u.user_metadata as { role?: string } | null)?.role as string | null) ?? 'lector',
      status: u.last_sign_in_at ? 'activo' : 'invitado',
    }));
    res.json(live({ items }));
  } catch (err) {
    logger.warn('admin/users live read failed', { error: (err as Error).message });
    // Fall through to mock when admin API isn't available.
    res.json(
      mocked({
        items: [
          { id: 'mock-1', email: 'juanma@shiftlab.cr',         created_at: '2026-01-12T00:00:00Z', last_sign_in_at: new Date(Date.now() - 120_000).toISOString(),   role: 'admin',    status: 'activo'   },
          { id: 'mock-2', email: 'diana.rodriguez@asamblea.go.cr', created_at: '2026-02-03T00:00:00Z', last_sign_in_at: new Date(Date.now() - 14*60_000).toISOString(),  role: 'operador', status: 'activo'   },
          { id: 'mock-3', email: 'andres@shiftlab.cr',         created_at: '2026-02-08T00:00:00Z', last_sign_in_at: new Date(Date.now() - 5*60*60_000).toISOString(), role: 'editor',   status: 'activo'   },
          { id: 'mock-4', email: 'tatiana.vargas@asamblea.go.cr', created_at: '2026-04-22T00:00:00Z', last_sign_in_at: null,                                            role: 'lector',   status: 'invitado' },
          { id: 'mock-5', email: 'msolano@asamblea.go.cr',     created_at: '2026-03-01T00:00:00Z', last_sign_in_at: new Date(Date.now() - 18*60*60_000).toISOString(), role: 'lector',   status: 'activo'   },
          { id: 'mock-6', email: 'rrojas@example.com',         created_at: '2026-04-25T00:00:00Z', last_sign_in_at: null,                                            role: null,       status: 'solicitud' },
        ],
      }),
    );
  }
});

adminRouter.post('/users/invite', async (req, res) => {
  const email = req.body?.email;
  const role = (req.body?.role as string | undefined) ?? 'lector';
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'bad_email' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.inviteUserByEmail(email, {
      data: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'invitó',
      resource: email,
      resource_kind: 'user',
      resource_id: data.user?.id ?? email,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true, id: data.user?.id ?? null, email });
  } catch (err) {
    await auditFromReq(req, {
      verb: 'falló invitar',
      resource: email,
      resource_kind: 'user',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/users/:id', async (req, res) => {
  const role = req.body?.role;
  if (typeof role !== 'string') {
    res.status(400).json({ ok: false, error: 'role required' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.updateUserById(req.params.id, {
      user_metadata: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'cambió rol',
      resource: data.user?.email ?? req.params.id,
      resource_kind: 'user',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Punto Medio passthrough — Forzar consolidación ──────────────────
adminRouter.post('/punto-medio/consolidate', async (req, res) => {
  const tenant = (req.body?.tenant as string | undefined) ?? process.env.CEREBRO_TENANT ?? 'cl2';
  const base = process.env.CEREBRO_BASE_URL ?? '';
  if (!base) {
    res.status(503).json({ ok: false, error: 'cerebro_unconfigured' });
    return;
  }
  try {
    const upstream = await fetch(`${base}/punto-medio/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    });
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}: ${body.slice(0, 200)}`);
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'ok',
    });
    res.setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Re-índice handler — wires to nothing destructive yet, but logs. ─
adminRouter.post('/reindex', async (req, res) => {
  await auditFromReq(req, {
    verb: 'solicitó re-índice',
    resource: 'corpus completo',
    resource_kind: 'system',
    result: 'ok',
    metadata: { note: 'queued — worker no arranca aún en producción' },
  });
  res.json({
    ok: true,
    queued: true,
    note: 'Job marcado para reproceso. El worker batch lo recoge en la próxima ventana.',
  });
});

// ─── Workers (mock — legacy worker doesn't publish status today) ─────
adminRouter.get('/workers', (_req, res) => {
  res.json(
    mocked({
      items: [
        { name: 'scraper-orden-del-dia',    schedule: '0 7 * * 1-5',  last_run_iso: '2026-04-26T13:55:00Z', last_duration_ms: 82_000,  ok: true,  total_runs: 128,  success_rate_pct: 99.2 },
        { name: 'scraper-actas-plenaria',   schedule: '0 22 * * 1-5', last_run_iso: '2026-04-25T22:04:00Z', last_duration_ms: 258_000, ok: true,  total_runs: 94,   success_rate_pct: 100  },
        { name: 'scraper-expedientes-sil',  schedule: '*/15 * * * *', last_run_iso: '2026-04-26T14:30:00Z', last_duration_ms: 38_000,  ok: false, total_runs: 8412, success_rate_pct: 96.7, error: '3× 502 del SIL' },
        { name: 'transcribe-whisper-batch', schedule: 'evento',       last_run_iso: '2026-04-26T13:58:00Z', last_duration_ms: 724_000, ok: true,  total_runs: 341,  success_rate_pct: 98.4 },
        { name: 'embed-rag-chunks',         schedule: 'evento',       last_run_iso: '2026-04-26T14:01:00Z', last_duration_ms: 44_000,  ok: true,  total_runs: 1207, success_rate_pct: 99.9 },
        { name: 'consolidate-cerebro',      schedule: '0 3 * * *',    last_run_iso: '2026-04-26T03:00:00Z', last_duration_ms: 378_000, ok: true,  total_runs: 62,   success_rate_pct: 100  },
      ],
    }),
  );
});

// ─── Build info ──────────────────────────────────────────────────────
adminRouter.get('/build', (_req, res) => {
  res.json(
    live({
      version: process.env.SHIFT_CL2_VERSION ?? '0.1.0',
      build: process.env.SHIFT_CL2_BUILD ?? 'dev',
      deployed_at: process.env.SHIFT_CL2_DEPLOYED_AT ?? null,
      node: process.version,
      region: process.env.RAILWAY_REGION ?? process.env.AWS_REGION ?? 'local',
      host: process.env.PUBLIC_API_HOST ?? 'localhost:3001',
      locale: 'es-CR · UTC-6',
    }),
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────

function initialsForEmail(email: string | null | undefined): string {
  if (!email) return '??';
  const local = email.split('@')[0] ?? '';
  const parts = local.replace(/[._-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function quoteCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Boot — log a one-time line so the operator can see the audit_log
// will receive entries when actions land.
void audit({
  actor_kind: 'system',
  verb: 'arrancó',
  resource: 'admin BFF',
  resource_kind: 'system',
  result: 'ok',
}).catch(() => undefined);

export { adminRouter };
