/**
 * /api/podcasts — async briefing-podcast pipeline.
 *
 * Flow:
 *   POST /api/podcasts                 → row inserted (status=queued),
 *                                         worker kicked in-band, returns id
 *   GET  /api/podcasts/:id             → polled for status / progress
 *   GET  /api/podcasts/:id/audio       → 302 to GCS signed URL (auth)
 *   GET  /api/podcasts/mine            → user history list
 *   GET  /api/podcasts/voices          → whitelisted voice options for the modal
 *
 * Worker is in-band on the same Node process — single API host, no
 * BullMQ yet. State machine:
 *   queued → scripting → tts → encoding → ready  (or → failed)
 *
 * Caps:
 *   - per-user: 5 ready/in-flight per 24h (DB-side via SECURITY DEFINER fn)
 *   - per-podcast input source: trimmed to bounded chars before script gen
 *   - TTS char cap: enforced inside podcastScript.validateScript()
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';
import {
  generateMonologue,
  whitelistedVoices,
  isVoiceWhitelisted,
} from '../services/elevenlabsClient.js';
import { generatePodcastScript, type PodcastScript } from '../services/podcastScript.js';
import { uploadPodcastAudio, signPodcastAudio } from '../services/podcastStorage.js';
import { getTranscripcionById } from '../services/legacyCl2Client.js';
import { getExpedienteById } from '../services/silClient.js';
import { logger } from '../services/logger.js';

export const podcastsRouter = Router();

// ─── Constants ───────────────────────────────────────────────────────

const USER_DAILY_CAP = 5;
const ALLOWED_DURATIONS = new Set([90, 180, 300]);
const ALLOWED_STYLES = new Set(['informativo', 'conversacional']);
const ALLOWED_SOURCES = new Set(['sesion', 'expediente', 'chat']);

// ─── Supabase service client ─────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

// ─── In-process job tracking ─────────────────────────────────────────
//
// One in-flight worker per podcast id, kept here so /status reflects
// current step even before the next DB write. Survives until the row
// hits a terminal state (ready / failed / cancelled).
const jobs = new Map<string, { startedAt: number }>();

// ─── Routes ──────────────────────────────────────────────────────────

podcastsRouter.get('/voices', (_req, res) => {
  res.json({ ok: true, voices: whitelistedVoices() });
});

/**
 * POST /api/podcasts
 * Body: { source_type, source_id, voice_id, duration_target_s, style }
 * Returns: { ok, id, status }
 */
podcastsRouter.post('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const body = (req.body ?? {}) as Partial<{
    source_type: string;
    source_id: string;
    voice_id: string;
    duration_target_s: number;
    style: string;
  }>;

  // Validate.
  const source_type = body.source_type;
  const source_id = body.source_id;
  const voice_id = body.voice_id;
  const duration_target_s = Number(body.duration_target_s);
  const style = body.style ?? 'informativo';

  if (!source_type || !ALLOWED_SOURCES.has(source_type)) {
    res.status(400).json({ ok: false, error: 'bad_source_type' });
    return;
  }
  if (!source_id || typeof source_id !== 'string') {
    res.status(400).json({ ok: false, error: 'bad_source_id' });
    return;
  }
  if (!voice_id || !isVoiceWhitelisted(voice_id)) {
    res.status(400).json({ ok: false, error: 'bad_voice_id' });
    return;
  }
  if (!ALLOWED_DURATIONS.has(duration_target_s)) {
    res.status(400).json({ ok: false, error: 'bad_duration' });
    return;
  }
  if (!ALLOWED_STYLES.has(style)) {
    res.status(400).json({ ok: false, error: 'bad_style' });
    return;
  }

  // Per-user daily cap (server-side hard gate, in addition to UI).
  try {
    const { data: countData, error: countErr } = await supa().rpc(
      'podcasts_user_daily_count',
      { uid: userId },
    );
    if (countErr) throw countErr;
    const used = Number(countData ?? 0);
    if (used >= USER_DAILY_CAP) {
      res.status(429).json({
        ok: false,
        error: 'daily_quota_exhausted',
        message: `Llegaste al límite de ${USER_DAILY_CAP} podcasts por día. Volvé en 24 horas.`,
      });
      return;
    }
  } catch (err) {
    req.log?.warn('podcast_quota_check_failed', { error: (err as Error).message });
    // Fail open — counted is non-critical for the demo. Worker still
    // capped by global cost ceiling implicitly via input/output caps.
  }

  // Insert row (status=queued). Service-role bypasses RLS so we set
  // user_id explicitly here.
  const insert = await supa()
    .from('podcasts')
    .insert({
      user_id: userId,
      source_type,
      source_id,
      voice_id,
      duration_target_s,
      style,
      status: 'queued',
    })
    .select('id')
    .single();

  if (insert.error || !insert.data) {
    req.log?.error('podcast_insert_failed', { error: insert.error?.message });
    res.status(500).json({ ok: false, error: 'insert_failed' });
    return;
  }

  const id = (insert.data as { id: string }).id;
  res.json({ ok: true, id, status: 'queued' });

  // Kick worker fire-and-forget. Errors persisted to the row so the
  // client polling /:id sees them.
  void runWorker(id, userId).catch((err) => {
    logger.error('podcast_worker_unhandled', {
      podcast_id: id,
      error: (err as Error).message,
    });
  });
});

