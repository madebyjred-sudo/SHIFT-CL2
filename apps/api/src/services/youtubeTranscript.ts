/**
 * YouTube transcript client — download auto-captions as timed segments.
 *
 * Wraps the `youtube-transcript` npm library (pure Node, no Python) with:
 *   - per-attempt timeout via resilience.withTimeout
 *   - exponential-backoff retry for transient failures (network + rate-limit)
 *   - normalization of lib-native segment shape to { start_seconds, end_seconds, text }
 *   - typed error class so callers can branch on failure mode cleanly
 *
 * Why `youtube-transcript` v1.3.1:
 *   - Released 2026-04-25 (2 days before this task) — actively maintained
 *   - ESM-first, zero Python deps
 *   - InnerTube (Android client) primary path + HTML-scrape fallback
 *   - Handles auto-captions + manual tracks, returns language code
 *   - Returns { text, offset, duration } — trivially converted to start/end seconds
 *
 * Target channel: @AsambleaCRC (Costa Rica legislature, Spanish, auto-transcribed
 * 1-4h after each session upload). Videos are in Spanish — request lang='es'.
 *
 * Caveats (from spec §6):
 *   - `youtube-transcript` scrapes timed-text tracks — not an official API.
 *     YouTube changed the timed-text format in 2023; this lib handles both
 *     the classic XML (<text start="s" dur="s">) and srv3 (<p t="ms" d="ms">).
 *   - Rate limits are undocumented. We retry up to 3 times with backoff.
 *   - Auto-captions for a session may not appear for 1-4h after upload.
 *     The transcript-process job handles the "not ready yet" case by
 *     catching 'no_transcript_available' and re-queuing after 1h.
 */
import {
  fetchTranscript as libFetchTranscript,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
} from 'youtube-transcript';
import { withTimeout, withRetry, ResilienceError } from './resilience.js';
import { logger } from './logger.js';
// Fallback fetcher used when the npm lib reports `no_transcript_available`
// for a video that the YouTube Data API confirms has an ASR track. yt-dlp
// goes through Innertube + JS-challenge solving and reliably extracts
// auto-captions for long-form plenarios. See ytDlpTranscript.ts.
import { fetchTranscriptViaYtDlp, YtDlpError } from './ytDlpTranscript.js';
// Primary fetcher (mayo 2026): Gemini 2.5 Flash con YouTube URI directo.
// YouTube bloquea las IPs de Cloud Run para captions (lib + yt-dlp), pero
// Gemini accede al video desde infra de Google internamente sin bloqueo.
// Mantenemos lib + yt-dlp como fallback para dev local sin ADC o si Vertex
// AI tiene un outage. Ver geminiVideoTranscript.ts.
import { fetchTranscriptViaGemini, fetchTranscriptViaGeminiChunked, GeminiTranscriptError } from './geminiVideoTranscript.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LANGUAGE = 'es';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
// Exponential backoff: 2s → 4s → (give up). Chosen to be respectful of
// YouTube's undocumented rate limits while not blocking the job queue too long.
const BASE_DELAY_MS = 2_000;

// Heuristic threshold to detect whether offset/duration values are in
// milliseconds (srv3 format) or seconds (classic XML format). The lib
// transparently supports both formats but mixes units in the returned shape.
// 100_000 seconds ≈ 27.8 hours — no legislative session is that long.
// 100_000 ms = 100 seconds — common in normal videos.
// Any segment offset above this threshold must be milliseconds.
//
// DOMAIN ASSUMPTION: this heuristic only works reliably for videos where
// at least one segment falls past the ~100s mark. For AsambleaCRC plenarias
// (3-4 hours), this is always true. If this service is ever extended to
// cover short clips (<100s), this heuristic must be replaced with a more
// reliable signal (e.g. checking lib version, or a config flag from caller).
const MS_VS_SECONDS_THRESHOLD = 100_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  /** Start time in seconds (float, ≤3 decimal places). */
  start_seconds: number;
  /** End time in seconds (float, ≤3 decimal places). */
  end_seconds: number;
  /** Transcript text — trimmed, single line, HTML entities decoded. */
  text: string;
  /** ISO language code if exposed by the lib (e.g. 'es', 'es-419'). */
  language?: string;
}

export type YoutubeTranscriptErrorCode =
  | 'video_not_found'
  | 'no_transcript_available'
  | 'rate_limited'
  | 'network'
  | 'parse_error'
  | 'cancelled';

