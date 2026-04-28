/**
 * Unit tests for youtubeTranscript.ts
 *
 * All tests mock the `youtube-transcript` lib at the import level — we never
 * hit real YouTube in unit tests (would be flaky in CI and create a rate-limit
 * dependency). Integration tests against real videos live in Task 5.
 *
 * Coverage:
 *   - Segment normalization: start_seconds / end_seconds computed correctly
 *   - Millisecond detection heuristic (srv3 format)
 *   - text trimming and whitespace collapse
 *   - Error code mapping: video_not_found, no_transcript_available,
 *     rate_limited, network, parse_error
 *   - Happy path: segments filtered and ordered correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────
// We mock the lib module before importing our service so vi.mock hoisting
// replaces the real implementation. The mock factory returns jest-like vi.fn()
// stubs so each test can set the return value independently.

vi.mock('youtube-transcript', async () => {
  const {
    YoutubeTranscriptTooManyRequestError,
    YoutubeTranscriptVideoUnavailableError,
    YoutubeTranscriptDisabledError,
    YoutubeTranscriptNotAvailableError,
    YoutubeTranscriptNotAvailableLanguageError,
    YoutubeTranscriptError,
  } = await vi.importActual<typeof import('youtube-transcript')>('youtube-transcript');

  return {
    // The real error classes — we need their instanceof checks to work
    YoutubeTranscriptError,
    YoutubeTranscriptTooManyRequestError,
    YoutubeTranscriptVideoUnavailableError,
    YoutubeTranscriptDisabledError,
    YoutubeTranscriptNotAvailableError,
    YoutubeTranscriptNotAvailableLanguageError,
    // The function our service calls — replaced per-test
    fetchTranscript: vi.fn(),
  };
});

// Also mock the logger so tests don't spam stdout
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks are set up
import * as lib from 'youtube-transcript';
import { fetchTranscript, YoutubeTranscriptError } from './youtubeTranscript.js';

const mockLibFetch = lib.fetchTranscript as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal valid segment in classic-XML seconds format. */
function makeSegSec(offset: number, duration: number, text: string) {
  return { text, offset, duration, lang: 'es' };
}

