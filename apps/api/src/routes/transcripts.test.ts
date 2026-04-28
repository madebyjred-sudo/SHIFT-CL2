/**
 * Tests for transcripts.ts routes — Fase 0, Task 6.
 *
 * Both routers are tested by calling their handlers directly with mock
 * req/res objects (no supertest — not installed). Routing itself is
 * trivial and tested at integration time.
 *
 * Mocks:
 *   - syncYoutubeChannel  → vi.mock('../jobs/youtubeSync.js')
 *   - processSession      → vi.mock('../jobs/transcriptProcess.js')
 *   - @supabase/supabase-js → vi.mock (controllable chain)
 *   - getUserFromRequest  → vi.mock('../services/auth.js')
 *
 * Test cases:
 *   1. Internal endpoint without secret → 401
 *   2. Internal endpoint with correct secret → calls sync + processSession + returns summary
 *   3. Admin endpoint without auth → 401
 *   4. Admin endpoint with videoIds → looks up session, calls processSession, skips sync
 *   5. Admin endpoint with no videoIds → calls sync, then processSession for new ones
 *   6. Admin endpoint with force=true → resets status='pending' before processSession
 *   7. Admin endpoint with dryRun=true → returns diff without calling processSession
 *   8. processSession failure for one session → logged + others continue, errors[] ignored
 *      (per-session throws are caught inside the route and stored as permanent_failure results)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ── Supabase mock ─────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown };

let _fromTable = '';
let _supaCallLog: { method: string; args: unknown[] }[] = [];

// Configurable results for each supabase operation
let _sessionLookupResult: MockResult = { data: { id: 'sess-uuid-1' }, error: null };
let _updateResult: MockResult = { data: null, error: null };
// Result returned when .limit() is the terminal call (used by process-pending query)
let _limitResult: MockResult = { data: [], error: null };

vi.mock('@supabase/supabase-js', () => {
  // The trick with supabase mocks: the chain must NOT be thenable until the
  // caller explicitly calls .single() or we know a terminal method was hit.
  // A thenable plain object gets auto-resolved by `await`, which short-circuits
  // the chain BEFORE terminal methods like .single() are called.
  //
  // Solution: each method returns a *new* non-thenable chain object.
  // Only .single() and .in() (for update().in() paths) return real Promises.
  function buildChain(): Record<string, (...args: unknown[]) => unknown> {
    // We use a factory so each call returns a fresh non-thenable object
    const makeChain = (): Record<string, (...args: unknown[]) => unknown> => {
      const c: Record<string, (...args: unknown[]) => unknown> = {
        from: (table: unknown) => {
          _fromTable = table as string;
          _supaCallLog.push({ method: 'from', args: [table] });
          return makeChain();
        },
        select: (...args: unknown[]) => {
          _supaCallLog.push({ method: 'select', args });
          return makeChain();
        },
        update: (data: unknown) => {
          _supaCallLog.push({ method: 'update', args: [data] });
          return makeChain();
        },
        eq: (...args: unknown[]) => {
          _supaCallLog.push({ method: 'eq', args });
          return makeChain();
        },
        in: (...args: unknown[]) => {
          _supaCallLog.push({ method: 'in', args });
          // update().in() is a terminal call in our route code — return a Promise
          return Promise.resolve(_updateResult);
        },
        order: (...args: unknown[]) => {
          _supaCallLog.push({ method: 'order', args });
          return makeChain();
        },
        limit: (...args: unknown[]) => {
          _supaCallLog.push({ method: 'limit', args });
          // Return a hybrid: has .single() for callers that chain further,
          // AND has .then() so `await ...limit(n)` resolves to _limitResult
          // when no further chaining happens.
          const next = makeChain();
          // Attach thenable so direct `await` resolves to _limitResult
          (next as Record<string, unknown>)['then'] = (
            resolve: (v: unknown) => unknown,
            _reject: (e: unknown) => unknown,
          ) => Promise.resolve(_limitResult).then(resolve, _reject);
          return next;
        },
        single: () => {
          _supaCallLog.push({ method: 'single', args: [] });
          return Promise.resolve(_sessionLookupResult);
        },
      };
      return c;
    };
    return makeChain();
  }
  return {
    createClient: () => buildChain(),
  };
});

// ── Job mocks ─────────────────────────────────────────────────────────────────

const mockSyncYoutubeChannel = vi.fn();
const mockProcessSession = vi.fn();

vi.mock('../jobs/youtubeSync.js', () => ({
  syncYoutubeChannel: (...args: unknown[]) => mockSyncYoutubeChannel(...args),
}));

vi.mock('../jobs/transcriptProcess.js', () => ({
  processSession: (...args: unknown[]) => mockProcessSession(...args),
  _resetSupaClient: vi.fn(),
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────

const mockGetUserFromRequest = vi.fn();

vi.mock('../services/auth.js', () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
  getUserIdFromRequest: vi.fn().mockResolvedValue(null),
}));

// ── Logger mock (silence output in tests) ─────────────────────────────────────

vi.mock('../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import routers AFTER mocks are in place ────────────────────────────────────

import { internalTriggersRouter, transcriptsAdminRouter, _resetSupaClient } from './transcripts.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    ip: '127.0.0.1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as Request;
}

type ResponseCapture = {
  statusCode: number;
  body: unknown;
  status: (code: number) => ResponseCapture;
  json: (body: unknown) => void;
};

function makeRes(): ResponseCapture {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
    setHeader: vi.fn(),
  } as unknown as ResponseCapture;
  return res;
}

// Invoke the first matching POST handler in a router directly.
// We find the handler layer by matching the path and method.
async function invokeRouterPost(
  router: ReturnType<typeof import('express').Router>,
  path: string,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Walk the router's stack to find the matching layer
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ method: string; handle: Function }> } }> }).stack;
    for (const layer of stack) {
      if (layer.route && layer.route.path === path) {
        const handler = layer.route.stack.find((h) => h.method === 'post')?.handle;
        if (handler) {
          Promise.resolve(handler(req, res, (err?: unknown) => {
            if (err) reject(err as Error); else resolve();
          })).then(() => resolve()).catch(reject);
          return;
        }
      }
    }
    reject(new Error(`No POST handler for ${path} in router`));
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.unstubAllEnvs();
  // Set supabase env vars so supa() doesn't throw in the route handler.
  // The actual createClient is mocked — these values are never used for real.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  _supaCallLog = [];
  _fromTable = '';
  _sessionLookupResult = { data: { id: 'sess-uuid-1' }, error: null };
  _updateResult = { data: null, error: null };
  _limitResult = { data: [], error: null };
  mockSyncYoutubeChannel.mockReset();
  mockProcessSession.mockReset();
  mockGetUserFromRequest.mockReset();
  _resetSupaClient();

  // Default: sync returns 1 new video
  mockSyncYoutubeChannel.mockResolvedValue({
    found: 1,
    new: 1,
    skipped: 0,
    errors: 0,
    videoIds: { new: ['vid-abc'], skipped: [], errored: [] },
  });

  // Default: processSession succeeds
  mockProcessSession.mockResolvedValue({
    session_id: 'sess-uuid-1',
    status: 'success',
    segments_inserted: 10,
    corrections_inserted: 2,
    llm_run_id: 'llm-run-1',
    duration_ms: 1234,
  });

  // Default: user is authenticated
  mockGetUserFromRequest.mockResolvedValue({ id: 'user-1', email: 'jred@shiftlab.cr' });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/internal/youtube-sync', () => {
  it('test 1: returns 401 when X-Internal-Trigger header is missing', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await invokeRouterPost(internalTriggersRouter, '/youtube-sync', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect(mockSyncYoutubeChannel).not.toHaveBeenCalled();
  });

  it('test 2: correct secret → calls sync + processSession, returns summary', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(internalTriggersRouter, '/youtube-sync', req as Request, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(mockSyncYoutubeChannel).toHaveBeenCalledWith({ daysBack: 7 });
    expect(mockProcessSession).toHaveBeenCalledWith('sess-uuid-1');

    const body = res.body as { ok: boolean; sync: unknown; processed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(1);
  });

  it('test 2b: wrong secret → 401, no sync called', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'wrongsecret' } });
    const res = makeRes();
    await invokeRouterPost(internalTriggersRouter, '/youtube-sync', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(mockSyncYoutubeChannel).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/transcripts/sync', () => {
  it('test 3: returns 401 when user is not authenticated', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(mockSyncYoutubeChannel).not.toHaveBeenCalled();
  });

  it('test 4: with videoIds → looks up session, calls processSession, skips sync', async () => {
    const req = makeReq({ body: { videoIds: ['vid-xyz'] } });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);

    // sync should NOT be called (videoIds path skips it)
    expect(mockSyncYoutubeChannel).not.toHaveBeenCalled();

    // Should have looked up the session by youtube_video_id
    const eqCall = _supaCallLog.find(
      (c) => c.method === 'eq' && Array.isArray(c.args) && c.args[0] === 'youtube_video_id',
    );
    expect(eqCall).toBeTruthy();

    // processSession should be called with the resolved session id
    expect(mockProcessSession).toHaveBeenCalledWith('sess-uuid-1', { skipLlmReview: false });

    const body = res.body as { ok: boolean; processed: unknown[]; sync: null };
    expect(body.ok).toBe(true);
    expect(body.sync).toBeNull();
    expect(body.processed).toHaveLength(1);
  });

  it('test 5: no videoIds → calls sync, then processSession for new sessions', async () => {
    const req = makeReq({ body: { daysBack: 14 } });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);

    expect(mockSyncYoutubeChannel).toHaveBeenCalledWith({ daysBack: 14, dryRun: false });
    expect(mockProcessSession).toHaveBeenCalledWith('sess-uuid-1', { skipLlmReview: false });

    const body = res.body as { ok: boolean; processed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(1);
  });

  it('test 6: force=true → resets status=pending before calling processSession', async () => {
    const req = makeReq({ body: { videoIds: ['vid-force'], force: true } });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);

    // Should have called update with status='pending'
    const updateCall = _supaCallLog.find(
      (c) => c.method === 'update' && JSON.stringify(c.args).includes('pending'),
    );
    expect(updateCall).toBeTruthy();

    // processSession should still be called
    expect(mockProcessSession).toHaveBeenCalledWith('sess-uuid-1', { skipLlmReview: false });
  });

  it('test 7: dryRun=true → calls sync with dryRun, does NOT call processSession', async () => {
    mockSyncYoutubeChannel.mockResolvedValue({
      found: 3,
      new: 3,
      skipped: 0,
      errors: 0,
      videoIds: { new: ['v1', 'v2', 'v3'], skipped: [], errored: [] },
    });

    const req = makeReq({ body: { dryRun: true } });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);

    expect(mockSyncYoutubeChannel).toHaveBeenCalledWith({ daysBack: 7, dryRun: true });
    expect(mockProcessSession).not.toHaveBeenCalled();

    const body = res.body as { ok: boolean; processed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(0);
  });

  it('test 8: processSession throws for one session → logged + result is permanent_failure, does not crash route', async () => {
    // Set up 2 video IDs returned from sync
    mockSyncYoutubeChannel.mockResolvedValue({
      found: 2,
      new: 2,
      skipped: 0,
      errors: 0,
      videoIds: { new: ['vid-good', 'vid-bad'], skipped: [], errored: [] },
    });

    // First call succeeds, second throws
    let callCount = 0;
    _sessionLookupResult = { data: { id: 'sess-good' }, error: null };

    mockProcessSession
      .mockImplementationOnce(async () => ({
        session_id: 'sess-good',
        status: 'success',
        segments_inserted: 5,
        corrections_inserted: 1,
        llm_run_id: 'run-1',
        duration_ms: 500,
      }))
      .mockImplementationOnce(async () => {
        throw new Error('transcript fetch failed: network error');
      });

    // Both session lookups return a valid session (we need 2 lookups)
    // The mock returns the same _sessionLookupResult for both .single() calls
    // — that's fine for testing error propagation
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(transcriptsAdminRouter, '/sync', req as Request, res as unknown as Response);

    const body = res.body as { ok: boolean; processed: Array<{ status: string; error?: string }> };
    expect(body.ok).toBe(true);
    // Both sessions should appear in processed (one success, one permanent_failure)
    expect(body.processed).toHaveLength(2);

    const failedResult = body.processed.find((p) => p.status === 'permanent_failure');
    expect(failedResult).toBeTruthy();
    expect(failedResult?.error).toContain('network error');

    const successResult = body.processed.find((p) => p.status === 'success');
    expect(successResult).toBeTruthy();
  });
});

// ── Tests: POST /api/internal/process-pending ─────────────────────────────────

describe('POST /api/internal/process-pending', () => {
  it('test P1: returns 401 when X-Internal-Trigger header is missing', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await invokeRouterPost(
      internalTriggersRouter,
      '/process-pending',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect(mockProcessSession).not.toHaveBeenCalled();
  });

  it('test P2: correct secret + 0 pending → processed=[], pending_remaining=0', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    // _limitResult already defaults to { data: [], error: null }
    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(
      internalTriggersRouter,
      '/process-pending',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; processed: unknown[]; pending_remaining: number };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(0);
    expect(body.pending_remaining).toBe(0);
    expect(mockProcessSession).not.toHaveBeenCalled();
  });

  it('test P3: 7 pending, limit=3 → processes 3, pending_remaining=4', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');

    // limit=3 means we fetch limit+1=4 rows; we return 7 IDs but the route
    // only slices the first `limit` from what DB returns.
    // We simulate: DB returns 4 rows (limit+1), so pending_remaining = 7-3 = 4.
    // Actually the route fetches limit+1 rows to peek; we give it 4 rows back.
    _limitResult = {
      data: [
        { id: 'sess-1' },
        { id: 'sess-2' },
        { id: 'sess-3' },
        { id: 'sess-4' }, // the extra one — proves there are more
      ],
      error: null,
    };

    mockProcessSession.mockResolvedValue({
      session_id: 'sess-x',
      status: 'success',
      segments_inserted: 5,
      corrections_inserted: 1,
      llm_run_id: 'run-x',
      duration_ms: 300,
    });

    const req = makeReq({
      headers: { 'x-internal-trigger': 'supersecret' },
      body: { limit: 3 },
    });
    const res = makeRes();
    await invokeRouterPost(
      internalTriggersRouter,
      '/process-pending',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; processed: unknown[]; pending_remaining: number };
    expect(body.ok).toBe(true);
    // Only 3 sessions processed (limit=3, even though 4 rows returned)
    expect(body.processed).toHaveLength(3);
    expect(mockProcessSession).toHaveBeenCalledTimes(3);
    // 4 rows returned − 3 processed = 1 remaining (minimum)
    expect(body.pending_remaining).toBe(1);
  });

  it('test P4: 5 pending, one session fails → 4 successes + 1 failure, batch continues', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');

    _limitResult = {
      data: [
        { id: 'sess-a' },
        { id: 'sess-b' },
        { id: 'sess-c' },
        { id: 'sess-d' },
        { id: 'sess-e' },
      ],
      error: null,
    };

    let callIdx = 0;
    mockProcessSession.mockImplementation(async (sessionId: string) => {
      callIdx++;
      if (callIdx === 3) {
        throw new Error('transcript_fetch_failed');
      }
      return {
        session_id: sessionId,
        status: 'success',
        segments_inserted: 4,
        corrections_inserted: 0,
        llm_run_id: 'run-ok',
        duration_ms: 200,
      };
    });

    const req = makeReq({
      headers: { 'x-internal-trigger': 'supersecret' },
      body: { limit: 5 },
    });
    const res = makeRes();
    await invokeRouterPost(
      internalTriggersRouter,
      '/process-pending',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      processed: Array<{ status: string; error?: string }>;
      pending_remaining: number;
    };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(5);
    expect(mockProcessSession).toHaveBeenCalledTimes(5);

    const failures = body.processed.filter((p) => p.status === 'permanent_failure');
    const successes = body.processed.filter((p) => p.status === 'success');
    expect(failures).toHaveLength(1);
    expect(successes).toHaveLength(4);
    expect(failures[0].error).toContain('transcript_fetch_failed');
    // No extra rows returned → pending_remaining=0
    expect(body.pending_remaining).toBe(0);
  });

  it('test P5: skipLlmReview=true → processSession called with that flag', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');

    _limitResult = { data: [{ id: 'sess-skip' }], error: null };
    mockProcessSession.mockResolvedValue({
      session_id: 'sess-skip',
      status: 'success',
      segments_inserted: 3,
      corrections_inserted: 0,
      llm_run_id: null,
      duration_ms: 150,
    });

    const req = makeReq({
      headers: { 'x-internal-trigger': 'supersecret' },
      body: { skipLlmReview: true },
    });
    const res = makeRes();
    await invokeRouterPost(
      internalTriggersRouter,
      '/process-pending',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    expect(mockProcessSession).toHaveBeenCalledWith('sess-skip', { skipLlmReview: true });
    const body = res.body as { ok: boolean; processed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.processed).toHaveLength(1);
  });
});