/**
 * GET /api/podcasts/:id — status polling.
 */
podcastsRouter.get('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = String(req.params.id);
  const { data, error } = await supa()
    .from('podcasts')
    .select(
      'id, source_type, source_id, title, voice_id, duration_target_s, duration_actual_s, style, status, progress, error, created_at, finished_at',
    )
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true, podcast: data });
});

/**
 * GET /api/podcasts/:id/audio — 302 to short-lived GCS signed URL.
 * Browser <audio> can follow redirect with credentials:'omit', so this
 * works as `<audio src={view_url}>` directly.
 */
podcastsRouter.get('/:id/audio', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = String(req.params.id);
  const { data, error } = await supa()
    .from('podcasts')
    .select('audio_path, status')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  const row = data as { audio_path: string | null; status: string };
  if (!row.audio_path || row.status !== 'ready') {
    res.status(409).json({ ok: false, error: 'not_ready', status: row.status });
    return;
  }

  try {
    const url = await signPodcastAudio(row.audio_path);
    const wantsJson = req.query.json === '1';
    if (wantsJson) {
      res.json({ ok: true, url });
      return;
    }
    res.redirect(302, url);
  } catch (err) {
    req.log?.error('podcast_sign_failed', { error: (err as Error).message, id });
    res.status(502).json({ ok: false, error: 'sign_failed' });
  }
});

/**
 * GET /api/podcasts/mine — user history.
 */
podcastsRouter.get('/mine', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const { data, error } = await supa()
    .from('podcasts')
    .select(
      'id, source_type, source_id, title, voice_id, duration_target_s, duration_actual_s, status, progress, created_at, finished_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, items: data ?? [] });
});

// ─── Worker ──────────────────────────────────────────────────────────
//
// Sequential pipeline; each step writes status + progress before
// proceeding. Errors are caught and persisted as `failed` with the
// message; the row never gets stuck in an in-flight state.

