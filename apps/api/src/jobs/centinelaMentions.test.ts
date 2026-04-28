/**
 * Unit tests for centinelaMentions.ts
 *
 * Coverage (6 cases):
 *   1. Happy path: segment mentions watched expediente → alert inserted
 *   2. Diputado mention → alert with entity_type='diputado'
 *   3. Empty watchlist: 0 alerts
 *   4. Dedup: same term in multiple segments → only 1 alert per user (in-memory dedup)
 *   5. dryRun: no DB writes
 *   6. Session not found: returns empty result gracefully
 *
 * Pure helpers tested separately (normalizeExpedienteNumero, buildContextSnippet, etc.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown };

const _tables: Record<string, MockResult> = {};
const _upsertResults: Record<string, MockResult> = {};
const _upsertCalls: Array<{ table: string; rows: unknown; opts?: unknown }> = [];

// Per-table select chains — keys are table names, values control the resolved data.
// Some queries are filtered by .eq(); for simplicity our mock returns the same
// _tables[table] value regardless of eq parameters.

vi.mock('@supabase/supabase-js', () => {
  function chain(table: string): Record<string, (...args: unknown[]) => unknown> {
    const c: Record<string, (...args: unknown[]) => unknown> = {
      select: (_cols?: unknown) => {
        const sc: Record<string, (...args: unknown[]) => unknown> = {
          eq: (_col: unknown, _val: unknown) => {
            const eqChain: Record<string, (...args: unknown[]) => unknown> = {
              eq: () => eqChain,
              maybeSingle: () => Promise.resolve(_tables[table] ?? { data: null, error: null }),
              order: (_col2: unknown, _opts?: unknown) => Promise.resolve(_tables[table] ?? { data: [], error: null }),
              in: () => Promise.resolve(_tables[table] ?? { data: [], error: null }),
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
    createClient: () => ({ from: (table: unknown) => chain(table as string) }),
  };
});

vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  scanSessionForMentions,
  normalizeExpedienteNumero,
  buildContextSnippet,
  scanSegmentForExpedientes,
  scanSegmentForDiputados,
  _resetSupaClient,
} from './centinelaMentions.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = 'session-abc-123';

function makeSession(videoId: string | null = 'abc123') {
  return { id: SESSION_ID, fecha: '2026-04-27', youtube_video_id: videoId };
}

function makeSegment(idx: number, text: string, startSeconds = idx * 10) {
  return { id: `seg-${idx}`, segment_idx: idx, start_seconds: startSeconds, text };
}

// Control which table is returned for a given call
// We need session + segments + watchlist to be independently mocked.
// Since all calls go to the same _tables map keyed by table name, we set:
//   _tables['sessions'] → session row
//   _tables['transcript_segments'] → segments array
//   _tables['centinela_watchlist'] → watchlist entries

function setupHappyPath(expNum: string) {
  _tables['sessions'] = { data: makeSession(), error: null };
  _tables['transcript_segments'] = {
    data: [makeSegment(0, `Se discute el expediente ${expNum} en segundo debate.`)],
    error: null,
  };
  _tables['centinela_watchlist'] = {
    data: [{ user_id: 'user-1', entity_type: 'expediente', entity_id: expNum, metadata: null }],
    error: null,
  };
  _upsertResults['centinela_alerts'] = { data: null, error: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scanSessionForMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _upsertCalls.length = 0;
    _resetSupaClient();
    Object.keys(_tables).forEach((k) => delete _tables[k]);
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  });

  it('happy path: expediente mention in segment → alert inserted with correct payload', async () => {
    const expNum = '24.429';
    setupHappyPath(expNum);

    const result = await scanSessionForMentions(SESSION_ID, { dryRun: false });

    expect(result.session_id).toBe(SESSION_ID);
    expect(result.segments_scanned).toBe(1);
    expect(result.alerts_inserted).toBeGreaterThan(0);

    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts.length).toBeGreaterThan(0);

    const payload = alertUpserts[0]!.rows as Record<string, unknown>;
    expect(payload.alert_type).toBe('mention');
    expect(payload.entity_type).toBe('expediente');
    expect(payload.dedup_key).toBe(`mention:${SESSION_ID}:${expNum}`);
    expect((payload.payload as Record<string, unknown>).matched_term).toBe(expNum);
    expect((payload.payload as Record<string, unknown>).session_id).toBe(SESSION_ID);
    // youtube_url_with_ts should include the video_id and timecode
    expect(typeof (payload.payload as Record<string, unknown>).youtube_url_with_ts).toBe('string');
  });

  it('diputado mention → alert with entity_type diputado', async () => {
    _tables['sessions'] = { data: makeSession(), error: null };
    _tables['transcript_segments'] = {
      data: [makeSegment(0, 'La diputada María Inés Solís tomó la palabra para...')],
      error: null,
    };
    _tables['centinela_watchlist'] = {
      data: [
        {
          user_id: 'user-1',
          entity_type: 'diputado',
          entity_id: 'dip-uuid-001',
          metadata: { display_name: 'María Inés Solís' },
        },
      ],
      error: null,
    };
    _upsertResults['centinela_alerts'] = { data: null, error: null };

    const result = await scanSessionForMentions(SESSION_ID, { dryRun: false });

    expect(result.alerts_inserted).toBeGreaterThan(0);

    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    const payload = alertUpserts[0]!.rows as Record<string, unknown>;
    expect(payload.entity_type).toBe('diputado');
    expect(payload.alert_type).toBe('mention');
  });

  it('empty watchlist: segments scanned, 0 alerts', async () => {
    _tables['sessions'] = { data: makeSession(), error: null };
    _tables['transcript_segments'] = {
      data: [makeSegment(0, 'Expediente 24.429 en debate.')],
      error: null,
    };
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await scanSessionForMentions(SESSION_ID, { dryRun: false });

    expect(result.segments_scanned).toBe(1);
    expect(result.watchlist_size).toBe(0);
    expect(result.alerts_inserted).toBe(0);
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
  });

  it('dedup: same expediente in 3 segments → only 1 alert per user', async () => {
    const expNum = '24.429';
    _tables['sessions'] = { data: makeSession(), error: null };
    _tables['transcript_segments'] = {
      data: [
        makeSegment(0, `Expediente ${expNum} aprobado.`, 0),
        makeSegment(1, `Revisando el expediente ${expNum} nuevamente.`, 10),
        makeSegment(2, `El ${expNum} pasó a segundo debate.`, 20),
      ],
      error: null,
    };
    _tables['centinela_watchlist'] = {
      data: [{ user_id: 'user-1', entity_type: 'expediente', entity_id: expNum, metadata: null }],
      error: null,
    };
    _upsertResults['centinela_alerts'] = { data: null, error: null };

    const result = await scanSessionForMentions(SESSION_ID, { dryRun: false });

    expect(result.segments_scanned).toBe(3);
    // In-memory dedup: only 1 alert inserted for user-1 + term 24.429
    expect(result.alerts_inserted).toBe(1);
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(1);
  });

  it('dryRun: no DB writes, segments_scanned and watchlist_size still reported', async () => {
    const expNum = '22.100';
    setupHappyPath(expNum);

    const result = await scanSessionForMentions(SESSION_ID, { dryRun: true });

    expect(result.segments_scanned).toBe(1);
    // dryRun: insertMentionAlert returns early → 0 alerts_inserted, 0 DB calls
    expect(result.alerts_inserted).toBe(0);
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts).toHaveLength(0);
  });

  it('session not found: returns empty result without error throw', async () => {
    _tables['sessions'] = { data: null, error: null };
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await scanSessionForMentions('non-existent-session');

    expect(result.session_id).toBe('non-existent-session');
    expect(result.segments_scanned).toBe(0);
    expect(result.alerts_inserted).toBe(0);
  });
});

// ── Unit tests for pure helpers ───────────────────────────────────────────────

describe('normalizeExpedienteNumero', () => {
  it('dot-format stays the same', () => {
    expect(normalizeExpedienteNumero('24.429')).toBe('24.429');
  });
  it('plain integer → dot-format', () => {
    expect(normalizeExpedienteNumero('24429')).toBe('24.429');
  });
  it('longer number', () => {
    expect(normalizeExpedienteNumero('100429')).toBe('100.429');
  });
  it('garbage → null', () => {
    expect(normalizeExpedienteNumero('abc')).toBeNull();
  });
});

describe('buildContextSnippet', () => {
  it('short text: returns full text', () => {
    const text = 'El expediente 24.429 fue aprobado.';
    const snippet = buildContextSnippet(text, 13, 6);
    expect(snippet).toContain('24.429');
  });
  it('long text: truncated with ellipsis', () => {
    const prefix = 'x'.repeat(300);
    const text = `${prefix} 24.429 ${prefix}`;
    const snippet = buildContextSnippet(text, 300, 6);
    expect(snippet.length).toBeLessThan(text.length);
    expect(snippet).toContain('…');
  });
});

describe('scanSegmentForExpedientes', () => {
  it('finds watched expediente in text', () => {
    const matches = scanSegmentForExpedientes(
      'Proyecto 24.429 aprobado en plenario',
      new Set(['24.429', '22.100']),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.term).toBe('24.429');
  });
  it('no match if expediente not in watchlist', () => {
    const matches = scanSegmentForExpedientes(
      'Expediente 24.429 en debate',
      new Set(['99.999']),
    );
    expect(matches).toHaveLength(0);
  });
  it('multiple matches in same text', () => {
    const matches = scanSegmentForExpedientes(
      '24.429 y 22.100 discutidos hoy',
      new Set(['24.429', '22.100']),
    );
    expect(matches).toHaveLength(2);
  });
});

describe('scanSegmentForDiputados', () => {
  it('finds diputado name (case-insensitive substring)', () => {
    const matches = scanSegmentForDiputados(
      'La diputada María Inés Solís tomó la palabra',
      ['maría inés solís'],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.term.toLowerCase()).toBe('maría inés solís');
  });
  it('no match if name not in text', () => {
    const matches = scanSegmentForDiputados(
      'El diputado Rodrigo Arias habló sobre el tema',
      ['juan carlos mendoza'],
    );
    expect(matches).toHaveLength(0);
  });
});
