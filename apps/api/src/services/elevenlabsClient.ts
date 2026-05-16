/**
 * ElevenLabs API client — TTS for the podcast pipeline.
 *
 * Stays narrow on purpose. Two ops:
 *   - generateMonologue: single-voice mp3 from a string of text.
 *   - listVoices: fetch + cache the voice library 24h (UI uses a
 *     whitelisted subset; this is for ops verification).
 *
 * Auth: ELEVENLABS_API_KEY env var, never client-side.
 * Cost: charged per char on the input text. Caller is responsible for
 * length capping; this module returns whatever the API returns.
 *
 * Resilience: TTS calls can be slow (10-60s per chunk). Use a long
 * timeout but don't auto-retry — a partial retry with the same text
 * would be billed twice. Caller decides on retry.
 */
import { withTimeout } from './resilience.js';
import { logger } from './logger.js';

const EL_BASE = 'https://api.elevenlabs.io';
const TTS_TIMEOUT_MS = 120_000;     // 2 min ceiling per chunk
const VOICES_TIMEOUT_MS = 10_000;
const VOICES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function key(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY not set');
  return k;
}

export interface ElevenVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  preview_url?: string;
  category?: string;
}

let _voicesCache: { fetchedAt: number; voices: ElevenVoice[] } | null = null;

/**
 * GET /v1/voices — full library. Cached 24h since the list barely
 * changes and the call is rate-limited on the ElevenLabs side too.
 */
export async function listVoices(): Promise<ElevenVoice[]> {
  if (_voicesCache && Date.now() - _voicesCache.fetchedAt < VOICES_CACHE_TTL_MS) {
    return _voicesCache.voices;
  }
  const res = await withTimeout(
    (signal) =>
      fetch(`${EL_BASE}/v1/voices`, {
        headers: { 'xi-api-key': key() },
        signal,
      }),
    { ms: VOICES_TIMEOUT_MS, label: 'elevenlabs:voices' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`elevenlabs voices ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { voices: ElevenVoice[] };
  _voicesCache = { fetchedAt: Date.now(), voices: json.voices ?? [] };
  return _voicesCache.voices;
}

export interface MonologueArgs {
  voiceId: string;
  text: string;
  modelId?: string;
  /** Stability 0..1 — lower = more expressive, higher = more uniform. */
  stability?: number;
  /** Similarity boost 0..1 — closer to original voice timbre. */
  similarityBoost?: number;
  /** Style exaggeration 0..1 — only honored on v2.5+ models. */
  style?: number;
  /** Speaker boost — clarity bump for varied input. */
  useSpeakerBoost?: boolean;
}

/**
 * POST /v1/text-to-speech/{voiceId} — returns the mp3 bytes.
 *
 * Default model: eleven_multilingual_v2 (good ES coverage, fast).
 * For dialogue / emotion tags use eleven_v3 in a future iteration.
 */
export async function generateMonologue(args: MonologueArgs): Promise<Buffer> {
  const {
    voiceId,
    text,
    modelId = 'eleven_multilingual_v2',
    stability = 0.5,
    similarityBoost = 0.75,
    style = 0,
    useSpeakerBoost = true,
  } = args;

  if (!voiceId) throw new Error('voiceId required');
  if (!text || text.trim().length === 0) throw new Error('text empty');

  const res = await withTimeout(
    (signal) =>
      fetch(`${EL_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'xi-api-key': key(),
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            style,
            use_speaker_boost: useSpeakerBoost,
          },
        }),
        signal,
      }),
    { ms: TTS_TIMEOUT_MS, label: 'elevenlabs:tts' },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn('elevenlabs_tts_failed', {
      status: res.status,
      voiceId,
      textLen: text.length,
      detail: detail.slice(0, 300),
    });
    throw new Error(`elevenlabs tts ${res.status}: ${detail.slice(0, 200)}`);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Whitelisted voice IDs the UI is allowed to pick. Set via env so we
 * can swap without redeploy. Defaults are popular ES-friendly voices
 * from the ElevenLabs public library — multilingual_v2 handles them
 * fine for Costa Rica neutral Spanish.
 *
 * Env names match the names exposed to the client so audit is trivial.
 *
 * In dialogue mode (style='conversacional'), `voice_id` selected here
 * is the HOST; the GUEST uses PODCAST_VOICE_GUEST_ID (env-fixed, not
 * exposed to the client UI).
 */
