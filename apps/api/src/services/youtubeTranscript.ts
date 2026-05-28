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

// Quality thresholds (override via env vars)
const MIN_WORDS_PER_MINUTE = Number(process.env.TRANSCRIPT_MIN_WORDS_PER_MINUTE ?? 30);
const MAX_GARBAGE_RATIO = Number(process.env.TRANSCRIPT_MAX_GARBAGE_RATIO ?? 0.30);

// Fetch strategy: comma-ordered list of sources to try.
//   ytdlp  = yt-dlp subprocess (most reliable for Spanish auto-captions)
//   gemini = Gemini 2.5 Flash/Pro (works from Cloud Run, but quality varies)
//   lib    = youtube-transcript npm library (fast, no subprocess)
// Default puts yt-dlp first because it produces cleaner transcripts for
// legislative Spanish. In production (Cloud Run) yt-dlp may be blocked
// by bot detection; if so it fails fast and we fall back to gemini.
const DEFAULT_STRATEGY = 'ytdlp,gemini,lib';

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
  | 'cancelled'
  | 'quality_rejected';

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

export interface TranscriptQualityMetrics {
  wordCount: number;
  garbageCount: number;
  garbageRatio: number;
  wordsPerMinute: number;
  segmentCount: number;
  durationMinutes: number;
}

export interface TranscriptQualityResult {
  valid: boolean;
  reason?: string;
  metrics: TranscriptQualityMetrics;
}

// ── Quality validation ────────────────────────────────────────────────────────

const GARBAGE_RE = /\[(conversaciones superpuestas|inaudible|música|silencio)\]/i;

/**
 * Validate transcript quality after fetching from any source.
 * Rejects transcripts that are mostly garbage markers or have
 * implausibly low word density for the video duration.
 */
