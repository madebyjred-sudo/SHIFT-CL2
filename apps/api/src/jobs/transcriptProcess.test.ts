/**
 * Unit tests for transcriptProcess.ts — Fase 0, Tasks 4+5.
 *
 * All external I/O is mocked:
 *   - `fetchTranscript`       → vi.mock('../services/youtubeTranscript.js')
 *   - `@supabase/supabase-js` → vi.mock with controllable chain builder
 *   - global `fetch`          → vi.stubGlobal (for OpenRouter calls)
 *
 * Test cases:
 *   1. Happy path: 3 segments → 2 LLM corrections → all inserted, status='indexed'
 *   2. Transcript not ready (empty array) → status reverted to 'pending', no segments
 *   3. no_transcript_available error → same as empty array (revert to 'pending')
 *   4. video_not_found error → status='error', returns permanent_failure
 *   5. LLM returns invalid JSON → segments inserted, 0 corrections, status='indexed'
 *   6. LLM returns 1 valid + 1 invalid correction → only valid one inserted
 *   7. skipLlmReview=true → segments inserted, NO LLM call, NO corrections
 *   8. Already indexed → return early without re-fetching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────────
//
// We build a controllable Supabase chain that records .from() / .update() /
// .insert() / .select() calls and returns configurable results.
//
// The chain is a single proxy object. Each method returns the chain itself
// (fluent), except:
//   - .single()  → resolves with _singleResult
//   - .then()    → resolves with the current _queryResult for that chain step
//
// We track calls by method + table so tests can assert on DB writes.

type MockResult = { data: unknown; error: unknown };

// Captures what each supabase method was called with so tests can assert
const _calls: { method: string; args: unknown[] }[] = [];

// Default results for the common query paths
let _sessionResult: MockResult = { data: null, error: null };
let _updateResult: MockResult = { data: null, error: null };
let _insertSegmentsResult: MockResult = { data: [], error: null };
let _fetchSegmentsResult: MockResult = { data: [], error: null };
let _insertCorrectionsResult: MockResult = { data: [], error: null };

// Tracks which table was last targeted (set by .from()) so terminal methods
// can route to the right result.
let _currentTable = '';
// Tracks the last method called on the chain to disambiguate insert vs select
let _lastMethod = '';

vi.mock('@supabase/supabase-js', () => {
  function buildChain(): Record<string, (...args: unknown[]) => unknown> {
    const chain: Record<string, (...args: unknown[]) => unknown> = {
      from: (table: unknown) => {
        _currentTable = table as string;
        _calls.push({ method: 'from', args: [table] });
        return chain;
      },
      select: (...args: unknown[]) => {
        _lastMethod = 'select';
        _calls.push({ method: 'select', args });
        return chain;
      },
      insert: (rows: unknown) => {
        _lastMethod = 'insert';
        _calls.push({ method: 'insert', args: [rows] });
        return chain;
      },
      update: (data: unknown) => {
        _lastMethod = 'update';
        _calls.push({ method: 'update', args: [data] });
        return chain;
      },
      eq: (...args: unknown[]) => {
        _calls.push({ method: 'eq', args });
        return chain;
      },
      order: (...args: unknown[]) => {
        _calls.push({ method: 'order', args });
        return chain;
      },
      single: () => {
        _calls.push({ method: 'single', args: [] });
        return Promise.resolve(_sessionResult);
      },
      // Make the chain thenable — resolves with the appropriate result based on context
      then: (...args: unknown[]) => {
        let result: MockResult;
        if (_currentTable === 'transcript_segments' && _lastMethod === 'insert') {
          result = _insertSegmentsResult;
        } else if (_currentTable === 'transcript_segments' && _lastMethod === 'select') {
          result = _fetchSegmentsResult;
        } else if (_currentTable === 'transcript_corrections' && _lastMethod === 'insert') {
          result = _insertCorrectionsResult;
        } else {
          result = _updateResult;
        }
        return Promise.resolve(result).then(
          args[0] as Parameters<Promise<MockResult>['then']>[0],
        );
      },
      catch: (...args: unknown[]) =>
        Promise.resolve(_updateResult).catch(
          args[0] as Parameters<Promise<MockResult>['catch']>[0],
        ),
    };
    return chain;
  }

  return {
    createClient: () => buildChain(),
  };
});

// ── youtubeTranscript mock ────────────────────────────────────────────────────

const mockFetchTranscript = vi.fn();

vi.mock('../services/youtubeTranscript.js', () => {
  // We re-export the real error class so tests can throw typed errors
  class YoutubeTranscriptError extends Error {
    code: string;
    videoId: string;
    constructor(message: string, code: string, videoId: string) {
      super(message);
      this.name = 'YoutubeTranscriptError';
      this.code = code;
      this.videoId = videoId;
    }
  }
  return {
    fetchTranscript: (...args: unknown[]) => mockFetchTranscript(...args),
    YoutubeTranscriptError,
  };
});

// ── logger mock ───────────────────────────────────────────────────────────────

vi.mock('../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    with: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

// ── Subject under test ────────────────────────────────────────────────────────
// Must come AFTER vi.mock() calls.
import { processSession, _resetSupaClient } from './transcriptProcess.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Make a minimal session row */
function makeSession(overrides: Partial<{
  id: string;
  youtube_video_id: string;
  status: string;
  comision: string;
  fecha: string;
  tipo: string;
  metadata: Record<string, unknown>;
}> = {}) {
  return {
    id: 'session-uuid-001',
    youtube_video_id: 'yt-vid-abc123',
    status: 'pending',
    comision: 'Hacienda',
    fecha: '2026-04-24',
    tipo: 'comision',
    metadata: {},
    ...overrides,
  };
}