export class YoutubeTranscriptError extends Error {
  constructor(
    message: string,
    public readonly code: YoutubeTranscriptErrorCode,
    public readonly videoId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'YoutubeTranscriptError';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Heuristic to detect ms-based timecodes vs seconds-based.
 *
 * The youtube-transcript lib returns offsets in seconds for the classic XML
 * timed-text endpoint, and in ms for srv3 (which YouTube's CDN sometimes
 * serves transparently). We detect by looking at the largest offset:
 * if any segment is past 100,000 (= 100,000s = 27.7 hours, impossible for
 * a real video), we assume the lib is giving us milliseconds and divide.
 *
 * DOMAIN ASSUMPTION: this heuristic only works reliably for videos where
 * at least one segment falls past the ~100s mark. For AsambleaCRC plenarias
 * (3-4 hours), this is always true. If this service is ever extended to
 * cover short clips (<100s), this heuristic must be replaced with a more
 * reliable signal (e.g. checking lib version, or a config flag from caller).
 */
function detectMilliseconds(segments: { offset: number }[]): boolean {
  return segments.some((s) => s.offset > MS_VS_SECONDS_THRESHOLD);
}

/** Round to 3 decimal places. Matches transcript_segments schema: numeric(10,3). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Normalize raw lib segments into our canonical TranscriptSegment shape.
 * Handles the ms vs seconds ambiguity and strips any stray whitespace/newlines
 * that YouTube sometimes injects into timed-text payloads.
 */
function normalizeSegments(
  raw: { text: string; offset: number; duration: number; lang?: string }[],
): TranscriptSegment[] {
  if (raw.length === 0) return [];

  const isMs = detectMilliseconds(raw);
  const divisor = isMs ? 1000 : 1;

  return raw
    .map((seg) => {
      const start = round3(seg.offset / divisor);
      const end = round3((seg.offset + seg.duration) / divisor);
      // Collapse newlines / excess whitespace injected by YouTube's timed-text
      // encoding into a single space so downstream chunking sees clean lines.
      const text = seg.text.replace(/\s+/g, ' ').trim();
      return { start_seconds: start, end_seconds: end, text, language: seg.lang };
    })
    .filter((seg) => seg.text.length > 0); // drop empty segments (rare but present)
}

/**
 * Map the lib's typed errors (and generic JS errors) to our YoutubeTranscriptError.
 *
 * Code mapping:
 *   YoutubeTranscriptVideoUnavailableError → video_not_found
 *   YoutubeTranscriptDisabledError         → no_transcript_available
 *   YoutubeTranscriptNotAvailableError     → no_transcript_available
 *   YoutubeTranscriptNotAvailableLanguageError → no_transcript_available
 *   YoutubeTranscriptTooManyRequestError   → rate_limited  (will be retried)
 *   ResilienceError(code='timeout')        → network        (will be retried)
 *   ResilienceError(code='aborted')        → cancelled      (will NOT be retried)
 *   TypeError/fetch errors                 → network        (will be retried)
 *   everything else                        → parse_error    (NOT retried)
 */
function mapLibError(err: unknown, videoId: string): YoutubeTranscriptError {
  if (err instanceof YoutubeTranscriptVideoUnavailableError) {
    return new YoutubeTranscriptError(
      `YouTube video not found: ${videoId}`,
      'video_not_found',
      videoId,
      err,
    );
  }
  if (
    err instanceof YoutubeTranscriptDisabledError ||
    err instanceof YoutubeTranscriptNotAvailableError ||
    err instanceof YoutubeTranscriptNotAvailableLanguageError
  ) {
    return new YoutubeTranscriptError(
      `No transcript available for ${videoId}: ${(err as Error).message}`,
      'no_transcript_available',
      videoId,
      err,
    );
  }
  if (err instanceof YoutubeTranscriptTooManyRequestError) {
    return new YoutubeTranscriptError(
      `YouTube rate-limited fetching transcript for ${videoId}`,
      'rate_limited',
      videoId,
      err,
    );
  }
  if (err instanceof ResilienceError && err.code === 'aborted') {
    // Caller cancelled the fetch (e.g. SIGTERM, deploy rotation). Do NOT retry —
    // the signal is already fired and every subsequent attempt would fail
    // immediately as well. Surfaced as 'cancelled' so shouldRetryTranscript
    // leaves it alone.
    return new YoutubeTranscriptError(
      `Transcript fetch cancelled for ${videoId}`,
      'cancelled',
      videoId,
      err,
    );
  }
  if (err instanceof ResilienceError) {
    // timeout → transient network issue, will be retried.
    return new YoutubeTranscriptError(
      `Network error fetching transcript for ${videoId}: ${err.message}`,
      'network',
      videoId,
      err,
    );
  }
  // Generic fetch/network failures: ECONNRESET, ETIMEDOUT, TypeError: fetch failed, etc.
  if (err instanceof TypeError || (err instanceof Error && isNetworkError(err))) {
    return new YoutubeTranscriptError(
      `Network error fetching transcript for ${videoId}: ${(err as Error).message}`,
      'network',
      videoId,
      err,
    );
  }
  // Anything else (XML parse failure, unexpected lib shape, etc.)
  return new YoutubeTranscriptError(
    `Parse error fetching transcript for ${videoId}: ${(err as Error)?.message ?? String(err)}`,
    'parse_error',
    videoId,
    err,
  );
}

/** Detect generic network-layer error messages by convention. */
function isNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('socket')
  );
}

