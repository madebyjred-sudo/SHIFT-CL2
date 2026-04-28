/**
 * Tests for centinela.ts routes.
 *
 * Routers tested by calling their handlers directly with mock req/res objects
 * (no supertest — matches existing project convention from transcripts.test.ts).
 *
 * Mocks:
 *   - syncCentinelaWatchlist   → vi.mock('../jobs/centinelaSilSync.js')
 *   - scrapeAgenda             → vi.mock('../jobs/agendaScrape.js')
 *   - detectSimilarExpedientes → vi.mock('../jobs/centinelaSimilarDetect.js')
 *   - getUserFromRequest       → vi.mock('../services/auth.js')
 *   - logger                   → vi.mock('../services/logger.js')
 *
 * Test cases (13 total):
 *
 * Internal endpoints — sil-sync:
 *   1. missing X-Internal-Trigger header → 401
 *   2. wrong secret → 401
 *   3. correct secret → calls syncCentinelaWatchlist(), returns { ok: true, result }
 *
 * Internal endpoints — agenda-scrape:
 *   4. missing header → 401
 *   5. correct secret → calls scrapeAgenda(), returns { ok: true, result }
 *
 * Internal endpoints — similar-detect:
 *   6. missing header → 401
 *   7. correct secret → calls detectSimilarExpedientes(), returns { ok: true, result }
 *
 * Admin endpoints — sync-now:
 *   8. unauthenticated → 401
 *   9. authenticated, no body → calls syncCentinelaWatchlist({dryRun:false})
 *  10. authenticated, body {dryRun:true, limit:5} → forwards params correctly
 *
 * Admin endpoints — scrape-agenda:
 *  11. unauthenticated → 401
 *  12. authenticated with dryRun:true, daysAhead:7 → forwards to scrapeAgenda
 *
 * Admin endpoints — detect-similar:
 *  13. unauthenticated → 401
 *  14. authenticated with candidateExpedienteIds + dryRun → forwards to detectSimilarExpedientes
 *
 * Error handling:
 *  15. job throws unhandled exception → route returns 500 with error message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ── Job mocks ─────────────────────────────────────────────────────────────────

const mockSyncCentinelaWatchlist = vi.fn();
const mockScrapeAgenda = vi.fn();
const mockDetectSimilarExpedientes = vi.fn();

vi.mock('../jobs/centinelaSilSync.js', () => ({
  syncCentinelaWatchlist: (...args: unknown[]) => mockSyncCentinelaWatchlist(...args),
}));

vi.mock('../jobs/agendaScrape.js', () => ({
  scrapeAgenda: (...args: unknown[]) => mockScrapeAgenda(...args),
}));

vi.mock('../jobs/centinelaSimilarDetect.js', () => ({
  detectSimilarExpedientes: (...args: unknown[]) => mockDetectSimilarExpedientes(...args),
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

// ── Import routers AFTER mocks ────────────────────────────────────────────────

import { centinelaInternalRouter, centinelaAdminRouter } from './centinela.js';

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

/**
 * Invoke the first matching POST handler in a router directly.
 * Mirrors the helper from transcripts.test.ts.
 */
async function invokeRouterPost(
  router: ReturnType<typeof import('express').Router>,
  path: string,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stack = (
      router as unknown as {
        stack: Array<{
          route?: {
            path: string;
            stack: Array<{ method: string; handle: (...args: unknown[]) => unknown }>;
          };
        }>;
      }
    ).stack;
    for (const layer of stack) {
      if (layer.route && layer.route.path === path) {
        const handler = layer.route.stack.find((h) => h.method === 'post')?.handle;
        if (handler) {
          Promise.resolve(
            handler(req, res, (err?: unknown) => {
              if (err) reject(err as Error);
              else resolve();
            }),
          )
            .then(() => resolve())
            .catch(reject);
          return;
        }
      }
    }
    reject(new Error(`No POST handler for ${path} in router`));
  });
}

// ── Default job return values ─────────────────────────────────────────────────

const defaultSilSyncResult = {
  watchlist_size: 2,
  expedientes_checked: 2,
  state_changes: [],
  plazos_recalculated: 0,
  alerts_inserted: 0,
  errors: [],
  duration_ms: 120,
};

const defaultScrapeResult = {
  scraped_count: 5,
  agenda_inserted: 3,
  alerts_inserted: 1,
  errors: [],
  duration_ms: 450,
};

const defaultSimilarResult = {
  candidates_processed: 3,
  watchlist_pairs_evaluated: 6,
  alerts_inserted: 2,
  errors: [],
  duration_ms: 800,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.unstubAllEnvs();
  mockSyncCentinelaWatchlist.mockReset();
  mockScrapeAgenda.mockReset();
  mockDetectSimilarExpedientes.mockReset();
  mockGetUserFromRequest.mockReset();

  // Defaults
  mockSyncCentinelaWatchlist.mockResolvedValue(defaultSilSyncResult);
  mockScrapeAgenda.mockResolvedValue(defaultScrapeResult);
  mockDetectSimilarExpedientes.mockResolvedValue(defaultSimilarResult);
  mockGetUserFromRequest.mockResolvedValue({ id: 'user-1', email: 'jred@shiftlab.cr' });
});

// ── Internal: sil-sync ────────────────────────────────────────────────────────