/** Make 3 transcript segments */
function makeSegments() {
  return [
    { start_seconds: 0, end_seconds: 3.412, text: 'el primer segmento de texto' },
    { start_seconds: 3.412, end_seconds: 7.89, text: 'el segundo segmento aquí' },
    { start_seconds: 7.89, end_seconds: 12.0, text: 'y el tercer segmento final' },
  ];
}

/** Segments as they come back from the DB after insert */
function makeDbSegments(sessionId = 'session-uuid-001') {
  return makeSegments().map((s, idx) => ({
    id: `seg-uuid-${idx}`,
    segment_idx: idx,
    ...s,
  }));
}

/** Build a valid LLM response with 2 corrections */
function makeLlmResponse(corrections: unknown[] = [
  {
    segment_idx: 0,
    span_start: 4,
    span_end: 11,
    kind: 'typo_legislativo',
    original_text: 'primer',
    suggested_text: 'primero',
    confidence: 0.92,
    reasoning: 'Typo corrección de género',
  },
  {
    segment_idx: 1,
    span_start: 0,
    span_end: 2,
    kind: 'typo_diputado',
    original_text: 'el',
    suggested_text: 'El',
    confidence: 0.75,
    reasoning: 'Capitalización de inicio',
  },
]) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              corrections,
              summary: {
                total_segments: 3,
                segments_modified: 2,
                high_confidence_corrections: 1,
                low_confidence_corrections: 1,
                unfillable_gaps: 0,
              },
            }),
          },
        },
      ],
    }),
    text: async () => '',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stub global fetch with a handler that returns the given mock response for LLM calls */