export interface WhitelistedVoice {
  id: string;
  label: string;
  description: string;
}

/**
 * Resolve whitelisted voices for the podcast UI.
 *
 * Priority:
 *   1. Explicit env vars PODCAST_VOICE_HOST_ID / PODCAST_VOICE_GUEST_ID
 *      → use those; fastest path, no extra API call.
 *   2. No env vars → call listVoices() (cached 24h) and map the first
 *      N voices from the account into host/analyst slots so the UI
 *      always has valid IDs regardless of which voices the account has.
 *
 * This avoids hardcoding public-library voice IDs that may not exist
 * in every ElevenLabs account.
 */
export async function resolveWhitelistedVoices(): Promise<WhitelistedVoice[]> {
  const envHost = process.env.PODCAST_VOICE_HOST_ID;
  const envGuest = process.env.PODCAST_VOICE_GUEST_ID;

  if (envHost && envGuest) {
    return [
      {
        id: envHost,
        label: 'Anfitriona',
        description: 'Voz cálida y conversacional. Buena para resúmenes y briefings.',
      },
      {
        id: envGuest,
        label: 'Analista',
        description: 'Voz neutra y autoritativa. Buena para análisis técnico.',
      },
    ];
  }

  // Fetch real voices from the account.
  const accountVoices = await listVoices();
  if (accountVoices.length === 0) {
    throw new Error('No voices found in ElevenLabs account. Add at least one voice to your library.');
  }

  // If only host env is set, pair with second account voice for guest.
  const hostVoice = envHost
    ? accountVoices.find((v) => v.voice_id === envHost) ?? accountVoices[0]
    : accountVoices[0];
  const guestVoice = envGuest
    ? accountVoices.find((v) => v.voice_id === envGuest) ?? accountVoices[1] ?? accountVoices[0]
    : accountVoices[1] ?? accountVoices[0];

  return [
    {
      id: hostVoice.voice_id,
      label: envHost ? 'Anfitriona' : hostVoice.name,
      description: 'Voz cálida y conversacional. Buena para resúmenes y briefings.',
    },
    {
      id: guestVoice.voice_id,
      label: envGuest ? 'Analista' : guestVoice.name,
      description: 'Voz neutra y autoritativa. Buena para análisis técnico.',
    },
  ];
}

/** Sync access kept only for backwards compat — returns empty when env vars absent. */
export function whitelistedVoices(): WhitelistedVoice[] {
  const envHost = process.env.PODCAST_VOICE_HOST_ID;
  const envGuest = process.env.PODCAST_VOICE_GUEST_ID;
  if (!envHost || !envGuest) return [];
  return [
    { id: envHost, label: 'Anfitriona', description: 'Voz cálida y conversacional.' },
    { id: envGuest, label: 'Analista', description: 'Voz neutra y autoritativa.' },
  ];
}

export async function isVoiceWhitelisted(id: string): Promise<boolean> {
  const voices = await resolveWhitelistedVoices();
  return voices.some((v) => v.id === id);
}

/** Guest voice ID for dialogue mode. */
export async function guestVoiceId(): Promise<string> {
  const voices = await resolveWhitelistedVoices();
  return voices[1]?.id ?? voices[0].id;
}

/**
 * Model selection. `eleven_v3` understands inline audio tags like
 * [thoughtful]; `eleven_multilingual_v2` ignores them. We default to
 * v3 only when explicitly opted-in via env, since v3 may be flagged
 * as preview/limited on some accounts and we don't want to silently
 * regress mp3 quality if the model isn't enabled.
 */
export function pickTtsModel(opts: { dialogue: boolean }): string {
  if (opts.dialogue && process.env.PODCAST_DIALOGUE_MODEL) {
    return process.env.PODCAST_DIALOGUE_MODEL;
  }
  return process.env.PODCAST_MODEL ?? 'eleven_multilingual_v2';
}

