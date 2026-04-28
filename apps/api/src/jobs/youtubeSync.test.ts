/**
 * Unit tests for youtubeSync.ts — Task 3, Fase 0.
 *
 * All HTTP calls (YouTube Data API v3) are intercepted via vi.stubGlobal on
 * the global `fetch`. The supabase client is mocked via a module-level factory
 * so we never hit a real DB.
 *
 * Coverage:
 *   1. 3 videos returned, 1 already in sessions → {found:3, new:2, skipped:1, errors:0}
 *   2. Title parsing failure → inserts with metadata.parsed:null, errors counter increments
 *      (parse failure alone does NOT increment errors — only DB/network failures do)
 *   3. dryRun=true → no inserts, returns the diff
 *   4. YOUTUBE_API_KEY missing → throws with clear error message
 *   5. Title parser unit tests (fecha, comision, tipo, sesion_num extraction)
 *   6. Channel ID resolution is cached across calls
 *   7. YouTube API 4xx → throws immediately (no retry), error propagates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Supabase mock setup ───────────────────────────────────────────────────────
// We mock the supabase-js module before any import of the job module.
// The mock creates a controllable chain builder that records calls.
//
// Pattern: vi.mock hoisting ensures the mock replaces the real module before
// the job module is loaded. We expose _mockSupaChain so individual tests can
// set return values for .select(), .in(), .insert(), etc.

type MockResult = { data: unknown; error: unknown };

// Tracks what .insert() was called with so tests can assert on it
const _insertCalls: unknown[] = [];
let _selectResult: MockResult = { data: [], error: null };
let _insertResult: MockResult = { data: [{ id: 'new-session-uuid' }], error: null };

vi.mock('@supabase/supabase-js', () => {
  function buildChain(overrides: Partial<Record<string, () => unknown>> = {}) {
    // The supabase query builder is a fluent chain. We build a proxy that
    // returns itself for every method except the terminal ones (.single(),
    // implicit awaits) that resolve with data/error.
    const chain: Record<string, (...args: unknown[]) => unknown> = {
      from:   () => chain,
      select: () => chain,
      insert: (row: unknown) => {
        _insertCalls.push(row);
        return chain;
      },
      in:     () => chain,
      single: () => Promise.resolve(_insertResult),
      // Make the chain itself thenable (for await supa().from(...).select(...).in(...))
      then:   (...args: unknown[]) =>
                Promise.resolve(_selectResult).then(args[0] as Parameters<Promise<MockResult>['then']>[0]),
      catch:  (...args: unknown[]) =>
                Promise.resolve(_selectResult).catch(args[0] as Parameters<Promise<MockResult>['catch']>[0]),
      ...overrides,
    };
    return chain;
  }

  return {
    createClient: () => buildChain(),
  };
});

// Also mock the logger to suppress noise
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import subject under test ─────────────────────────────────────────────────
// Must come AFTER vi.mock() calls due to hoisting semantics.
import { syncYoutubeChannel, _parseTitleMeta, _channelIdCache } from './youtubeSync.js';

// ── YouTube API mock helpers ──────────────────────────────────────────────────

/** Build a minimal YouTubeSearchItem fixture. */
function makeVideo(videoId: string, title: string, publishedAt = '2026-04-24T10:00:00Z') {
  return {
    id: { videoId },
    snippet: {
      publishedAt,
      title,
      description: '',
      channelId: 'UCtest123',
    },
  };
}

/** Build a mock YouTube channels.list response (resolves handle → channelId). */
function channelResponse(channelId: string) {
  return {
    items: [{ id: channelId }],
    pageInfo: { totalResults: 1, resultsPerPage: 1 },
  };
}

/** Build a mock YouTube search.list response. */
function searchResponse(videos: ReturnType<typeof makeVideo>[]) {
  return {
    items: videos,
    pageInfo: { totalResults: videos.length, resultsPerPage: 50 },
  };
}

/**
 * Wire up a global fetch mock that handles YouTube API calls.
 *
 * The mock dispatches on the URL prefix:
 *   /channels → returns channelRes
 *   /search   → returns searchRes
 *
 * Returns a vi.fn() so tests can assert call count if needed.
 */
