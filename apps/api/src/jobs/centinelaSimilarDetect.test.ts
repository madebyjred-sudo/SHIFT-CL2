/**
 * Unit tests for centinelaSimilarDetect.ts
 *
 * Coverage (6 cases):
 *   1. Happy path: candidate found, similarity above threshold, alert inserted
 *   2. Empty watchlist: no alerts
 *   3. Dedup: re-run inserts 0 new alerts (upsert ignoreDuplicates)
 *   4. dryRun: no DB writes made
 *   5. No embedding returned (Vertex AI unavailable): candidate skipped gracefully
 *   6. Similarity below threshold: no alerts
 *
 * Vertex AI embedding + supabase + logger mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown };

const _tables: Record<string, MockResult> = {};
const _rpcResults: Record<string, MockResult> = {};
const _upsertResults: Record<string, MockResult> = {};
const _upsertCalls: Array<{ table: string; rows: unknown; opts?: unknown }> = [];

// Separate store for maybeSingle results (used by getExpedienteNumero)
// When a test needs different data for list vs single lookups on the same table,
// set _tableSingle['sil_expedientes'] for single-row lookups.
const _tableSingle: Record<string, MockResult> = {};

vi.mock('@supabase/supabase-js', () => {
  function chain(table: string): Record<string, (...args: unknown[]) => unknown> {
    const c: Record<string, (...args: unknown[]) => unknown> = {
      select: (_cols?: unknown) => {
        const sc: Record<string, (...args: unknown[]) => unknown> = {
          eq: (_col: unknown, _val: unknown) => {
            const eqChain: Record<string, (...args: unknown[]) => unknown> = {
              eq: () => eqChain,
              in: () => Promise.resolve(_tables[table] ?? { data: [], error: null }),
              // maybeSingle uses _tableSingle if set, else _tables
              maybeSingle: () =>
                Promise.resolve(
                  _tableSingle[table] ?? _tables[table] ?? { data: null, error: null },
                ),
              gte: () => Promise.resolve(_tables[table] ?? { data: [], error: null }),
              then: (...args: unknown[]) =>
                Promise.resolve(_tables[table] ?? { data: [], error: null }).then(
                  args[0] as Parameters<Promise<MockResult>['then']>[0],
                  args[1] as Parameters<Promise<MockResult>['then']>[1],
                ),
            };
            return eqChain;
          },
          in: (_col: unknown, _vals: unknown) =>
            Promise.resolve(_tables[table] ?? { data: [], error: null }),
          gte: (_col: unknown, _val: unknown) =>
            Promise.resolve(_tables[table] ?? { data: [], error: null }),
          maybeSingle: () =>
            Promise.resolve(
              _tableSingle[table] ?? _tables[table] ?? { data: null, error: null },
            ),
          then: (...args: unknown[]) =>
            Promise.resolve(_tables[table] ?? { data: [], error: null }).then(
              args[0] as Parameters<Promise<MockResult>['then']>[0],
              args[1] as Parameters<Promise<MockResult>['then']>[1],
            ),
        };
        return sc;
      },
      upsert: (rows: unknown, opts?: unknown) => {
        _upsertCalls.push({ table, rows, opts });
        const r = _upsertResults[table] ?? { data: null, error: null };
        return Promise.resolve(r);
      },
    };
    return c;
  }

  return {
    createClient: () => ({
      from: (table: unknown) => chain(table as string),
      rpc: (name: unknown, _params?: unknown) => {
        const r = _rpcResults[name as string] ?? { data: [], error: null };
        return Promise.resolve(r);
      },
    }),
  };
});

vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Embeddings mock ───────────────────────────────────────────────────────────
// We mock the dynamic import of ../services/embeddings.js inside the job.

let _embedQueryResult: number[] | 'error' = Array(3072).fill(0.1);

vi.mock('../services/embeddings.js', () => ({
  embedQuery: vi.fn(async (_text: string) => {
    if (_embedQueryResult === 'error') throw new Error('vertex_unavailable');
    return _embedQueryResult;
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { detectSimilarExpedientes, _resetSupaClient } from './centinelaSimilarDetect.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeExpediente(id: number, numero: string, titulo = 'Proyecto de ley test') {
  return { id, numero, titulo, scraped_at: new Date().toISOString() };
}

function makeChunkResult(sourceRef: string, similarity: number) {
  return { chunk_id: `chunk-${sourceRef}`, source_ref: sourceRef, similarity };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectSimilarExpedientes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _upsertCalls.length = 0;
    _resetSupaClient();
    _embedQueryResult = Array(3072).fill(0.1);
    // Clear all table mocks
    Object.keys(_tables).forEach((k) => delete _tables[k]);
    Object.keys(_tableSingle).forEach((k) => delete _tableSingle[k]);
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  });

  it('happy path: candidate above threshold watched by user → alert inserted', async () => {
    const candidateId = 24429;
    const watchedId = 22100;

    // Candidate expediente (list query via .in())
    _tables['sil_expedientes'] = {
      data: [makeExpediente(candidateId, '24.429', 'Reforma fiscal')],
      error: null,
    };
    // Watched expediente numero lookup (single query via .maybeSingle())
    _tableSingle['sil_expedientes'] = { data: { numero: '22.100' }, error: null };

    // Watchlist: user-1 watches expediente 22100
    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_id: String(watchedId) }],
      error: null,
    };

    // match_chunks_v2 returns one similar chunk from watched expediente
    _rpcResults['match_chunks_v2'] = {
      data: [makeChunkResult(`sil_expediente:${watchedId}`, 0.88)],
      error: null,
    };

    _upsertResults['centinela_alerts'] = { data: null, error: null };

    const result = await detectSimilarExpedientes({
      candidateExpedienteIds: [candidateId],
      similarityThreshold: 0.75,
    });

    expect(result.candidates_processed).toBe(1);
    expect(result.alerts_inserted).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts.length).toBeGreaterThan(0);
    const payload = alertUpserts[0]!.rows as Record<string, unknown>;
    expect(payload.alert_type).toBe('similar');
    expect(String(payload.dedup_key)).toContain('similar:');
  });

  it('empty watchlist: candidates processed, 0 alerts', async () => {
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await detectSimilarExpedientes({
      candidateExpedienteIds: [24429],
      similarityThreshold: 0.75,
    });

    expect(result.alerts_inserted).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Short-circuits at watchlist check
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
  });

  it('dedup: ignoreDuplicates set on alert upsert', async () => {
    const candidateId = 24429;
    const watchedId = 22100;

    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_id: String(watchedId) }],
      error: null,
    };
    // Array for list query (.in())
    _tables['sil_expedientes'] = {
      data: [makeExpediente(candidateId, '24.429')],
      error: null,
    };
    // Single for numero lookup (.maybeSingle())
    _tableSingle['sil_expedientes'] = { data: { numero: '22.100' }, error: null };
    _rpcResults['match_chunks_v2'] = {
      data: [makeChunkResult(`sil_expediente:${watchedId}`, 0.90)],
      error: null,
    };
    _upsertResults['centinela_alerts'] = { data: null, error: null };

    await detectSimilarExpedientes({
      candidateExpedienteIds: [candidateId],
      similarityThreshold: 0.75,
    });

    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    for (const u of alertUpserts) {
      expect((u.opts as Record<string, unknown>)?.ignoreDuplicates).toBe(true);
    }
  });

  it('dryRun: no DB writes, counts still reported', async () => {
    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_id: '22100' }],
      error: null,
    };
    // Array for list query
    _tables['sil_expedientes'] = {
      data: [makeExpediente(24429, '24.429')],
      error: null,
    };
    _tableSingle['sil_expedientes'] = { data: { numero: '22.100' }, error: null };
    _rpcResults['match_chunks_v2'] = {
      data: [makeChunkResult('sil_expediente:22100', 0.85)],
      error: null,
    };

    const result = await detectSimilarExpedientes({
      candidateExpedienteIds: [24429],
      similarityThreshold: 0.75,
      dryRun: true,
    });

    // dryRun: insertSimilarAlert returns early → alerts_inserted = 0
    expect(result.alerts_inserted).toBe(0);
    // No DB upserts called at all
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
  });

  it('no embedding (Vertex AI error): candidate skipped gracefully, 0 alerts, no throw', async () => {
    _embedQueryResult = 'error';

    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_id: '22100' }],
      error: null,
    };
    // Array for list query
    _tables['sil_expedientes'] = {
      data: [makeExpediente(24429, '24.429')],
      error: null,
    };

    // getExpedienteEmbedding catches the error internally and returns null.
    // The main loop sees null embedding → logs warning, continues.
    // candidates_processed is NOT incremented because embedding check fails.
    // result.errors is empty (embedding failures are warn-and-skip, not errors[]).
    const result = await detectSimilarExpedientes({
      candidateExpedienteIds: [24429],
      similarityThreshold: 0.75,
    });

    expect(result.candidates_processed).toBe(0); // embedding null → skipped before counting
    expect(result.alerts_inserted).toBe(0);
    // No DB alert upserts
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
    // Function must not throw
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('similarity below threshold: no alerts', async () => {
    const candidateId = 24429;
    const watchedId = 22100;

    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_id: String(watchedId) }],
      error: null,
    };
    // Array for list query
    _tables['sil_expedientes'] = {
      data: [makeExpediente(candidateId, '24.429')],
      error: null,
    };
    _tableSingle['sil_expedientes'] = { data: { numero: '22.100' }, error: null };

    // Low similarity — below default 0.75 threshold
    _rpcResults['match_chunks_v2'] = {
      data: [makeChunkResult(`sil_expediente:${watchedId}`, 0.50)],
      error: null,
    };

    const result = await detectSimilarExpedientes({
      candidateExpedienteIds: [candidateId],
      similarityThreshold: 0.75,
    });

    expect(result.candidates_processed).toBe(1);
    // No pair exceeded threshold → no alerts
    expect(result.alerts_inserted).toBe(0);
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
  });
});
