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
  },
): Promise<TranscriptSegment[]> {
  const lang = opts?.preferredLanguage ?? DEFAULT_LANGUAGE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = `youtube:transcript:${videoId}`;

  // Single attempt: timeout-wrapped lib call + error mapping
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
      logger.info('youtube_transcript_fetched', {
        videoId,
        lang,
        segmentCount: segments.length,
      });
      return segments;
    } catch (err) {
      // Map to our typed error so shouldRetryTranscript can inspect the code.
      throw mapLibError(err, videoId);
    }
  }

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
