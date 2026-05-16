/**
 * Voice → prompt — ElevenLabs Scribe STT proxy + voice-converse loop.
 *
 * Two endpoints:
 *   - POST /transcribe → push-to-talk STT. Returns plain text the frontend
 *     stuffs into the chat textarea so the user can review/edit before
 *     sending. This is the existing "dictate a prompt" UX.
 *   - POST /converse → full voice-conversational turn. User audio in,
 *     Lexa transcript + audio out. Used by the VoiceConverseModal where
 *     the consultant talks to Lexa hands-free.
 *   - GET /quota → read-only quota snapshot for the UI (chars used this
 *     month, conversations today, remaining).
 *
 * Why server-side:
 *   - The ElevenLabs API key never touches the browser.
 *   - We can rate-limit/cap audio length centrally.
 *
 * Cost shape:
 *   - Scribe v1 is ~$0.0067/min. A 30-second prompt costs ~$0.003.
 *   - TTS is ~$0.30/1000 chars on multilingual_v2. A 600-char Lexa reply
 *     costs ~$0.18. The 800-char cap + 30-min/mo soft quota bounds the
 *     monthly cost at ~$3-4 per heavy user.
 *
 * Why we don't stream the converse loop:
 *   - We need the full LLM response before TTS can start (can't synthesize
 *     incrementally). The simpler "block until done, return audio + text"
 *     contract makes the modal much easier to drive (single fetch, two
 *     panels of state). Future iteration could chunk by sentence and stream
 *     audio chunks, but that's Sprint 4+ work.
 */
import { Router } from 'express';
import multer from 'multer';
import type { CerebroStreamChunk } from '@shift-cl2/shared-types';
import { getUserFromRequest, getUserIdFromRequest } from '../services/auth.js';
import { requireQuota, logAiCall, getUserQuota } from '../services/aiQuota.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  transcribeAudio,
  synthesizeSpeech,
} from '../services/elevenlabsClient.js';
import { openRouterStream } from '../services/openRouterClient.js';

export const voiceRouter = Router();

// 25MB ≈ 25 min of webm/opus at 64kbps. Hard cap so a runaway recorder
// can't ship a 1GB file. multer parses multipart/form-data into req.file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Tighter multer for /converse — voice replies are conversational (a few
// seconds), not 25-min monologues. 5MB ≈ 5 min of webm/opus at 64kbps,
// matches the doctrine cap on input length.
const CONVERSE_MAX_BYTES = 5 * 1024 * 1024;
const converseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONVERSE_MAX_BYTES },
});

// LLM response cap — short replies sound natural in audio; long ones turn
// into a podcast. 300 tokens ≈ 220 spoken words ≈ 90s of audio at a normal
// speaking pace. Hard cap before TTS clips to 800 chars.
const CONVERSE_MAX_TOKENS = 300;

// TTS char cap — extra safety net on top of the token cap. Even if the
// model ignores max_tokens for some reason, we never bill more than this.
const CONVERSE_MAX_TTS_CHARS = 800;

// Monthly soft quota on TTS output chars. ~30 min of speech at typical
// rates. Logged in `ai_call_log.meta.tts_chars` per call so the read path
// can sum it cheaply. Env override for power users / demos.
const TTS_MONTHLY_CHAR_QUOTA = Number(
  process.env.VOICE_CONVERSE_MONTHLY_CHARS ?? 90_000,
);

interface ConverseTurn {
  role: 'user' | 'assistant';
  content: string;
}