/** A minimal valid segment in srv3 milliseconds format (offset > 100_000). */
function makeSegMs(offsetMs: number, durationMs: number, text: string) {
  return { text, offset: offsetMs, duration: durationMs, lang: 'es' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fetchTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore real timers after each test (fake timers may be set per-test)
    vi.useRealTimers();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('normalizes classic XML (seconds) segments into start_seconds / end_seconds', async () => {
    mockLibFetch.mockResolvedValueOnce([
      makeSegSec(0, 5.12, 'Orden del día'),
      makeSegSec(5.12, 3.0, 'Señores diputados'),
      makeSegSec(8.12, 4.88, 'se abre la sesión'),
    ]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      start_seconds: 0,
      end_seconds: 5.12,
      text: 'Orden del día',
      language: 'es',
    });
    expect(segments[1].start_seconds).toBe(5.12);
    expect(segments[1].end_seconds).toBe(8.12);
    expect(segments[2].end_seconds).toBe(13); // 8.12 + 4.88 = 13.000
  });

  it('detects srv3 milliseconds format (offset > 100_000) and converts to seconds', async () => {
    // srv3 format: offset and duration in ms. The first segment's offset being
    // > 100_000 triggers the milliseconds detection heuristic.
    mockLibFetch.mockResolvedValueOnce([
      makeSegMs(0, 5120, 'Orden del día'),
      makeSegMs(5120, 3000, 'Señores diputados'),
      makeSegMs(120_000, 4880, 'Punto primero del orden'), // offset > 100_000 → triggers ms mode
    ]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');

    expect(segments[2].start_seconds).toBe(120); // 120_000 ms → 120 s
    expect(segments[2].end_seconds).toBe(124.88); // (120_000 + 4_880) / 1000
    expect(segments[0].start_seconds).toBe(0);
    expect(segments[0].end_seconds).toBe(5.12); // 5120 ms → 5.12 s
  });

  it('trims whitespace and collapses newlines in segment text', async () => {
    mockLibFetch.mockResolvedValueOnce([
      makeSegSec(0, 2, '  texto con espacios  '),
      makeSegSec(2, 2, 'línea\ncon salto'),
      makeSegSec(4, 2, 'múltiples   espacios   internos'),
    ]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');

    expect(segments[0].text).toBe('texto con espacios');
    expect(segments[1].text).toBe('línea con salto');
    expect(segments[2].text).toBe('múltiples espacios internos');
  });

  it('filters out empty segments after trimming', async () => {
    mockLibFetch.mockResolvedValueOnce([
      makeSegSec(0, 2, 'texto válido'),
      makeSegSec(2, 1, '   '),    // becomes empty after trim → filtered
      makeSegSec(3, 2, '\n\t'),   // also empty after trim → filtered
      makeSegSec(5, 2, 'otro texto'),
    ]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('texto válido');
    expect(segments[1].text).toBe('otro texto');
  });

  it('passes preferredLanguage option to the lib', async () => {
    mockLibFetch.mockResolvedValueOnce([makeSegSec(0, 1, 'hello')]);

    await fetchTranscript('dQw4w9WgXcQ', { preferredLanguage: 'en' });

    expect(mockLibFetch).toHaveBeenCalledWith('dQw4w9WgXcQ', { lang: 'en' });
  });

  // ── Error mapping ───────────────────────────────────────────────────────────

  it("maps YoutubeTranscriptVideoUnavailableError to code 'video_not_found'", async () => {
    mockLibFetch.mockRejectedValue(new lib.YoutubeTranscriptVideoUnavailableError('dQw4w9WgXcQ'));

    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof YoutubeTranscriptError &&
        e.code === 'video_not_found' &&
        e.videoId === 'dQw4w9WgXcQ',
    );
  });

  it("maps YoutubeTranscriptDisabledError to code 'no_transcript_available'", async () => {
    mockLibFetch.mockRejectedValue(new lib.YoutubeTranscriptDisabledError('dQw4w9WgXcQ'));

    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof YoutubeTranscriptError && e.code === 'no_transcript_available',
    );
  });

  it("maps YoutubeTranscriptNotAvailableError to code 'no_transcript_available'", async () => {
    mockLibFetch.mockRejectedValue(new lib.YoutubeTranscriptNotAvailableError('dQw4w9WgXcQ'));

    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof YoutubeTranscriptError && e.code === 'no_transcript_available',
    );
  });

  it("maps YoutubeTranscriptTooManyRequestError to code 'rate_limited'", async () => {
    // rate_limited is retried up to 3 times — mock it to always fail so we
    // see the final error after all retry attempts are exhausted.
    // Use fake timers so the 2s + 4s backoff delays don't block the test.
    vi.useFakeTimers();
    mockLibFetch.mockRejectedValue(new lib.YoutubeTranscriptTooManyRequestError());

    // Attach the rejection handler immediately so there is no window where
    // the promise is unhandled (fake timers advance synchronously after .catch
    // is registered, which is what avoids the PromiseRejectionHandledWarning).
    let caughtError: unknown;
    const promise = fetchTranscript('dQw4w9WgXcQ').catch((e) => { caughtError = e; });

    // Advance through all retry delays (2s + 4s = 6s total)
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtError).toBeInstanceOf(YoutubeTranscriptError);
    expect((caughtError as YoutubeTranscriptError).code).toBe('rate_limited');
    // Should have been called 3 times (MAX_ATTEMPTS) since rate_limited is retryable
    expect(mockLibFetch).toHaveBeenCalledTimes(3);
  });

  it("maps fetch TypeError to code 'network'", async () => {
    // network is retried — use fake timers for the same reason.
    vi.useFakeTimers();
    mockLibFetch.mockRejectedValue(new TypeError('fetch failed'));

    let caughtError: unknown;
    const promise = fetchTranscript('dQw4w9WgXcQ').catch((e) => { caughtError = e; });

    await vi.runAllTimersAsync();
    await promise;

    expect(caughtError).toBeInstanceOf(YoutubeTranscriptError);
    expect((caughtError as YoutubeTranscriptError).code).toBe('network');
    // network is retried — should attempt 3 times
    expect(mockLibFetch).toHaveBeenCalledTimes(3);
  });

  it("maps unknown errors to code 'parse_error' and does NOT retry", async () => {
    mockLibFetch.mockRejectedValue(new Error('Unexpected JSON shape: missing captionTracks'));

    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof YoutubeTranscriptError && e.code === 'parse_error',
    );
    // parse_error is NOT retried — should only be called once
    expect(mockLibFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves start_seconds to 3 decimal places', async () => {
    // offset = 1.1234567 seconds — should be rounded to 3 decimals
    mockLibFetch.mockResolvedValueOnce([makeSegSec(1.1234567, 2.9876543, 'texto')]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');
    expect(segments[0].start_seconds).toBe(1.123);
    expect(segments[0].end_seconds).toBe(4.111); // 1.1234567 + 2.9876543 = 4.111111... → 4.111
  });

  it('throws code=cancelled and does not retry on aborted signal', async () => {
    // When the caller aborts the signal before or during the fetch, the service
    // should surface code='cancelled' and NOT retry — retrying on a fired signal
    // would fail immediately every time and waste two extra attempts.
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(fetchTranscript('dQw4w9WgXcQ', { signal: ctrl.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    // No retry: lib is called exactly once
    expect(mockLibFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when lib returns no segments', async () => {
    // YouTube sometimes returns [] when auto-captions are not yet generated
    // (typically 1-4h after upload for AsambleaCRC sessions). This is not an
    // error — callers must check for empty and re-queue after a delay.
    mockLibFetch.mockResolvedValueOnce([]);

    const segments = await fetchTranscript('dQw4w9WgXcQ');
    expect(segments).toEqual([]);
  });
});
