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
 */
export interface WhitelistedVoice {
  id: string;
  label: string;
  description: string;
}

export function whitelistedVoices(): WhitelistedVoice[] {
  return [
    {
      id: process.env.PODCAST_VOICE_HOST_ID ?? 'EXAVITQu4vr4xnSDxMAY',
      label: 'Anfitriona',
      description: 'Voz cálida y conversacional. Buena para resúmenes y briefings.',
    },
    {
      id: process.env.PODCAST_VOICE_GUEST_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
      label: 'Analista',
      description: 'Voz neutra y autoritativa. Buena para análisis técnico.',
    },
  ];
}

export function isVoiceWhitelisted(id: string): boolean {
  return whitelistedVoices().some((v) => v.id === id);
}
