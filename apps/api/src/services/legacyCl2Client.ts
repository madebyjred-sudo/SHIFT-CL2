/**
 * Legacy CL2 client — thin wrapper around api.agentescl2.com.
 *
 * Why: the legacy MariaDB-backed system is still source of truth for
 * `transcripciones` (titulo, youtube, fecha, duration, transcripcion url,
 * resumen). Re-implementing ingest before 2026-05-08 is out of scope, so the
 * new shift-cl2 frontend reads through this proxy and never talks to MariaDB.
 *
 * Auth: legacy public endpoints are unauthenticated. We still gate access at
 * the BFF layer (Supabase JWT required upstream).
 *
 * Cache: transcript JSONs are large (1-3MB ElevenLabs raw) and immutable per
 * videoId. Small in-memory LRU keeps them hot during a demo without a Redis.
 */
import { withRetry, withTimeout } from './resilience.js';

const LEGACY_BASE = process.env.LEGACY_CL2_API_URL ?? 'https://api.agentescl2.com';
const LEGACY_TIMEOUT_MS = 8_000;

export interface LegacyTranscripcion {
  id: number;
  titulo: string;
  youtube: string;
  fecha: string;          // ISO timestamp
  duration: number;       // seconds
  transcripcion: string;  // GCS URL → JSON
  estado: number;         // 1 = FINALIZADA
  resumen: string;        // markdown
}

interface ListArgs {
  fecha_inicio: string;   // YYYY-MM-DD
  fecha_fin: string;
  limit?: number;
  offset?: number;
}

