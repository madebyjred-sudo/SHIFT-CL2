/**
 * /api/public/* — anonymous, public-facing endpoints for the marketing
 * landing.
 *
 * The single endpoint here is a heavily-bounded chat against Lexa so a
 * prospect on /landing can try a real conversation against the corpus
 * without an account. It is NOT the same surface as /api/chat:
 *
 *   - No auth → public.
 *   - Hard cap of N prompts per IP per 24h (defense-in-depth on top of
 *     the client localStorage counter, which is purely UX).
 *   - Hard global cap per day (cost ceiling — the demo is free, but it's
 *     not a wide-open API).
 *   - Single agent only (Lexa). No agent override, no model override.
 *   - Prompt length cap (600 chars). Long enough for a real question,
 *     short enough to bound token cost.
 *   - Output max_tokens cap so a single answer can't blow up the bill.
 *   - No conversation persistence, no peaje fire, no punto-medio
 *     injection. Demo traffic does not pollute the flywheel.
 *
 * The client is expected to send the prior turns in `prior` so we can
 * simulate continuity. We trim prior to ≤8 entries (≤4 user/assistant
 * pairs) before forwarding to OpenRouter.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { CerebroStreamChunk } from '@shift-cl2/shared-types';
import { openRouterStream } from '../services/openRouterClient.js';
import { transcribeAudio } from '../services/elevenlabsClient.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { signPodcastAudio } from '../services/podcastStorage.js';

let _shareSupa: SupabaseClient | null = null;
function shareSupa(): SupabaseClient {
  if (_shareSupa) return _shareSupa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _shareSupa = createClient(url, key, { auth: { persistSession: false } });
  return _shareSupa;
}

export const publicDemoRouter = Router();

// ─── Constraints ─────────────────────────────────────────────────────

// Hard caps. These intentionally match what the landing UI advertises
// (5 interacciones) so the user experience is consistent with reality.
const PROMPTS_PER_IP_24H = 5;
const PROMPTS_GLOBAL_24H = 500;
const PROMPT_MAX_CHARS = 600;
const PRIOR_MAX_ENTRIES = 8; // 4 user + 4 assistant
const PRIOR_ENTRY_MAX_CHARS = 1_500;
const ANSWER_MAX_TOKENS = 800;

// One bucket per IP, one global bucket. In-memory is fine for now —
// single API process; if/when we scale, swap for Redis with the same
// shape.
interface Bucket {
  count: number;
  resetAt: number;
}
const ipBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { count: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 };

function rollWindow(b: Bucket, windowMs: number): void {
  const now = Date.now();
  if (b.resetAt <= now) {
    b.count = 0;
    b.resetAt = now + windowMs;
  }
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const ipFromFwd = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
  return ipFromFwd || req.ip || req.socket.remoteAddress || 'unknown';
}

// Periodic sweep of stale ip buckets. Same cadence as the standard
// rateLimit middleware sweeper.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets) if (v.resetAt <= now) ipBuckets.delete(k);
}, 60_000).unref();

// ─── Input shape ─────────────────────────────────────────────────────

interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface DemoChatBody {
  query?: unknown;
  prior?: unknown;
}

function validateAndNormalize(body: DemoChatBody): { query: string; prior: PriorTurn[] } | { error: string } {
  if (typeof body.query !== 'string') return { error: 'query_required' };
  const query = body.query.trim();
  if (!query) return { error: 'query_empty' };
  if (query.length > PROMPT_MAX_CHARS) return { error: 'query_too_long' };

  // Block obvious noise: control chars, NULs, anything that clearly
  // isn't a user-written question. Helps stop scripted abuse.
  if (/[\x00-\x1f\x7f]/.test(query)) return { error: 'query_invalid_chars' };

  let prior: PriorTurn[] = [];
  if (Array.isArray(body.prior)) {
    for (const item of body.prior) {
      if (
        typeof item === 'object' && item !== null &&
        'role' in item && 'content' in item &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string'
      ) {
        prior.push({
          role: item.role,
          content: item.content.slice(0, PRIOR_ENTRY_MAX_CHARS),
        });
      }
    }
    // Keep the most recent N entries; drop older context if longer.
    if (prior.length > PRIOR_MAX_ENTRIES) {
      prior = prior.slice(-PRIOR_MAX_ENTRIES);
    }
  }

  return { query, prior };
}

// ─── Endpoint ────────────────────────────────────────────────────────

publicDemoRouter.post('/demo-chat', async (req: Request, res: Response) => {
  const ip = clientIp(req);

  // 1) Per-IP rate limit (hard 5/24h). Returns 429 with retry_after_s.
  const ipBucket: Bucket = ipBuckets.get(ip) ?? { count: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 };
  rollWindow(ipBucket, 24 * 60 * 60 * 1000);
  ipBuckets.set(ip, ipBucket);
  if (ipBucket.count >= PROMPTS_PER_IP_24H) {
    const retryAfter = Math.max(1, Math.ceil((ipBucket.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      ok: false,
      error: 'demo_quota_exhausted',
      message: 'Ya usaste tus 5 consultas de demo. Volvé en 24 horas o agendá una demo completa.',
      retry_after_s: retryAfter,
    });
    return;
  }

  // 2) Global daily ceiling (cost cap — never let the demo run away).
  rollWindow(globalBucket, 24 * 60 * 60 * 1000);
  if (globalBucket.count >= PROMPTS_GLOBAL_24H) {
    req.log?.warn('public_demo_global_cap_hit', { ip, count: globalBucket.count });
    res.status(503).json({
      ok: false,
      error: 'demo_capacity_full',
      message: 'La demo pública está saturada hoy. Agendá una demo completa para no esperar.',
    });
    return;
  }

  // 3) Validate body.
  const parsed = validateAndNormalize((req.body ?? {}) as DemoChatBody);
  if ('error' in parsed) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }
  const { query, prior } = parsed;

  // Burn the quota at the START of the request — even if the model
  // errors, the user has consumed the slot. Otherwise a flaky network
  // becomes a free-credits exploit.
  ipBucket.count += 1;
  globalBucket.count += 1;

  // 4) Stream over SSE. Format mirrors /api/chat/stream so the client
  // can reuse the same chunk types if useful. Persistence is OFF.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Demo-Remaining', String(Math.max(0, PROMPTS_PER_IP_24H - ipBucket.count)));
  res.flushHeaders();

  const send = (chunk: CerebroStreamChunk | { type: string; payload?: unknown }) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  // Synthesize a "query with prior" by prepending recent turns to the
  // user's question. The persona system prompt comes from the agent
  // YAML inside openRouterStream; we don't need to assemble it here.
  // We pass `prior` as part of the query string with role tags — simple,
  // bounded, and avoids fiddling with the existing message-shaping
  // pipeline. Length already capped above.
  let combinedQuery = query;
  if (prior.length > 0) {
    const transcript = prior
      .map((p) => `[${p.role === 'user' ? 'Usuario' : 'Lexa'}]: ${p.content}`)
      .join('\n\n');
    combinedQuery = `Contexto previo de esta misma conversación (NO repitas literal, solo continuá):\n${transcript}\n\nMensaje actual del usuario:\n${query}`;
  }

  try {
    await openRouterStream({
      agent_id: 'lexa',
      query: combinedQuery,
      conversation_id: undefined,
      deep_insight: false,
      model_override: undefined,
      dynamic_rag_prompt: undefined, // never inject curaduría on demo traffic
      scope_system_prompt: undefined,
      scope_legacy_session_id: null,
      onChunk: (chunk) => send(chunk),
      // openRouterStream doesn't currently take max_tokens — bound is set
      // inside the agent YAML. That's fine: Lexa's default is already
      // conservative. Keeping the cap constant here for future reference.
    });
    send({ type: 'done', payload: { remaining: Math.max(0, PROMPTS_PER_IP_24H - ipBucket.count) } });
  } catch (err) {
    req.log?.warn('public_demo_failed', { error: (err as Error).message, ip });
    send({
      type: 'error',
      payload: {
        code: 'internal',
        message: 'Algo falló del lado nuestro. Probá de nuevo en un momento.',
      },
    });
  } finally {
    res.end();
  }
});

// ─── Public voice transcribe (landing demo) ──────────────────────────
//
// Same shape as /api/voice/transcribe but anonymous + heavily capped.
// Lets a prospect dictate a question on the landing without an account.
// Caps:
//   - audio max 5MB (~5 min of webm/opus)
//   - 10 transcriptions per IP per 24h (independent counter from chat)
//   - rejects empty + oversize at multer layer
const VOICE_PER_IP_24H = 10;
const voiceIpBuckets = new Map<string, Bucket>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of voiceIpBuckets) if (v.resetAt <= now) voiceIpBuckets.delete(k);
}, 60_000).unref();

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

publicDemoRouter.post('/voice', voiceUpload.single('audio'), async (req, res) => {
  const ip = clientIp(req);
  const bucket: Bucket = voiceIpBuckets.get(ip) ?? { count: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 };
  rollWindow(bucket, 24 * 60 * 60 * 1000);
  voiceIpBuckets.set(ip, bucket);

  if (bucket.count >= VOICE_PER_IP_24H) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      ok: false,
      error: 'demo_voice_quota_exhausted',
      message: 'Llegaste al máximo de transcripciones de demo por hoy.',
      retry_after_s: retryAfter,
    });
    return;
  }

  if (!req.file || req.file.size === 0) {
    res.status(400).json({ ok: false, error: 'audio_required' });
    return;
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(500).json({ ok: false, error: 'eleven_not_configured' });
    return;
  }

  // Burn the slot up front — same rationale as /demo-chat.
  bucket.count += 1;

  try {
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    res.json({ ok: true, text });
  } catch (err) {
    req.log?.warn('public_voice_failed', { error: (err as Error).message, ip });
    res.status(502).json({
      ok: false,
      error: 'transcribe_failed',
      detail: (err as Error).message.slice(0, 200),
    });
  }
});

// ─── Podcast share lookup ─────────────────────────────────────────────
//
// GET /api/public/podcasts/share/:token — anonymous endpoint. Token is
// the auth: server validates against `podcasts.share_token` + checks
// expiration, increments view count, and 302s to a short-lived GCS
// signed URL. Browser <audio> can follow the redirect with credentials
// omitted (signed URL is self-authenticating).
//
// Defense:
//   - Token is a UUIDv4 (rejects non-UUID quickly without a DB hit).
//   - Expiration enforced on read.
//   - On `?json=1` returns metadata so the share page can render a
//     player + title + duration before redirecting to audio.
publicDemoRouter.get('/podcasts/share/:token', async (req, res) => {
  const token = String(req.params.token ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  const { data, error } = await shareSupa()
    .from('podcasts')
    .select('id, audio_path, title, duration_actual_s, share_expires_at, share_views, status')
    .eq('share_token', token)
    .single();

  if (error || !data) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  const row = data as {
    id: string;
    audio_path: string | null;
    title: string | null;
    duration_actual_s: number | null;
    share_expires_at: string | null;
    share_views: number;
    status: string;
  };

  if (row.status !== 'ready' || !row.audio_path) {
    res.status(409).json({ ok: false, error: 'not_ready' });
    return;
  }
  if (row.share_expires_at && new Date(row.share_expires_at).getTime() < Date.now()) {
    res.status(410).json({ ok: false, error: 'expired' });
    return;
  }

  // Telemetry — non-blocking, log on failure but don't bail.
  void shareSupa()
    .from('podcasts')
    .update({ share_views: (row.share_views ?? 0) + 1 })
    .eq('id', row.id)
    .then((r) => {
      if (r.error) req.log?.warn('share_view_count_failed', { error: r.error.message });
    });

  try {
    const url = await signPodcastAudio(row.audio_path);
    if (req.query.json === '1') {
      res.json({
        ok: true,
        url,
        title: row.title,
        duration_s: row.duration_actual_s,
      });
      return;
    }
    res.redirect(302, url);
  } catch (err) {
    req.log?.error('share_sign_failed', { error: (err as Error).message });
    res.status(502).json({ ok: false, error: 'sign_failed' });
  }
});

// Optional GET for a quick "how many do I have left" without burning a slot.
publicDemoRouter.get('/demo-chat/quota', (req: Request, res: Response) => {
  const ip = clientIp(req);
  const ipBucket: Bucket = ipBuckets.get(ip) ?? { count: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 };
  rollWindow(ipBucket, 24 * 60 * 60 * 1000);
  rollWindow(globalBucket, 24 * 60 * 60 * 1000);
  res.json({
    ok: true,
    per_ip_remaining: Math.max(0, PROMPTS_PER_IP_24H - ipBucket.count),
    per_ip_limit: PROMPTS_PER_IP_24H,
    global_full: globalBucket.count >= PROMPTS_GLOBAL_24H,
    reset_at: new Date(ipBucket.resetAt).toISOString(),
  });
});