function mockYouTubeFetch(
  channelRes: object,
  searchRes: object,
): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/channels')) {
      return {
        ok: true,
        json: async () => channelRes,
        text: async () => JSON.stringify(channelRes),
      };
    }
    if (urlStr.includes('/search')) {
      return {
        ok: true,
        json: async () => searchRes,
        text: async () => JSON.stringify(searchRes),
      };
    }
    throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
  });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('syncYoutubeChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertCalls.length = 0;
    _selectResult = { data: [], error: null };
    _insertResult = { data: [{ id: 'new-session-uuid' }], error: null };
    // Clear the channel ID cache so each test starts clean
    _channelIdCache.clear();
    // Provide required env vars
    process.env.YOUTUBE_API_KEY = 'test-api-key';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YOUTUBE_API_KEY;
  });

  // ── Test 1: Happy path — 3 videos, 1 existing ───────────────────────────────
  it('returns {found:3, new:2, skipped:1, errors:0} when 1 of 3 videos already exists', async () => {
    const videos = [
      makeVideo('vid001', 'Sesión Plenaria N°47 - 24 de Abril de 2026'),
      makeVideo('vid002', 'Comisión de Hacienda - 22/04/2026'),
      makeVideo('vid003', 'Sesión Plenaria N°46 - 19 de Abril de 2026'),
    ];

    // vid002 already exists in sessions
    _selectResult = { data: [{ youtube_video_id: 'vid002' }], error: null };

    mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse(videos));

    const result = await syncYoutubeChannel({ daysBack: 7 });

    expect(result.found).toBe(3);
    expect(result.new).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.videoIds.new).toEqual(expect.arrayContaining(['vid001', 'vid003']));
    expect(result.videoIds.skipped).toEqual(['vid002']);
    expect(result.videoIds.errored).toHaveLength(0);

    // Two inserts should have been made (for vid001 and vid003)
    expect(_insertCalls).toHaveLength(2);
  });

  // ── Test 2: Title parse failure → inserts with parsed:null ──────────────────
  it('inserts with metadata.parsed=null when title cannot be parsed, errors counter NOT incremented', async () => {
    // A title that matches none of our regex patterns
    const videos = [
      makeVideo('vid999', 'Transmisión en vivo - evento especial'),
    ];

    _selectResult = { data: [], error: null };
    mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse(videos));

    const result = await syncYoutubeChannel();

    // The video is inserted (not skipped), but with no structured parse data
    expect(result.found).toBe(1);
    expect(result.new).toBe(1);
    expect(result.errors).toBe(0); // parse failure ≠ error; DB failure = error
    expect(result.videoIds.new).toEqual(['vid999']);

    // Inspect the inserted row
    expect(_insertCalls).toHaveLength(1);
    const inserted = _insertCalls[0] as Record<string, unknown>;
    expect(inserted.youtube_video_id).toBe('vid999');
    expect(inserted.status).toBe('pending');
    expect(inserted.source).toBe('youtube');
    expect(inserted.fecha).toBeNull();
    expect(inserted.comision).toBeNull();
    expect(inserted.tipo).toBeNull();
    const metadata = inserted.metadata as Record<string, unknown>;
    expect(metadata.raw_title).toBe('Transmisión en vivo - evento especial');
    expect(metadata.parsed).toBeNull();
  });

  // ── Test 3: Title parse failure increments errors only on DB failure ─────────
  it('increments errors counter when DB insert fails (not on parse miss)', async () => {
    const videos = [
      makeVideo('vid-fail', 'Sesión Plenaria N°50 - 24 de Abril de 2026'),
    ];

    _selectResult = { data: [], error: null };
    // Simulate DB insert failure
    _insertResult = { data: null, error: { message: 'unique violation' } };

    mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse(videos));

    const result = await syncYoutubeChannel();

    expect(result.found).toBe(1);
    expect(result.new).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.videoIds.errored).toHaveLength(1);
    expect(result.videoIds.errored[0].videoId).toBe('vid-fail');
    expect(result.videoIds.errored[0].error).toContain('unique violation');
  });

  // ── Test 4: dryRun=true → no inserts ────────────────────────────────────────
  it('does not insert when dryRun=true, but reports the correct diff', async () => {
    const videos = [
      makeVideo('vid-a', 'Sesión Plenaria N°47 - 24 de Abril de 2026'),
      makeVideo('vid-b', 'Comisión de Hacienda - 22/04/2026'),
    ];

    // vid-a already exists
    _selectResult = { data: [{ youtube_video_id: 'vid-a' }], error: null };

    mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse(videos));

    const result = await syncYoutubeChannel({ dryRun: true });

    expect(result.found).toBe(2);
    expect(result.new).toBe(1);     // would have inserted 1
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.videoIds.new).toEqual(['vid-b']);
    expect(result.videoIds.skipped).toEqual(['vid-a']);

    // Critical: no inserts happened
    expect(_insertCalls).toHaveLength(0);
  });

  // ── Test 5: YOUTUBE_API_KEY missing → throws ─────────────────────────────────
  it('throws a clear error when YOUTUBE_API_KEY is not set', async () => {
    delete process.env.YOUTUBE_API_KEY;

    await expect(syncYoutubeChannel()).rejects.toThrow('YOUTUBE_API_KEY env var is not set');
  });

  // ── Test 6: Channel ID is cached across calls ─────────────────────────────────
  it('resolves channel ID once and caches it for subsequent calls', async () => {
    const videos = [makeVideo('vid001', 'Sesión Plenaria N°47 - 24 de Abril de 2026')];
    _selectResult = { data: [], error: null };

    const mockFetch = mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse(videos));

    // First call
    await syncYoutubeChannel({ channelHandle: '@AsambleCached' });
    const allCalls1 = (mockFetch as ReturnType<typeof vi.fn>).mock.calls;
    const firstCallCount = allCalls1.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('/channels'),
    ).length;

    // Reset insert tracking but keep the cache intact
    _insertCalls.length = 0;
    _selectResult = { data: [], error: null };

    // Second call — channel ID should come from cache, not API
    await syncYoutubeChannel({ channelHandle: '@AsambleCached' });
    const allCalls2 = (mockFetch as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallCount = allCalls2.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('/channels'),
    ).length;

    // channels endpoint called exactly once across both sync runs
    expect(firstCallCount).toBe(1);
    expect(secondCallCount).toBe(1);  // no additional channels call on second run
  });

  // ── Test 7: Zero videos returned ────────────────────────────────────────────
  it('returns all-zero result when YouTube API returns no videos', async () => {
    mockYouTubeFetch(channelResponse('UCcr-canal'), searchResponse([]));

    const result = await syncYoutubeChannel();

    expect(result.found).toBe(0);
    expect(result.new).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    // No DB queries needed when there are no videos
    expect(_insertCalls).toHaveLength(0);
  });

  // ── Test 8: YouTube API 4xx → throws without retrying ───────────────────────
  it('throws when YouTube API returns 403 (quota exceeded)', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"error":{"code":403,"message":"quotaExceeded"}}',
      json: async () => ({ error: { code: 403, message: 'quotaExceeded' } }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(syncYoutubeChannel()).rejects.toThrow('YouTube API 403');

    // 4xx should NOT be retried — fetch called only once per endpoint
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Title parser unit tests ───────────────────────────────────────────────────

describe('_parseTitleMeta', () => {
  it('parses "DD de Mes de YYYY" date format', () => {
    const r = _parseTitleMeta('Sesión Plenaria N°47 - 24 de Febrero de 2026');
    expect(r.fecha).toBe('2026-02-24');
  });

  it('parses "DD/MM/YYYY" date format', () => {
    const r = _parseTitleMeta('Comisión de Hacienda - 24/04/2026');
    expect(r.fecha).toBe('2026-04-24');
  });

  it('extracts tipo=plenario', () => {
    const r = _parseTitleMeta('Sesión Plenaria N°47 - 24 de Abril de 2026');
    expect(r.tipo).toBe('plenario');
  });

  it('extracts tipo=extraordinaria (wins over plenaria)', () => {
    const r = _parseTitleMeta('Sesión Extraordinaria Plenaria N°12 - 15 de Enero de 2026');
    expect(r.tipo).toBe('extraordinaria');
  });

  it('extracts tipo=comision from "Comisión de ..." title', () => {
    const r = _parseTitleMeta('Comisión de Hacienda - 24/04/2026');
    expect(r.tipo).toBe('comision');
  });

  it('extracts comision name from "Comisión de Hacienda"', () => {
    const r = _parseTitleMeta('Comisión de Hacienda y Presupuesto Nacional - 24/04/2026');
    expect(r.comision).toBe('Hacienda y Presupuesto Nacional');
  });

  it('extracts sesion_num', () => {
    const r = _parseTitleMeta('Sesión Plenaria N°47 - 24 de Abril de 2026');
    expect(r.sesion_num).toBe(47);
  });

  it('returns all nulls for unrecognized title', () => {
    const r = _parseTitleMeta('Transmisión en vivo — evento especial');
    expect(r.fecha).toBeNull();
    expect(r.comision).toBeNull();
    expect(r.tipo).toBeNull();
    expect(r.sesion_num).toBeNull();
  });

  it('handles Spanish month names case-insensitively', () => {
    expect(_parseTitleMeta('Sesión - 1 de ENERO de 2026').fecha).toBe('2026-01-01');
    expect(_parseTitleMeta('Sesión - 15 de Diciembre de 2025').fecha).toBe('2025-12-15');
    expect(_parseTitleMeta('Sesión - 3 de Setiembre de 2026').fecha).toBe('2026-09-03');
  });
});