/**
 * Wrap a segment text with a v3 audio tag if the model supports it.
 * No-op for multilingual_v2 — emotion tags don't bleed because
 * multilingual_v2 silently drops bracketed text unless it matches
 * SSML which we don't use.
 */
export function applyEmotionTag(text: string, emotion: string | undefined, model: string): string {
  if (!emotion || emotion === 'neutral') return text;
  if (!/v3/.test(model)) return text;
  // v3 expects the tag at the very start of the line.
  return `[${emotion}] ${text}`;
}

/**
 * Thin convenience wrapper around `generateMonologue` for the voice-converse
 * route. `generateMonologue` is the canonical TTS call (used by the podcast
 * pipeline); this just picks a sensible default voice + model for the Lexa
 * conversational use case.
 *
 * Voice resolution order:
 *   1. Explicit `voiceId` argument
 *   2. `LEXA_VOICE_ID` env (lets ops pin a specific voice without redeploy)
 *   3. The first voice from `resolveWhitelistedVoices()` (which itself falls
 *      back to the first voice in the account)
 *
 * Model: `eleven_multilingual_v2` — good Spanish coverage, fast enough for
 * an interactive conversation loop (~1-2s TTFA on short replies).
 *
 * The caller is responsible for length capping (the converse route enforces
 * an 800-char ceiling before calling here). We do NOT retry — a retry on the
 * same text would be billed twice.
 */
export async function synthesizeSpeech(text: string, voiceId?: string): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text empty');

  let voice = voiceId ?? process.env.LEXA_VOICE_ID;
  if (!voice) {
    const resolved = await resolveWhitelistedVoices();
    voice = resolved[0]?.id;
  }
  if (!voice) throw new Error('no voice available for TTS');

  return generateMonologue({
    voiceId: voice,
    text: trimmed,
    modelId: 'eleven_multilingual_v2',
  });
}

// ─── Speech-to-Text (Scribe) ──────────────────────────────────────────
//
// ElevenLabs Scribe is the cheap STT tier (~$0.40/hour ≈ $0.0067/min) —
// the right choice for "voice → prompt" UX where we only need the text
// back to stuff into the textarea. We pass language_code='spa' explicitly
// because the auto-detect step adds latency and Costa Rica use is 100%
// Spanish.
//
// Cost guardrails on the caller side:
//   - audio capped at 25MB at the multer layer (≈25 min of webm/opus)
//   - tag_audio_events=false → cheaper tier, no laughter/[applause] tags
//   - timestamps_granularity='none' → less data shipped back
//
// Returns just the transcript text. If you need word-level timestamps
// later (e.g., to highlight while playing back), bump granularity here.
const STT_TIMEOUT_MS = 60_000;

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  // ElevenLabs accepts webm/ogg/mp3/m4a/wav — pass through whatever
  // MediaRecorder gave us. Filename is cosmetic on their side but the
  // mime in the Blob is what they sniff for codec.
  // Buffer<ArrayBufferLike> doesn't satisfy BlobPart since it can be
  // backed by SharedArrayBuffer. Copy into a fresh ArrayBuffer-backed
  // Uint8Array so the type narrows definitively.
  const dst = new ArrayBuffer(audio.byteLength);
  new Uint8Array(dst).set(audio);
  const blob = new Blob([dst], { type: mimeType || 'audio/webm' });
  const ext = mimeType.includes('webm') ? 'webm'
    : mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('mp3') ? 'mp3'
    : mimeType.includes('mp4') ? 'm4a'
    : 'wav';
  form.append('file', blob, `recording.${ext}`);
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'spa');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'none');

  const res = await withTimeout(
    () => fetch(`${EL_BASE}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': key() },
      body: form,
    }),
    { ms: STT_TIMEOUT_MS, label: 'elevenlabs:stt' },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn('elevenlabs_stt_failed', {
      status: res.status,
      bytes: audio.length,
      mimeType,
      detail: detail.slice(0, 300),
    });
    throw new Error(`elevenlabs stt ${res.status}: ${detail.slice(0, 200)}`);
  }

  const json = await res.json() as { text?: string };
  return (json.text ?? '').trim();
}