export function validateTranscriptQuality(
  segments: TranscriptSegment[],
  durationS?: number,
): TranscriptQualityResult {
  const totalText = segments.map((s) => s.text).join(' ');
  const words = totalText.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const garbageCount = segments.filter((s) => GARBAGE_RE.test(s.text)).length;
  const segmentCount = segments.length;
  const durationMinutes = durationS && durationS > 0 ? durationS / 60 : 0;
  const wordsPerMinute = durationMinutes > 0 ? wordCount / durationMinutes : 0;
  const garbageRatio = segmentCount > 0 ? garbageCount / segmentCount : 0;

  const metrics: TranscriptQualityMetrics = {
    wordCount,
    garbageCount,
    garbageRatio,
    wordsPerMinute,
    segmentCount,
    durationMinutes,
  };

  if (durationMinutes > 0 && wordsPerMinute < MIN_WORDS_PER_MINUTE) {
    return {
      valid: false,
      reason: `words/min too low: ${wordsPerMinute.toFixed(1)} < ${MIN_WORDS_PER_MINUTE} (words=${wordCount}, duration=${durationMinutes.toFixed(0)}min)`,
      metrics,
    };
  }

  if (garbageRatio > MAX_GARBAGE_RATIO) {
    return {
      valid: false,
      reason: `garbage ratio too high: ${(garbageRatio * 100).toFixed(1)}% > ${(MAX_GARBAGE_RATIO * 100).toFixed(0)}% (garbage=${garbageCount}/${segmentCount})`,
      metrics,
    };
  }

  return { valid: true, metrics };
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

// ── Strategy fetchers ─────────────────────────────────────────────────────────

async function fetchViaYtDlp(
  videoId: string,
  lang: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const ytSegs = await fetchTranscriptViaYtDlp(videoId, {
    language: lang,
    timeoutMs: Math.max(timeoutMs, 90_000),
    signal,
  });
  return ytSegs.map((s) => ({
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
    text: s.text,
    language: lang,
  }));
}

async function fetchViaGemini(
  videoId: string,
  lang: string,
  durationS: number,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const effectiveDuration =
    typeof durationS === 'number' && durationS > 0 ? durationS : 14_400;
  const segs =
    effectiveDuration > 600
      ? await fetchTranscriptViaGeminiChunked(videoId, effectiveDuration, { signal })
      : await fetchTranscriptViaGemini(videoId, { signal });
  return segs.map((s) => ({
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
    text: s.text,
    language: lang,
  }));
}

async function fetchViaLib(
  videoId: string,
  lang: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const raw = await withTimeout(
    (_signal) => libFetchTranscript(videoId, { lang }),
    { ms: timeoutMs, label: `youtube:transcript:${videoId}`, signal },
  );
  return normalizeSegments(raw);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the auto-captions transcript for a YouTube video.
 * Returns ordered segments with timecodes in seconds.
 * Throws YoutubeTranscriptError on known failure modes.
 *
 * Strategy (configurable via TRANSCRIPT_FETCH_STRATEGY env var):
 *   1. Try each source in order (ytdlp → gemini → lib by default)
 *   2. After each fetch, validate transcript quality
 *   3. If quality passes, return immediately
 *   4. If quality fails, log metrics and try next source
 *   5. If all sources exhausted, throw no_transcript_available
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
 * @param opts.durationS          Video duration in seconds (for quality gates)
 */
export async function fetchTranscript(
  videoId: string,
  opts?: {
    preferredLanguage?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Duración en segundos (de YouTube Data API). Usada para quality gates. */
    durationS?: number;
  },
): Promise<TranscriptSegment[]> {
  const lang = opts?.preferredLanguage ?? DEFAULT_LANGUAGE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const durationS = opts?.durationS;
  const label = `youtube:transcript:${videoId}`;

  // Parse strategy from env (default: ytdlp first, then gemini, then lib)
  const strategyRaw = process.env.TRANSCRIPT_FETCH_STRATEGY ?? DEFAULT_STRATEGY;
  const strategies = strategyRaw
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ['ytdlp', 'gemini', 'lib'].includes(s));

  if (strategies.length === 0) {
    throw new YoutubeTranscriptError(
      `Invalid TRANSCRIPT_FETCH_STRATEGY: "${strategyRaw}"`,
      'parse_error',
      videoId,
    );
  }

  const qualityFailures: Array<{ source: string; reason: string; metrics: TranscriptQualityMetrics }> = [];

  for (const strategy of strategies) {
    try {
      let segments: TranscriptSegment[] = [];

      if (strategy === 'ytdlp') {
        segments = await fetchViaYtDlp(videoId, lang, timeoutMs, opts?.signal);
      } else if (strategy === 'gemini') {
        // Gemini requires explicit opt-in via GEMINI_TRANSCRIPT_ENABLED
        if (process.env.GEMINI_TRANSCRIPT_ENABLED !== 'true') {
          logger.info('youtube_transcript_gemini_skipped_disabled', { videoId });
          continue;
        }
        segments = await fetchViaGemini(videoId, lang, durationS ?? 0, opts?.signal);
      } else if (strategy === 'lib') {
        segments = await fetchViaLib(videoId, lang, timeoutMs, opts?.signal);
      }

      if (segments.length === 0) {
        logger.warn('youtube_transcript_source_empty', { videoId, source: strategy });
        continue;
      }

      // Quality gate
      const quality = validateTranscriptQuality(segments, durationS);
      if (quality.valid) {
        logger.info('youtube_transcript_fetched', {
          videoId,
          lang,
          segmentCount: segments.length,
          source: strategy,
          wordsPerMinute: quality.metrics.wordsPerMinute.toFixed(1),
          garbageRatio: (quality.metrics.garbageRatio * 100).toFixed(1),
        });
        return segments;
      }

      // Quality failed — record and try next source
      qualityFailures.push({ source: strategy, reason: quality.reason!, metrics: quality.metrics });
      logger.warn('youtube_transcript_quality_rejected', {
        videoId,
        source: strategy,
        reason: quality.reason,
        wordsPerMinute: quality.metrics.wordsPerMinute.toFixed(1),
        garbageRatio: (quality.metrics.garbageRatio * 100).toFixed(1),
        wordCount: quality.metrics.wordCount,
      });
    } catch (err) {
      // Log source failure but continue to next strategy
      const isGeminiErr = err instanceof GeminiTranscriptError;
      const isYtDlpErr = err instanceof YtDlpError;
      logger.warn('youtube_transcript_source_failed', {
        videoId,
        source: strategy,
        code: isGeminiErr ? err.code : isYtDlpErr ? err.code : 'unknown',
        message: (err as Error)?.message?.slice(0, 200),
      });
    }
  }

  // All strategies exhausted
  const failureSummary = qualityFailures
    .map((f) => `${f.source}: ${f.reason}`)
    .join('; ');

  // If at least one source returned segments but they all failed quality gates,
  // we use 'quality_rejected' so the caller can mark the session as broken
  // instead of retrying indefinitely.
  const anySourceReturnedSegments = qualityFailures.length > 0;
  throw new YoutubeTranscriptError(
    `All transcript sources failed for ${videoId}. ${failureSummary}`,
    anySourceReturnedSegments ? 'quality_rejected' : 'no_transcript_available',
    videoId,
  );
}