/** Determine whether an error is worth retrying. */
function shouldRetryTranscript(err: unknown): boolean {
  if (err instanceof YoutubeTranscriptError) {
    // Only transient errors get retried.
    return err.code === 'network' || err.code === 'rate_limited';
  }
  // Unmapped errors at the retry layer: default to no-retry (safer).
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the auto-captions transcript for a YouTube video.
 * Returns ordered segments with timecodes in seconds.
 * Throws YoutubeTranscriptError on known failure modes.
 *
 * Wraps the underlying lib in:
 *   - timeout (default 30s, configurable per attempt)
 *   - retry with exponential backoff on 'network' and 'rate_limited' (max 3 attempts)
 *   - normalization of segment shape regardless of lib's native XML format
 *
 * @param videoId          YouTube video ID (the `v` param, 11 chars)
 * @param opts.preferredLanguage  ISO code for caption track (default: 'es')
 * @param opts.timeoutMs          Timeout per attempt in ms (default: 30000)
 * @param opts.signal             AbortController signal for cancellation
 */
export async function fetchTranscript(
  videoId: string,
  opts?: {
    preferredLanguage?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Duración en segundos (de YouTube Data API). Si está disponible,
     *  Gemini chunkea por ventanas de 10min para evitar truncation. */
    durationS?: number;
  },
): Promise<TranscriptSegment[]> {
  const lang = opts?.preferredLanguage ?? DEFAULT_LANGUAGE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = `youtube:transcript:${videoId}`;

  // Path primario (mayo 2026): Gemini 2.5 Flash. Si el env GEMINI_TRANSCRIPT_ENABLED
  // está activo, intentamos Gemini primero. Si falla por cualquier razón,
  // caemos al path legacy (lib → yt-dlp) que sigue siendo útil para dev local.
  if (process.env.GEMINI_TRANSCRIPT_ENABLED === 'true') {
    try {
      // Decisión chunked vs single-call:
      //   - Si tenemos durationS > 600 → chunked (mejor calidad, evita
      //     truncation en plenarias largas).
      //   - Si durationS está ausente o es 0 → chunked con UPPER BOUND
      //     (4 h = 14400s). Bug 2026-05-12: cuando YouTube Data API no
      //     devolvía duración, caíamos a single-call y Gemini Flash
      //     truncaba en ~59 min (MAX_TOKENS). Plenarios completos quedaban
      //     cortados. Asumir 4 h y chunkear; los chunks que excedan el
      //     fin real del video devuelven vacío y se descartan sin costo.
      //   - Si durationS <= 600 (clip corto) → single-call (más rápido,
      //     no hay riesgo de truncation).
      const effectiveDuration =
        typeof opts?.durationS === 'number' && opts.durationS > 0
          ? opts.durationS
          : 14_400; // fallback upper bound = 4 h
      const segs =
        effectiveDuration > 600
          ? await fetchTranscriptViaGeminiChunked(videoId, effectiveDuration, {
              signal: opts?.signal,
            })
          : await fetchTranscriptViaGemini(videoId, { signal: opts?.signal });
      const normalized: TranscriptSegment[] = segs.map((s) => ({
        start_seconds: s.start_seconds,
        end_seconds: s.end_seconds,
        text: s.text,
        language: lang,
      }));
      if (normalized.length > 0) {
        logger.info('youtube_transcript_fetched', {
          videoId,
          lang,
          segmentCount: normalized.length,
          source: 'gemini',
        });
        return normalized;
      }
      logger.warn('gemini_transcript_empty_falling_back', { videoId });
    } catch (err) {
      // Cualquier error de Gemini → log + fallback al path legacy.
      logger.warn('gemini_transcript_failed_falling_back', {
        videoId,
        code: err instanceof GeminiTranscriptError ? err.code : 'unknown',
        message: (err as Error)?.message?.slice(0, 200),
      });
    }
  }

  // Single attempt: timeout-wrapped lib call + error mapping.
  // If the npm lib reports `no_transcript_available` for a video that
  // YouTube actually serves an ASR track for (common with the Asamblea
  // plenarios since Google's 2025 timed-text endpoint changes), we fall
  // through to yt-dlp before giving up. yt-dlp is slower (~5-15s per video
  // because it spawns a subprocess + solves JS challenges) but reliable.
  async function attempt(): Promise<TranscriptSegment[]> {
    try {
      const raw = await withTimeout(
        // withTimeout passes its own AbortSignal to the fn. The underlying lib
        // doesn't accept an AbortSignal natively, so we race via the timeout
        // mechanism. The caller's signal is also wired in via withTimeout's opts.
        (_signal) =>
          libFetchTranscript(videoId, { lang }),
        { ms: timeoutMs, label, signal: opts?.signal },
      );
      const segments = normalizeSegments(raw);
      if (segments.length > 0) {
        logger.info('youtube_transcript_fetched', {
          videoId,
          lang,
          segmentCount: segments.length,
          source: 'lib',
        });
        return segments;
      }
      // Lib returned 0 segments — treat as "not available" and try yt-dlp.
      logger.info('youtube_transcript_lib_empty_trying_ytdlp', { videoId });
      return await tryYtDlpFallback(videoId, lang, timeoutMs, opts?.signal);
    } catch (err) {
      const mapped = mapLibError(err, videoId);
      // Only fall through to yt-dlp for the "no transcript available" code.
      // Other failures (network, rate-limited, video-not-found) shouldn't try
      // a second fetcher — the issue is upstream, not lib-specific.
      if (mapped.code === 'no_transcript_available') {
        try {
          return await tryYtDlpFallback(videoId, lang, timeoutMs, opts?.signal);
        } catch (ytErr) {
          // yt-dlp also failed — surface the original lib error so the caller
          // sees the more meaningful error (the lib's diagnostic, not yt-dlp's).
          logger.warn('youtube_transcript_ytdlp_fallback_failed', {
            videoId,
            ytDlpError: (ytErr as Error)?.message?.slice(0, 200),
          });
          throw mapped;
        }
      }
      // Map to our typed error so shouldRetryTranscript can inspect the code.
      throw mapped;
    }
  }

  /**
   * Try yt-dlp as fallback. Returns segments on success, throws on failure.
   * The thrown error is intentionally generic — caller decides how to handle.
   */
  async function tryYtDlpFallback(
    vid: string,
    language: string,
    timeoutMsLocal: number,
    signal?: AbortSignal,
  ): Promise<TranscriptSegment[]> {
    const ytSegs = await fetchTranscriptViaYtDlp(vid, {
      language,
      // Plenarios are long videos; yt-dlp scrape is fast but bumping the
      // timeout to 90s gives generous slack for slow networks / busy CI.
      timeoutMs: Math.max(timeoutMsLocal, 90_000),
      signal,
    });
    const segments: TranscriptSegment[] = ytSegs.map((s) => ({
      start_seconds: s.start_seconds,
      end_seconds: s.end_seconds,
      text: s.text,
      language,
    }));
    logger.info('youtube_transcript_fetched', {
      videoId: vid,
      lang: language,
      segmentCount: segments.length,
      source: 'yt-dlp',
    });
    if (segments.length === 0) {
      // yt-dlp ran but returned 0 segments — same end-state as lib emptiness.
      throw new YoutubeTranscriptError(
        `yt-dlp returned 0 segments for ${vid}`,
        'no_transcript_available',
        vid,
      );
    }
    return segments;
  }
  // Suppress unused-import warning for YtDlpError when this module compiles
  // standalone — the import is meaningful for typed re-export by callers.
  void YtDlpError;

  return withRetry(attempt, {
    attempts: MAX_ATTEMPTS,
    baseDelayMs: BASE_DELAY_MS,
    label,
    shouldRetry: (err, attempt) => {
      const retryable = shouldRetryTranscript(err);
      if (!retryable) {
        logger.warn('youtube_transcript_not_retrying', {
          videoId,
          attempt,
          code: err instanceof YoutubeTranscriptError ? err.code : 'unknown',
          message: (err as Error)?.message,
        });
      }
      return retryable;
    },
  });
}