async function legacyPost<T>(path: string, body: unknown): Promise<T> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(`${LEGACY_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });
          if (!res.ok) throw new Error(`legacy ${path} ${res.status}`);
          return (await res.json()) as T;
        },
        { ms: LEGACY_TIMEOUT_MS, label: `legacy:${path}` },
      ),
    {
      attempts: 2,
      baseDelayMs: 300,
      label: `legacy:${path}`,
      // 4xx other than 429 = client bug, fail fast.
      shouldRetry: (err) => {
        const m = (err as Error)?.message ?? '';
        const code = m.match(/ (\d{3})$/)?.[1];
        if (!code) return true;
        const n = Number(code);
        return n === 429 || n >= 500;
      },
    },
  );
}

export async function listTranscripciones(args: ListArgs): Promise<LegacyTranscripcion[]> {
  return legacyPost<LegacyTranscripcion[]>('/api/users/transcripciones', {
    fecha_inicio: args.fecha_inicio,
    fecha_fin: args.fecha_fin,
    limit: args.limit ?? 200,
    offset: args.offset ?? 0,
  });
}

// --- Write paths (Fase A — proxy to legacy ingest) ---------------------
// Used by /api/uploads to delegate the YouTube → MariaDB → worker chain to
// the existing legacy backend. Payload shapes guessed from field names in
// the audit (gcp-architecture.md). Server logs the raw response so we can
// adjust if legacy rejects.

export interface RegisterVideoArgs {
  youtube: string;          // full URL
  titulo: string;
  fecha: string;            // YYYY-MM-DD
  comision?: string;        // e.g. "Plenario"
  tipo?: string;            // 'plenario' | 'comision' | 'extraordinaria'
}

export interface RegisterVideoResult {
  ok?: boolean;
  id?: number;
  message?: string;
  [k: string]: unknown;     // tolerate any extra field legacy returns
}

/**
 * Register a video in the legacy MariaDB. Equivalent of what the legacy
 * frontend does when the user submits /subir-sesiones. Caller must follow
 * up with `kickAutomatic(id)` to actually trigger the worker pipeline.
 */
export async function registerVideo(args: RegisterVideoArgs): Promise<RegisterVideoResult> {
  return legacyPost<RegisterVideoResult>('/api/users/videos-register', args);
}

/**
 * Kick the legacy worker pipeline for a registered video. Worker pulls
 * audio from YouTube → ElevenLabs → resumen → updates MariaDB row
 * (state NEW → PROCESADO). Async; caller polls listTranscripciones.
 */
export async function kickAutomatic(legacyVideoId: number): Promise<unknown> {
  return legacyPost<unknown>('/api/users/sendToAutomatic', { id: legacyVideoId });
}

export async function getTranscripcionById(id: number): Promise<LegacyTranscripcion | null> {
  // Legacy has no by-id endpoint; pull a wide window and filter.
  // Fine for MVP (totals < 500 rows). Replace with proper endpoint when
  // we own the data layer.
  const today = new Date();
  const past = new Date(today);
  past.setFullYear(past.getFullYear() - 2);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const rows = await listTranscripciones({
    fecha_inicio: fmt(past),
    fecha_fin: fmt(today),
    limit: 2000,
  });
  return rows.find((r) => r.id === id) ?? null;
}

// --- Transcript JSON cache (LRU, in-memory) ----------------------------
// ElevenLabs raw blobs are 1-3MB each. 20 entries ≈ 60MB cap, fits in the
// API container without GC churn. Eviction on write when over capacity.

export interface TranscriptBlob {
  text: string;
  words: TranscriptWord[];
  language_code: string;
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

export interface TranscriptSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  word_count: number;
}

const SEGMENT_MAX_WORDS = 30;
const PAUSE_BREAK_S = 1.5;

/**
 * Group ElevenLabs words into segments at pause boundaries (>1.5s) or
 * after 30 words, whichever comes first. Used both by the transcript HTTP
 * route and by the session-scoped transcript search tool.
 */
export function wordsToSegments(words: TranscriptWord[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let buf: TranscriptWord[] = [];
  let lastEnd = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push({
      index: out.length,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map((w) => w.text).join('').replace(/\s+/g, ' ').trim(),
      word_count: buf.filter((w) => w.type !== 'spacing').length,
    });
    buf = [];
  };

  for (const w of words) {
    const gap = w.start - lastEnd;
    if (buf.length >= SEGMENT_MAX_WORDS || (buf.length > 0 && gap >= PAUSE_BREAK_S)) {
      flush();
    }
    buf.push(w);
    lastEnd = w.end;
  }
  flush();
  return out;
}

const TRANSCRIPT_CACHE_MAX = 20;
const transcriptCache = new Map<string, TranscriptBlob>();

export async function fetchTranscriptJson(transcripcionUrl: string): Promise<TranscriptBlob> {
  const cached = transcriptCache.get(transcripcionUrl);
  if (cached) {
    // Touch (LRU): re-insert to move to end.
    transcriptCache.delete(transcripcionUrl);
    transcriptCache.set(transcripcionUrl, cached);
    return cached;
  }

  // Retry on transient GCS hiccups — the blob is immutable, so a retry can't
  // change the response shape. Stop on 4xx (signed URL expired, key wrong).
  const blob = await withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(transcripcionUrl, { signal });
          if (!res.ok) throw new Error(`transcript fetch ${res.status}`);
          const raw = (await res.json()) as Array<{
            ok: boolean;
            transcription: TranscriptBlob;
          }>;
          if (!Array.isArray(raw) || !raw[0]?.transcription) {
            throw new Error('transcript: unexpected shape');
          }
          return raw[0].transcription;
        },
        { ms: 12_000, label: 'transcript-fetch' },
      ),
    {
      attempts: 2,
      baseDelayMs: 500,
      label: 'transcript-fetch',
      shouldRetry: (err) => {
        const m = (err as Error)?.message ?? '';
        const code = m.match(/ (\d{3})$/)?.[1];
        if (!code) return true;
        const n = Number(code);
        return n === 429 || n >= 500;
      },
    },
  );

  if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest) transcriptCache.delete(oldest);
  }
  transcriptCache.set(transcripcionUrl, blob);
  return blob;
}