async function runWorker(podcastId: string, userId: string): Promise<void> {
  jobs.set(podcastId, { startedAt: Date.now() });
  try {
    // Re-read the row to pick up params authoritatively.
    const { data: row, error: rowErr } = await supa()
      .from('podcasts')
      .select('id, source_type, source_id, voice_id, duration_target_s, style, status')
      .eq('id', podcastId)
      .single();
    if (rowErr || !row) throw new Error('row_missing');
    const r = row as {
      source_type: 'sesion' | 'expediente' | 'chat';
      source_id: string;
      voice_id: string;
      duration_target_s: number;
      style: 'informativo' | 'conversacional';
      status: string;
    };
    if (r.status === 'cancelled') return;

    // Step 1: gather source text.
    await markStatus(podcastId, 'scripting', 10);
    const { source_text, source_label } = await loadSource(r.source_type, r.source_id);

    // Step 2: script generation (Lexa).
    const script = await generatePodcastScript({
      source_text,
      source_label,
      duration_target_s: r.duration_target_s,
      style: r.style,
    });
    await supa()
      .from('podcasts')
      .update({
        title: script.title,
        script: script as unknown as Record<string, unknown>,
        progress: 30,
        status: 'tts',
      })
      .eq('id', podcastId);

    // Step 3: TTS — concat per-segment mp3 buffers.
    const buffers: Buffer[] = [];
    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      const mp3 = await generateMonologue({ voiceId: r.voice_id, text: seg.text });
      buffers.push(mp3);
      const pct = 30 + Math.round(((i + 1) / script.segments.length) * 50);
      await supa().from('podcasts').update({ progress: pct }).eq('id', podcastId);
    }

    // Step 4: encoding/upload. mp3 is already encoded per chunk; native
    // concat works for mp3 frames in practice (no container metadata
    // mid-stream issues with EL output). Players handle it fine.
    await markStatus(podcastId, 'encoding', 85);
    const audio = Buffer.concat(buffers);
    const audioPath = await uploadPodcastAudio(userId, podcastId, audio);

    // Step 5: ready.
    await supa()
      .from('podcasts')
      .update({
        audio_path: audioPath,
        cost_chars: script.total_chars,
        duration_actual_s: estimateDurationSeconds(script),
        status: 'ready',
        progress: 100,
        finished_at: new Date().toISOString(),
      })
      .eq('id', podcastId);

    logger.info('podcast_ready', {
      podcast_id: podcastId,
      cost_chars: script.total_chars,
      segments: script.segments.length,
    });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown_error';
    logger.warn('podcast_failed', { podcast_id: podcastId, error: msg });
    await supa()
      .from('podcasts')
      .update({
        status: 'failed',
        error: msg.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq('id', podcastId);
  } finally {
    jobs.delete(podcastId);
  }
}

async function markStatus(podcastId: string, status: string, progress: number): Promise<void> {
  await supa().from('podcasts').update({ status, progress }).eq('id', podcastId);
}

function estimateDurationSeconds(script: PodcastScript): number {
  // 150 wpm ≈ 2.5 words/sec ≈ 15 chars/sec for Spanish.
  return Math.max(30, Math.round(script.total_chars / 15));
}

// ─── Source loaders ──────────────────────────────────────────────────
//
// Each branch returns a {source_text, source_label} pair the script
// generator can chew on. Keep extracts conservative — generator caps to
// 12k chars internally, but we want the most relevant slice on top.

async function loadSource(
  type: 'sesion' | 'expediente' | 'chat',
  id: string,
): Promise<{ source_text: string; source_label: string }> {
  if (type === 'sesion') {
    const numId = Number(id);
    if (!Number.isFinite(numId)) throw new Error('bad_sesion_id');
    const sess = await getTranscripcionById(numId);
    if (!sess) throw new Error('sesion_not_found');
    const parts: string[] = [];
    if (sess.titulo) parts.push(`Sesión: ${sess.titulo}`);
    if (sess.fecha) parts.push(`Fecha: ${sess.fecha}`);
    if (sess.resumen) parts.push(`\nResumen ejecutivo:\n${sess.resumen}`);
    return {
      source_text: parts.join('\n').slice(0, 12_000),
      source_label: `sesión plenaria ${sess.titulo ?? numId}`,
    };
  }

  if (type === 'expediente') {
    const numId = Number(id);
    if (!Number.isFinite(numId)) throw new Error('bad_expediente_id');
    const exp = await getExpedienteById(numId);
    if (!exp) throw new Error('expediente_not_found');
    const parts: string[] = [];
    parts.push(`Expediente ${exp.numero}: ${exp.titulo ?? '(sin título)'}`);
    if (exp.proponente) parts.push(`Proponente: ${exp.proponente}`);
    if (exp.estado) parts.push(`Estado actual: ${exp.estado}`);
    if (exp.comision) parts.push(`Comisión: ${exp.comision}`);
    if (exp.documentos?.length) {
      parts.push(`\nDocumentos en el expediente:`);
      for (const d of exp.documentos.slice(0, 6)) {
        parts.push(`- ${d.tipo}: ${d.titulo ?? ''} (${d.fecha ?? 's/f'})`);
      }
    }
    return {
      source_text: parts.join('\n').slice(0, 12_000),
      source_label: `expediente ${exp.numero}`,
    };
  }

  // chat: caller passes the conversation ID; we read messages from
  // Supabase. Phase 1 doesn't yet support custom prompts.
  if (type === 'chat') {
    const { data, error } = await supa()
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(40);
    if (error) throw new Error(`chat_load: ${error.message}`);
    const rows = (data ?? []) as Array<{ role: string; content: string }>;
    const text = rows.map((r) => `[${r.role}] ${r.content}`).join('\n\n').slice(0, 12_000);
    return { source_text: text, source_label: `conversación ${id.slice(0, 8)}` };
  }

  throw new Error(`unknown_source_type: ${type}`);
}