voiceRouter.post('/transcribe', upload.single('audio'), async (req, res) => {
  // Auth gate — voice transcription is per-user, not anonymous. Public
  // demo can ship a separate endpoint with stricter caps if needed.
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ ok: false, error: 'audio_required' });
    return;
  }
  if (req.file.size === 0) {
    res.status(400).json({ ok: false, error: 'empty_audio' });
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(500).json({ ok: false, error: 'eleven_not_configured' });
    return;
  }

  // Daily quota gate — Scribe v1 charges ~$0.0067/min so an
  // unbounded user could rack up real money. requireQuota writes the
  // 429 if over the cap; we exit before contacting ElevenLabs.
  if ((await requireQuota(userId, 'voice.transcribe', res)) === 'denied') return;

  try {
    const t0 = Date.now();
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    void logAiCall(userId, 'voice.transcribe', {
      bytes: req.file.size,
      mime: req.file.mimetype,
      length_chars: text.length,
    });
    req.log?.info('voice/transcribe ok', {
      bytes: req.file.size,
      mime: req.file.mimetype,
      chars: text.length,
      ms: Date.now() - t0,
    });
    res.json({ ok: true, text });
  } catch (err) {
    req.log?.warn('voice/transcribe failed', { error: (err as Error).message });
    res.status(502).json({ ok: false, error: 'transcribe_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/voice/converse
 *
 * Voice → STT → LLM (Lexa) → TTS → audio + transcript back to the client.
 *
 * Request: multipart with:
 *   - audio (required, ≤5MB)
 *   - conversation_id (optional, currently informational — context lives in
 *     the `history` field, not persisted as a chat conversation)
 *   - history (optional JSON string, array of {role,content}) — caller
 *     maintains the rolling turn list locally in the modal.
 *
 * Response (200):
 *   {
 *     ok: true,
 *     transcript_user: string,
 *     transcript_lexa: string,
 *     audio_url: "data:audio/mpeg;base64,..."
 *   }
 *
 * Failure modes:
 *   - 401 auth_required
 *   - 413 audio_too_large (multer + explicit re-check)
 *   - 429 rate_limit / daily_quota_exhausted / monthly_tts_quota_exhausted
 *   - 502 transcribe_failed / llm_failed / tts_failed
 *   - 500 eleven_not_configured
 *
 * Rate limit: 10/min/user (caro de ElevenLabs — STT + TTS por turno).
 * Wired below at router-mount time so the existing /api/voice 30/min cap
 * still applies to the cheap STT-only /transcribe path.
 */
voiceRouter.post(
  '/converse',
  rateLimit({ bucket: 'voice.converse', max: 10, windowMs: 60_000 }),
  converseUpload.single('audio'),
  async (req, res) => {
    const authedUser = await getUserFromRequest(req);
    const userId = authedUser?.id ?? null;
    const userEmail = authedUser?.email ?? null;
    if (!userId) {
      res.status(401).json({ ok: false, error: 'auth_required' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ ok: false, error: 'audio_required' });
      return;
    }
    if (req.file.size === 0) {
      res.status(400).json({ ok: false, error: 'empty_audio' });
      return;
    }
    if (req.file.size > CONVERSE_MAX_BYTES) {
      // multer should have rejected first, but belt-and-braces.
      res.status(413).json({ ok: false, error: 'audio_too_large', max_bytes: CONVERSE_MAX_BYTES });
      return;
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      res.status(500).json({ ok: false, error: 'eleven_not_configured' });
      return;
    }

    // Daily quota gate (per-route, generic). Same fail-open semantics as
    // the STT endpoint — DB hiccup doesn't block legit users.
    if ((await requireQuota(userId, 'voice.converse', res)) === 'denied') return;

    // Monthly TTS char quota — enforced before we spend any provider $.
    // Read the running total from ai_call_log meta and compare to the cap.
    // Failure here fails-open with a warning, matching aiQuota.ts doctrine.
    const monthlyUsed = await getMonthlyTtsCharsUsed(userId, req.log).catch(() => 0);
    if (monthlyUsed >= TTS_MONTHLY_CHAR_QUOTA) {
      res.status(429).json({
        ok: false,
        error: 'monthly_tts_quota_exhausted',
        used: monthlyUsed,
        limit: TTS_MONTHLY_CHAR_QUOTA,
        message: 'Alcanzaste tu cuota de voz mensual. Volvé el mes que viene.',
      });
      return;
    }

    // Parse the optional history blob — multipart strings come as strings.
    let history: ConverseTurn[] = [];
    const rawHistory = (req.body as { history?: unknown })?.history;
    if (typeof rawHistory === 'string' && rawHistory.length > 0) {
      try {
        const parsed = JSON.parse(rawHistory) as unknown;
        if (Array.isArray(parsed)) {
          history = parsed
            .filter(
              (t): t is ConverseTurn =>
                !!t &&
                typeof t === 'object' &&
                (t as ConverseTurn).role !== undefined &&
                typeof (t as ConverseTurn).content === 'string',
            )
            // Keep last 20 turns max — matches openRouterStream's cap.
            .slice(-20);
        }
      } catch {
        // bad JSON → treat as no history, don't 400 (UX is too fragile)
      }
    }

    const t0 = Date.now();
    let transcriptUser = '';
    let transcriptLexa = '';

    // ── Step 1: STT ────────────────────────────────────────────────────
    try {
      transcriptUser = await transcribeAudio(req.file.buffer, req.file.mimetype);
    } catch (err) {
      req.log?.warn('voice/converse stt_failed', { error: (err as Error).message });
      res.status(502).json({ ok: false, error: 'transcribe_failed', detail: (err as Error).message });
      return;
    }
    if (!transcriptUser.trim()) {
      // Silence / non-speech. Don't bill the LLM for an empty turn.
      res.status(400).json({ ok: false, error: 'empty_transcript' });
      return;
    }

    // ── Step 2: LLM (Lexa) — accumulate stream to a buffer ────────────
    // We reuse openRouterStream's two-pass tool loop + Cerebro instrumentation.
    // The onChunk callback just accumulates 'token' deltas; everything else
    // (citations, pptx_status, etc.) is discarded for the voice flow — the
    // modal can't render them anyway.
    try {
      await openRouterStream({
        agent_id: 'lexa',
        query: transcriptUser,
        deep_insight: false,
        user_id: userId,
        user_email: userEmail,
        history,
        onChunk: (chunk: CerebroStreamChunk) => {
          if (chunk.type === 'token' && typeof chunk.payload === 'string') {
            transcriptLexa += chunk.payload;
          }
        },
      });
    } catch (err) {
      req.log?.warn('voice/converse llm_failed', { error: (err as Error).message });
      res.status(502).json({ ok: false, error: 'llm_failed', detail: (err as Error).message });
      return;
    }

    if (!transcriptLexa.trim()) {
      transcriptLexa =
        'No tengo una respuesta concreta para esa pregunta. Probá darme un poco más de contexto.';
    }

    // Hard-cap the TTS input. The 300-token model cap is a soft hint to the
    // LLM; this is the absolute ceiling on what we send to ElevenLabs (where
    // the bill is per char). Truncate on a word boundary so the audio
    // doesn't end mid-word.
    let ttsInput = transcriptLexa;
    if (ttsInput.length > CONVERSE_MAX_TTS_CHARS) {
      const cut = ttsInput.slice(0, CONVERSE_MAX_TTS_CHARS);
      const lastSpace = cut.lastIndexOf(' ');
      ttsInput = (lastSpace > CONVERSE_MAX_TTS_CHARS - 80 ? cut.slice(0, lastSpace) : cut) + '…';
    }

    // ── Step 3: TTS ────────────────────────────────────────────────────
    let mp3: Buffer;
    try {
      mp3 = await synthesizeSpeech(ttsInput);
    } catch (err) {
      req.log?.warn('voice/converse tts_failed', { error: (err as Error).message });
      res.status(502).json({ ok: false, error: 'tts_failed', detail: (err as Error).message });
      return;
    }

    // Log AFTER the upstream dispatch so abuse via rapid retries still
    // counts toward the daily cap. tts_chars is what drives the monthly
    // soft quota — keep that key stable.
    void logAiCall(userId, 'voice.converse', {
      bytes_in: req.file.size,
      mime_in: req.file.mimetype,
      transcript_user_chars: transcriptUser.length,
      transcript_lexa_chars: transcriptLexa.length,
      tts_chars: ttsInput.length,
      audio_bytes: mp3.length,
      history_turns: history.length,
    });

    req.log?.info('voice/converse ok', {
      ms: Date.now() - t0,
      stt_chars: transcriptUser.length,
      tts_chars: ttsInput.length,
      mp3_bytes: mp3.length,
    });

    const audioUrl = `data:audio/mpeg;base64,${mp3.toString('base64')}`;
    res.json({
      ok: true,
      transcript_user: transcriptUser,
      transcript_lexa: transcriptLexa,
      audio_url: audioUrl,
    });
  },
);

/**
 * GET /api/voice/quota — read-only quota snapshot for the modal footer.
 *
 * Returns:
 *   - chars_used_month: sum of `meta.tts_chars` across voice.converse rows
 *     in the trailing 30 days.
 *   - chars_quota: TTS_MONTHLY_CHAR_QUOTA (env-overridable).
 *   - conversaciones_today: count of voice.converse rows in last 24h
 *     (same accounting as the daily cap; comes from ai_calls_user_daily_count).
 */
voiceRouter.get('/quota', async (req, res) => {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }
  const [chars, daily] = await Promise.all([
    getMonthlyTtsCharsUsed(userId, req.log).catch(() => 0),
    getUserQuota(userId, 'voice.converse'),
  ]);
  res.json({
    ok: true,
    chars_used_month: chars,
    chars_quota: TTS_MONTHLY_CHAR_QUOTA,
    conversaciones_today: daily.used,
    conversaciones_daily_limit: daily.limit,
  });
});

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Sum meta.tts_chars across voice.converse rows for this user in the
 * trailing 30 days. Uses the same supabase client as aiQuota.ts (we
 * import its module-level handle indirectly via createClient — keeping
 * the SQL local instead of growing aiQuota.ts with feature-specific
 * accounting).
 */
async function getMonthlyTtsCharsUsed(
  userId: string,
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<number> {
  // Lazy import to avoid a top-level dep cycle through aiQuota → supa.
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return 0;
  const client = createClient(url, key, { auth: { persistSession: false } });
  // Pull the meta column for the last 30 days and sum in JS — simpler
  // than a Postgres function for a feature still in stretch. If this
  // grows to many rows per user we'll move it to a SQL aggregate.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('ai_call_log')
    .select('meta')
    .eq('user_id', userId)
    .eq('route', 'voice.converse')
    .gte('created_at', since);
  if (error) {
    log?.warn('voice_monthly_tts_read_failed', { error: error.message });
    return 0;
  }
  let total = 0;
  for (const row of data ?? []) {
    const m = (row as { meta?: { tts_chars?: unknown } }).meta;
    const n = Number(m?.tts_chars ?? 0);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}