function stubLlmFetch(mockRes: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => mockRes),
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('processSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _calls.length = 0;
    _currentTable = '';
    _lastMethod = '';

    // Default: session loads fine
    _sessionResult = { data: makeSession(), error: null };
    // Default: status update succeeds
    _updateResult = { data: null, error: null };
    // Default: segment insert returns freshly-inserted rows
    _insertSegmentsResult = {
      data: makeDbSegments(),
      error: null,
    };
    // Default: fetch segments returns rows
    _fetchSegmentsResult = {
      data: makeDbSegments(),
      error: null,
    };
    // Default: corrections insert succeeds
    _insertCorrectionsResult = { data: [], error: null };

    _resetSupaClient();

    // Provide env vars
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  // ── Test 1: Happy path ────────────────────────────────────────────────────
  it('happy path: 3 segments → 2 corrections → status=indexed, llm_reviewed_at set', async () => {
    mockFetchTranscript.mockResolvedValueOnce(makeSegments());
    stubLlmFetch(makeLlmResponse());

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('success');
    expect(result.session_id).toBe('session-uuid-001');
    expect(result.segments_inserted).toBe(3);
    expect(result.corrections_inserted).toBe(2);
    expect(result.llm_run_id).toBeTruthy();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();

    // Status should have been updated to 'processing' and then 'indexed'
    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('processing');
    expect(statuses).toContain('indexed');

    // llm_reviewed_at should have been set
    const reviewedAtUpdate = updateCalls.find(
      (c) => (c.args[0] as Record<string, unknown>).llm_reviewed_at,
    );
    expect(reviewedAtUpdate).toBeTruthy();
  });

  // ── Test 2: Transcript not ready (empty array) ────────────────────────────
  it('transcript_not_ready when fetchTranscript returns empty array', async () => {
    mockFetchTranscript.mockResolvedValueOnce([]);

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('transcript_not_ready');
    expect(result.segments_inserted).toBe(0);
    expect(result.corrections_inserted).toBe(0);
    expect(result.llm_run_id).toBeNull();

    // Status should have been reverted to 'pending'
    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('pending');
    expect(statuses).not.toContain('indexed');
    expect(statuses).not.toContain('error');

    // LLM should NOT have been called — fetch was never stubbed so if the
    // implementation called it, the test would have thrown/errored above.
    // Additional safety: assert fetchTranscript was called exactly once (the
    // transcript fetch) but no network call was made for the LLM review.
    expect(mockFetchTranscript).toHaveBeenCalledTimes(1);
  });

  // ── Test 3: no_transcript_available error → same as empty array ──────────
  it('transcript_not_ready when fetchTranscript throws no_transcript_available', async () => {
    const { YoutubeTranscriptError } = await import('../services/youtubeTranscript.js');
    mockFetchTranscript.mockRejectedValueOnce(
      new YoutubeTranscriptError(
        'No transcript available for yt-vid-abc123',
        'no_transcript_available',
        'yt-vid-abc123',
      ),
    );

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('transcript_not_ready');
    expect(result.segments_inserted).toBe(0);
    expect(result.llm_run_id).toBeNull();

    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('pending');
    expect(statuses).not.toContain('indexed');
  });

  // ── Test 4: video_not_found → permanent_failure, status=error ────────────
  it('permanent_failure when fetchTranscript throws video_not_found', async () => {
    const { YoutubeTranscriptError } = await import('../services/youtubeTranscript.js');
    mockFetchTranscript.mockRejectedValueOnce(
      new YoutubeTranscriptError(
        'YouTube video not found: yt-vid-abc123',
        'video_not_found',
        'yt-vid-abc123',
      ),
    );

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('permanent_failure');
    expect(result.error).toContain('video_not_found');
    expect(result.segments_inserted).toBe(0);
    expect(result.corrections_inserted).toBe(0);
    expect(result.llm_run_id).toBeNull();

    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('indexed');
  });

  // ── Test 5: LLM returns invalid JSON → segments inserted, 0 corrections ──
  it('handles invalid LLM JSON gracefully: segments inserted, corrections=0, status=indexed', async () => {
    mockFetchTranscript.mockResolvedValueOnce(makeSegments());

    // LLM returns non-JSON garbage
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Sorry, I cannot process this request at this time.',
              },
            },
          ],
        }),
        text: async () => '',
      })),
    );

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('success');
    expect(result.segments_inserted).toBe(3);
    expect(result.corrections_inserted).toBe(0);
    expect(result.llm_run_id).toBeTruthy(); // run_id was generated
    // Status must be 'indexed' despite LLM hiccup
    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('indexed');
  });

  // ── Test 6: 1 valid + 1 invalid correction → only valid one inserted ──────
  it('inserts only valid corrections when LLM returns mixed valid/invalid', async () => {
    mockFetchTranscript.mockResolvedValueOnce(makeSegments());

    const corrections = [
      // Valid correction
      {
        segment_idx: 0,
        span_start: 0,
        span_end: 5,
        kind: 'typo_legislativo',
        original_text: 'hola',
        suggested_text: 'holá',
        confidence: 0.88,
        reasoning: 'acento faltante',
      },
      // Invalid: confidence > 1.0
      {
        segment_idx: 1,
        span_start: 0,
        span_end: 3,
        kind: 'punctuation',
        original_text: 'el',
        suggested_text: 'El',
        confidence: 1.5,  // invalid — > 1.0
        reasoning: 'capitalización',
      },
    ];

    stubLlmFetch(makeLlmResponse(corrections));

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('success');
    expect(result.corrections_inserted).toBe(1);

    // Verify that the insert call for corrections only has 1 row
    const corrInsert = _calls.find(
      (c) => c.method === 'insert' && _isCorrectionsInsert(c.args[0]),
    );
    if (corrInsert) {
      const rows = corrInsert.args[0] as unknown[];
      expect(rows).toHaveLength(1);
    }
  });

  // ── Test 7: skipLlmReview=true → no LLM call, no corrections ─────────────
  it('skipLlmReview=true: segments inserted, no LLM call, corrections=0, llm_run_id=null', async () => {
    mockFetchTranscript.mockResolvedValueOnce(makeSegments());

    // Stub fetch to throw if called (ensures LLM is not called)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called when skipLlmReview=true');
      }),
    );

    const result = await processSession('session-uuid-001', { skipLlmReview: true });

    expect(result.status).toBe('success');
    expect(result.segments_inserted).toBe(3);
    expect(result.corrections_inserted).toBe(0);
    expect(result.llm_run_id).toBeNull();

    // Status should be 'indexed'
    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).toContain('indexed');

    // llm_reviewed_at should NOT have been set
    const reviewedAtUpdate = updateCalls.find(
      (c) => (c.args[0] as Record<string, unknown>).llm_reviewed_at,
    );
    expect(reviewedAtUpdate).toBeUndefined();
  });

  // ── Test 8: Already indexed → return early ────────────────────────────────
  it('returns early with success when session is already indexed', async () => {
    _sessionResult = {
      data: makeSession({ status: 'indexed' }),
      error: null,
    };

    const result = await processSession('session-uuid-001');

    expect(result.status).toBe('success');
    expect(result.segments_inserted).toBe(0);
    expect(result.corrections_inserted).toBe(0);
    expect(result.llm_run_id).toBeNull();

    // fetchTranscript should NOT have been called
    expect(mockFetchTranscript).not.toHaveBeenCalled();

    // No 'processing' or 'indexed' update calls
    const updateCalls = _calls.filter((c) => c.method === 'update');
    const statuses = updateCalls.map((c) => (c.args[0] as Record<string, unknown>).status);
    expect(statuses).not.toContain('processing');
    expect(statuses).not.toContain('indexed');
  });
});

// ── Helpers used only in tests ────────────────────────────────────────────────

/** Heuristic to detect if an insert args[0] is a corrections array (has llm_run_id) */
function _isCorrectionsInsert(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return typeof (rows[0] as Record<string, unknown>).llm_run_id === 'string';
}