describe('POST /api/internal/centinela/sil-sync', () => {
  it('test 1: missing X-Internal-Trigger header → 401', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/sil-sync',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect(mockSyncCentinelaWatchlist).not.toHaveBeenCalled();
  });

  it('test 2: wrong secret → 401', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'badsecret' } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/sil-sync',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockSyncCentinelaWatchlist).not.toHaveBeenCalled();
  });

  it('test 3: correct secret → calls syncCentinelaWatchlist(), returns { ok: true, result }', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/sil-sync',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockSyncCentinelaWatchlist).toHaveBeenCalledWith();
    const body = res.body as { ok: boolean; result: typeof defaultSilSyncResult };
    expect(body.ok).toBe(true);
    expect(body.result.watchlist_size).toBe(2);
  });
});

// ── Internal: agenda-scrape ───────────────────────────────────────────────────

describe('POST /api/internal/centinela/agenda-scrape', () => {
  it('test 4: missing header → 401', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/agenda-scrape',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockScrapeAgenda).not.toHaveBeenCalled();
  });

  it('test 5: correct secret → calls scrapeAgenda(), returns { ok: true, result }', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/agenda-scrape',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockScrapeAgenda).toHaveBeenCalledWith();
    const body = res.body as { ok: boolean; result: typeof defaultScrapeResult };
    expect(body.ok).toBe(true);
    expect(body.result.scraped_count).toBe(5);
  });
});

// ── Internal: similar-detect ──────────────────────────────────────────────────

describe('POST /api/internal/centinela/similar-detect', () => {
  it('test 6: missing header → 401', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/similar-detect',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockDetectSimilarExpedientes).not.toHaveBeenCalled();
  });

  it('test 7: correct secret → calls detectSimilarExpedientes(), returns { ok: true, result }', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/similar-detect',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockDetectSimilarExpedientes).toHaveBeenCalledWith();
    const body = res.body as { ok: boolean; result: typeof defaultSimilarResult };
    expect(body.ok).toBe(true);
    expect(body.result.candidates_processed).toBe(3);
  });
});

// ── Admin: sync-now ───────────────────────────────────────────────────────────

describe('POST /api/admin/centinela/sync-now', () => {
  it('test 8: unauthenticated → 401', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/sync-now',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockSyncCentinelaWatchlist).not.toHaveBeenCalled();
  });

  it('test 9: authenticated, no body → calls syncCentinelaWatchlist with dryRun:false', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/sync-now',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockSyncCentinelaWatchlist).toHaveBeenCalledWith({ dryRun: false, limit: undefined });
    const body = res.body as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('test 10: body {dryRun:true, limit:5} → forwards params to syncCentinelaWatchlist', async () => {
    const req = makeReq({ body: { dryRun: true, limit: 5 } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/sync-now',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockSyncCentinelaWatchlist).toHaveBeenCalledWith({ dryRun: true, limit: 5 });
  });
});

// ── Admin: scrape-agenda ──────────────────────────────────────────────────────

describe('POST /api/admin/centinela/scrape-agenda', () => {
  it('test 11: unauthenticated → 401', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/scrape-agenda',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockScrapeAgenda).not.toHaveBeenCalled();
  });

  it('test 12: authenticated with dryRun:true, daysAhead:7 → forwards to scrapeAgenda', async () => {
    const req = makeReq({ body: { dryRun: true, daysAhead: 7 } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/scrape-agenda',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockScrapeAgenda).toHaveBeenCalledWith({ dryRun: true, daysAhead: 7 });
    const body = res.body as { ok: boolean; result: typeof defaultScrapeResult };
    expect(body.ok).toBe(true);
    expect(body.result.scraped_count).toBe(5);
  });
});

// ── Admin: detect-similar ─────────────────────────────────────────────────────

describe('POST /api/admin/centinela/detect-similar', () => {
  it('test 13: unauthenticated → 401', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/detect-similar',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(401);
    expect(mockDetectSimilarExpedientes).not.toHaveBeenCalled();
  });

  it('test 14: authenticated with candidateExpedienteIds + dryRun → forwards to detectSimilarExpedientes', async () => {
    const req = makeReq({
      body: { dryRun: true, candidateExpedienteIds: [24429, 24430], similarityThreshold: 0.8 },
    });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/detect-similar',
      req as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(mockDetectSimilarExpedientes).toHaveBeenCalledWith({
      dryRun: true,
      candidateExpedienteIds: [24429, 24430],
      similarityThreshold: 0.8,
    });
    const body = res.body as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('Unhandled job exception → 500', () => {
  it('test 15: syncCentinelaWatchlist throws → internal sil-sync returns 500 with error message', async () => {
    vi.stubEnv('INTERNAL_TRIGGER_SECRET', 'supersecret');
    mockSyncCentinelaWatchlist.mockRejectedValue(new Error('watchlist DB timeout'));

    const req = makeReq({ headers: { 'x-internal-trigger': 'supersecret' } });
    const res = makeRes();
    await invokeRouterPost(
      centinelaInternalRouter,
      '/sil-sync',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(500);
    const body = res.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('watchlist DB timeout');
  });

  it('test 16: detectSimilarExpedientes throws on admin endpoint → returns 500', async () => {
    mockDetectSimilarExpedientes.mockRejectedValue(new Error('pgvector RPC failed'));

    const req = makeReq({ body: {} });
    const res = makeRes();
    await invokeRouterPost(
      centinelaAdminRouter,
      '/detect-similar',
      req as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(500);
    const body = res.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('pgvector RPC failed');
  });
});
