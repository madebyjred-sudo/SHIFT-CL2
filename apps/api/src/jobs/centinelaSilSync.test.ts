/**
 * Unit tests for centinelaSilSync.ts
 *
 * WebForms HTTP client is mocked at the module level (vi.mock). Supabase client
 * is mocked via a controllable chain builder. No real HTTP or DB calls are made.
 *
 * Coverage (11 cases):
 *   1.  Watchlist with 1 expediente, state changed → state_change alert + plazo
 *   2.  State change watched by 2 users → 2 alert rows
 *   3.  Dedup: stored estado updated → second run emits 0 alerts
 *   4.  dryRun=true → changes reported, no DB writes
 *   5.  WebForms error for one expediente → errors[], others continue
 *   6.  Plazo threshold crossed → deadline alert
 *   7.  addBusinessDays: Friday+3=Wednesday, Wednesday+5=Wednesday
 *   8.  Empty watchlist → short-circuits without WebForms calls
 *   9.  First-time observation → stores estado, no alert emitted
 *  10.  No state change → 0 alerts, 0 plazos
 *  11.  limit option caps processing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown };

// Per-table mock responses. Tests set these before calling the function.
const _tables: Record<string, MockResult | undefined> = {};
// Per-table update responses.
const _updateResults: Record<string, MockResult | undefined> = {};
// Per-table upsert responses.
const _upsertResults: Record<string, MockResult | undefined> = {};

// Call recorders
const _upsertCalls: Array<{ table: string; rows: unknown; opts?: unknown }> = [];
const _updateCalls: Array<{ table: string; values: unknown }> = [];

vi.mock('@supabase/supabase-js', () => {
  function chain(table: string): Record<string, (...args: unknown[]) => unknown> {
    const c: Record<string, (...args: unknown[]) => unknown> = {
      // These return `this` for fluent chaining
      eq: () => c,
      in: () => {
        const r = _tables[table] ?? { data: [], error: null };
        return Promise.resolve(r);
      },
      // Terminal resolvers
      maybeSingle: () => {
        const r = _tables[table] ?? { data: null, error: null };
        return Promise.resolve(r);
      },
      single: () => {
        const r = _tables[table] ?? { data: null, error: null };
        return Promise.resolve(r);
      },
      then: (...args: unknown[]) => {
        const r = _tables[table] ?? { data: [], error: null };
        return Promise.resolve(r).then(args[0] as Parameters<Promise<MockResult>['then']>[0], args[1] as Parameters<Promise<MockResult>['then']>[1]);
      },
      catch: (...args: unknown[]) => {
        const r = _tables[table] ?? { data: [], error: null };
        return Promise.resolve(r).catch(args[0] as Parameters<Promise<MockResult>['catch']>[0]);
      },

      select: (_cols?: unknown) => {
        // Return a thenable object with .eq() / .in() / .maybeSingle() support
        const result = _tables[table] ?? { data: [], error: null };
        const selectChain: Record<string, (...args: unknown[]) => unknown> = {
          eq: (_col: unknown, _val: unknown) => {
            // Return a new chain that is also thenable
            const eqChain: Record<string, (...args: unknown[]) => unknown> = {
              eq: () => eqChain, // additional .eq() filters
              in: () => Promise.resolve(_tables[table] ?? { data: [], error: null }),
              maybeSingle: () => Promise.resolve(_tables[table] ?? { data: null, error: null }),
              then: (...args: unknown[]) =>
                Promise.resolve(_tables[table] ?? { data: [], error: null }).then(args[0] as Parameters<Promise<MockResult>['then']>[0], args[1] as Parameters<Promise<MockResult>['then']>[1]),
              catch: (...args: unknown[]) =>
                Promise.resolve(_tables[table] ?? { data: [], error: null }).catch(args[0] as Parameters<Promise<MockResult>['catch']>[0]),
            };
            return eqChain;
          },
          in: () => Promise.resolve(result),
          maybeSingle: () => Promise.resolve(_tables[table] ?? { data: null, error: null }),
          then: (...args: unknown[]) =>
            Promise.resolve(result).then(args[0] as Parameters<Promise<MockResult>['then']>[0], args[1] as Parameters<Promise<MockResult>['then']>[1]),
          catch: (...args: unknown[]) => Promise.resolve(result).catch(args[0] as Parameters<Promise<MockResult>['catch']>[0]),
        };
        return selectChain;
      },

      update: (values: unknown) => {
        _updateCalls.push({ table, values });
        const r = _updateResults[table] ?? { data: null, error: null };
        const updateChain: Record<string, (...args: unknown[]) => unknown> = {
          eq: () => Promise.resolve(r),
          then: (...args: unknown[]) =>
            Promise.resolve(r).then(args[0] as Parameters<Promise<MockResult>['then']>[0], args[1] as Parameters<Promise<MockResult>['then']>[1]),
        };
        return updateChain;
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
    }),
  };
});

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── WebForms client mock ──────────────────────────────────────────────────────
// The job calls: createSession() → searchByNumber() → selectExpedienteDetail()
// It then reads estado from session3.lastHtml via cheerio.
// We mock the module-level functions. Estado is embedded in lastHtml as a
// minimal table row so the job's extractEstadoFromHtml() can parse it.

type WebFormsMockEntry =
  | { estado: string; numero: string }   // found with estado
  | null                                  // not found on SIL
  | 'error';                              // WebForms throws

const _wfMocks = new Map<number, WebFormsMockEntry>();

function makeDetailHtml(estado: string): string {
  return `<html><body><table><tr><td>Estado</td><td>${estado}</td></tr></table></body></html>`;
}

vi.mock('../services/silWebFormsClient.js', () => {
  const baseSession = {
    viewState: 'VS',
    viewStateGenerator: 'VSG',
    eventValidation: 'EV',
    cookies: '',
    lastHtml: '',
  };

  return {
    createSession: vi.fn(async () => ({ ...baseSession })),

    searchByNumber: vi.fn(async (session: unknown, expedienteNum: number) => {
      const mock = _wfMocks.get(expedienteNum);
      if (mock === 'error') {
        throw new Error(`webforms:search:${expedienteNum} 404`);
      }
      if (mock === null || mock === undefined) {
        return { session, detail: null };
      }
      return {
        session: { ...baseSession, lastHtml: makeDetailHtml(mock.estado) },
        detail: {
          numero: mock.numero,
          numeroNum: expedienteNum,
          titulo: 'Proyecto de prueba',
          estado: null, // always null in search path
          proponente: null, comision: null, fechaPresentacion: null,
          tipo: null, legislatura: null, documentos: [], rawTextSnippet: null,
          detailUrl: '',
        },
      };
    }),

    selectExpedienteDetail: vi.fn(async (session: unknown, expedienteNum: number) => {
      const mock = _wfMocks.get(expedienteNum);
      if (mock === 'error') {
        throw new Error(`webforms:select:${expedienteNum} 404`);
      }
      if (mock === null || mock === undefined) {
        return { session, enriched: null };
      }
      // Return session with lastHtml containing the Estado label row
      return {
        session: { ...baseSession, lastHtml: makeDetailHtml((mock as { estado: string; numero: string }).estado) },
        enriched: {
          numero: (mock as { estado: string; numero: string }).numero,
          numeroNum: expedienteNum,
          titulo: 'Proyecto de prueba',
          proponente: null, tipo: null, fechaPresentacion: null, fechaPublicacion: null,
          numeroGaceta: null, numeroAlcance: null, numeroArchivado: null,
          vencimientoCuatrienal: null, vencimientoOrdinario: null, fechaDispensa: null,
          numeroLey: null, numeroAcuerdo: null, proponentes: [], comisiones: [],
        },
      };
    }),
  };
});

// ── Import subject under test ─────────────────────────────────────────────────
// Must come AFTER vi.mock() calls
import { syncCentinelaWatchlist, addBusinessDays } from './centinelaSilSync.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function setWatchlist(entries: Array<{ entity_id: string; user_id: string }>) {
  _tables['centinela_watchlist'] = { data: entries, error: null };
}

function setSilExpediente(expedienteId: number, estado: string | null, numero: string) {
  _tables['sil_expedientes'] = {
    data: { id: expedienteId, numero, estado },
    error: null,
  };
  _updateResults['sil_expedientes'] = { data: null, error: null };
}

function setSilExpedienteNotFound() {
  _tables['sil_expedientes'] = { data: null, error: null };
  _updateResults['sil_expedientes'] = { data: null, error: null };
}

function setReglamentoPlazos(rules: Array<{
  tipo_plazo: string;
  articulo_ref: string;
  estado_disparador: string;
  dias_habiles: number;
}>) {
  _tables['reglamento_plazos'] = { data: rules, error: null };
}

function setExpedientePlazos(rows: Array<{
  tipo_plazo: string;
  dias_restantes: number | null;
  fecha_vencimiento: string;
}>) {
  _tables['expediente_plazos'] = { data: rows, error: null };
  _upsertResults['expediente_plazos'] = { data: null, error: null };
}

function setAlertPrefs(prefs: Array<{ user_id: string; deadline_thresholds: number[] }>) {
  _tables['centinela_alert_prefs'] = { data: prefs, error: null };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('syncCentinelaWatchlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _upsertCalls.length = 0;
    _updateCalls.length = 0;
    _wfMocks.clear();
    Object.keys(_tables).forEach((k) => delete _tables[k]);
    Object.keys(_updateResults).forEach((k) => delete _updateResults[k]);
    Object.keys(_upsertResults).forEach((k) => delete _upsertResults[k]);

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

    // Defaults
    setReglamentoPlazos([]);
    setExpedientePlazos([]);
    setAlertPrefs([]);
    _upsertResults['centinela_alerts'] = { data: null, error: null };
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  // ── Test 1: 1 expediente, state changed → state_change alert + plazo ──────────

  it('state change detected → state_change alert inserted, plazo recalculated', async () => {
    setWatchlist([{ entity_id: '24001', user_id: 'user-a' }]);
    _wfMocks.set(24001, { estado: 'aprobado_primer_debate', numero: '24.001' });
    setSilExpediente(24001, 'en_comision', '24.001');
    setReglamentoPlazos([{
      tipo_plazo: 'discusion_plenario',
      articulo_ref: 'Art. 115',
      estado_disparador: 'aprobado_primer_debate',
      dias_habiles: 30,
    }]);

    const result = await syncCentinelaWatchlist();

    expect(result.watchlist_size).toBe(1);
    expect(result.expedientes_checked).toBe(1);
    expect(result.state_changes).toHaveLength(1);
    expect(result.state_changes[0]).toMatchObject({
      expediente_id: 24001,
      expediente_numero: '24.001',
      from_estado: 'en_comision',
      to_estado: 'aprobado_primer_debate',
      affected_users: 1,
    });
    expect(result.plazos_recalculated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // At least 1 alert upserted (state_change)
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    expect(alertUpserts.length).toBeGreaterThanOrEqual(1);
    const stateAlert = alertUpserts.find(
      (c) => (c.rows as Record<string, unknown>).alert_type === 'state_change',
    );
    expect(stateAlert).toBeDefined();
    expect((stateAlert!.rows as Record<string, unknown>).user_id).toBe('user-a');
  });

  // ── Test 2: 2 users watching same expediente → 2 alert rows ──────────────────

  it('2 users watching same expediente → 2 state_change alert rows inserted', async () => {
    setWatchlist([
      { entity_id: '25000', user_id: 'user-alice' },
      { entity_id: '25000', user_id: 'user-bob' },
    ]);
    _wfMocks.set(25000, { estado: 'archivado', numero: '25.000' });
    setSilExpediente(25000, 'en_comision', '25.000');

    const result = await syncCentinelaWatchlist();

    expect(result.state_changes[0].affected_users).toBe(2);

    const stateAlerts = _upsertCalls.filter(
      (c) => c.table === 'centinela_alerts' &&
             (c.rows as Record<string, unknown>).alert_type === 'state_change',
    );
    expect(stateAlerts).toHaveLength(2);
    const uIds = stateAlerts.map((c) => (c.rows as Record<string, unknown>).user_id as string);
    expect(uIds).toContain('user-alice');
    expect(uIds).toContain('user-bob');

    // Dedup key is the same for both users (same transition)
    const keys = stateAlerts.map(
      (c) => (c.rows as Record<string, unknown>).dedup_key as string,
    );
    expect(keys[0]).toBe(keys[1]);
    // But user_id differs, so they're distinct rows
    expect(uIds[0]).not.toBe(uIds[1]);
  });

  // ── Test 3: Dedup — second run with unchanged estado → 0 alerts ───────────────

  it('dedup: when stored estado already matches live, no alerts are emitted', async () => {
    setWatchlist([{ entity_id: '26000', user_id: 'user-x' }]);
    _wfMocks.set(26000, { estado: 'en_comision', numero: '26.000' });
    // Stored already matches live — no change
    setSilExpediente(26000, 'en_comision', '26.000');

    const result = await syncCentinelaWatchlist();

    expect(result.state_changes).toHaveLength(0);
    expect(result.alerts_inserted).toBe(0);
    expect(_upsertCalls.filter((c) => c.table === 'centinela_alerts')).toHaveLength(0);
  });

  // ── Test 4: dryRun=true → no DB writes ───────────────────────────────────────

  it('dryRun=true → state_changes reported but no upserts or updates executed', async () => {
    setWatchlist([{ entity_id: '27000', user_id: 'user-dry' }]);
    _wfMocks.set(27000, { estado: 'nuevo_estado', numero: '27.000' });
    setSilExpediente(27000, 'estado_viejo', '27.000');

    const result = await syncCentinelaWatchlist({ dryRun: true });

    // Change detected in the result
    expect(result.state_changes).toHaveLength(1);
    expect(result.state_changes[0].from_estado).toBe('estado_viejo');
    expect(result.state_changes[0].to_estado).toBe('nuevo_estado');

    // No DB writes
    const alertUpserts = _upsertCalls.filter((c) => c.table === 'centinela_alerts');
    const silUpdates = _updateCalls.filter((c) => c.table === 'sil_expedientes');
    const plazoUpserts = _upsertCalls.filter((c) => c.table === 'expediente_plazos');

    expect(alertUpserts).toHaveLength(0);
    expect(silUpdates).toHaveLength(0);
    expect(plazoUpserts).toHaveLength(0);
    expect(result.alerts_inserted).toBe(0);
  });

  // ── Test 5: WebForms error → errors[], processing continues ──────────────────

  it('WebForms error for one expediente → errors[] populated, others processed', async () => {
    setWatchlist([
      { entity_id: '28001', user_id: 'user-e' },
      { entity_id: '28002', user_id: 'user-e' },
    ]);

    // 28001 throws
    _wfMocks.set(28001, 'error');
    // 28002 succeeds, no state change
    _wfMocks.set(28002, { estado: 'en_comision', numero: '28.002' });
    setSilExpediente(28002, 'en_comision', '28.002');

    const result = await syncCentinelaWatchlist();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].expediente_id).toBe(28001);
    expect(result.errors[0].error).toMatch(/404/);

    // 28002 was still processed
    expect(result.expedientes_checked).toBe(1);
    expect(result.watchlist_size).toBe(2);
  });

  // ── Test 6: Plazo threshold crossed → deadline alert ─────────────────────────

  it('plazo threshold crossed → deadline alert generated per user per threshold', async () => {
    setWatchlist([{ entity_id: '29000', user_id: 'user-thr' }]);
    _wfMocks.set(29000, { estado: 'en_comision', numero: '29.000' });
    setSilExpediente(29000, 'archivado', '29.000'); // state changes to en_comision

    // Rule: en_comision triggers dictamen_comision with 1 business day
    setReglamentoPlazos([{
      tipo_plazo: 'dictamen_comision',
      articulo_ref: 'Art. 81',
      estado_disparador: 'en_comision',
      dias_habiles: 1, // dias_restantes will be ~1 → crosses all thresholds
    }]);

    // No previous plazo rows → wasAboveThreshold=true for all thresholds
    setExpedientePlazos([]);
    setAlertPrefs([{ user_id: 'user-thr', deadline_thresholds: [1, 3, 7] }]);

    const result = await syncCentinelaWatchlist();

    expect(result.plazos_recalculated).toBe(1);

    // Expect at least 1 deadline alert
    const deadlineAlerts = _upsertCalls.filter(
      (c) =>
        c.table === 'centinela_alerts' &&
        (c.rows as Record<string, unknown>).alert_type === 'deadline',
    );
    expect(deadlineAlerts.length).toBeGreaterThanOrEqual(1);

    // Verify alert structure
    const dl = deadlineAlerts[0].rows as Record<string, unknown>;
    expect(dl.alert_type).toBe('deadline');
    expect(dl.user_id).toBe('user-thr');
    const payload = dl.payload as Record<string, unknown>;
    expect(payload.tipo_plazo).toBe('dictamen_comision');
    expect(payload.articulo_ref).toBe('Art. 81');
    expect(payload.expediente_id).toBe(29000);

    // Dedup key follows the pattern deadline:<num>:<tipo>:<threshold>d
    const dedupKey = dl.dedup_key as string;
    expect(dedupKey).toMatch(/^deadline:29\.000:dictamen_comision:\d+d$/);
  });

  // ── Test 7: addBusinessDays ───────────────────────────────────────────────────

  describe('addBusinessDays', () => {
    it('Friday + 3 business days = Wednesday (skips Sat+Sun)', () => {
      // 2026-04-24 is a Friday
      const friday = new Date('2026-04-24T00:00:00Z');
      const result = addBusinessDays(friday, 3);
      // Fri → Sat(skip) → Sun(skip) → Mon(1) → Tue(2) → Wed(3) = 2026-04-29
      expect(result.toISOString().slice(0, 10)).toBe('2026-04-29');
    });

    it('Wednesday + 5 business days = next Wednesday', () => {
      // 2026-04-22 is a Wednesday
      const wednesday = new Date('2026-04-22T00:00:00Z');
      const result = addBusinessDays(wednesday, 5);
      // Wed → Thu(1) → Fri(2) → Sat(skip) → Sun(skip) → Mon(3) → Tue(4) → Wed(5) = 2026-04-29
      expect(result.toISOString().slice(0, 10)).toBe('2026-04-29');
    });

    it('adding 0 days returns the same date', () => {
      const d = new Date('2026-04-22T00:00:00Z');
      const result = addBusinessDays(d, 0);
      expect(result.toISOString().slice(0, 10)).toBe('2026-04-22');
    });

    it('does not mutate the input date', () => {
      const start = new Date('2026-04-22T00:00:00Z');
      const original = start.getTime();
      addBusinessDays(start, 5);
      expect(start.getTime()).toBe(original);
    });
  });

  // ── Test 8: Empty watchlist → short-circuit ───────────────────────────────────

  it('empty watchlist → returns zero counts, createSession never called', async () => {
    setWatchlist([]);

    const { createSession } = await import('../services/silWebFormsClient.js');
    const result = await syncCentinelaWatchlist();

    expect(result.watchlist_size).toBe(0);
    expect(result.expedientes_checked).toBe(0);
    expect(result.state_changes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
  });

  // ── Test 9: First-time observation → stores estado, no alert ──────────────────

  it('first-time observation (no stored row) → updates sil_expedientes, no alert emitted', async () => {
    setWatchlist([{ entity_id: '30000', user_id: 'user-new' }]);
    _wfMocks.set(30000, { estado: 'en_comision', numero: '30.000' });
    // No stored row — first time this expediente is watched
    setSilExpedienteNotFound();

    const result = await syncCentinelaWatchlist();

    expect(result.expedientes_checked).toBe(1);
    // No state_change alert on first ingestion (can't diff without prior state)
    expect(result.state_changes).toHaveLength(0);
    expect(result.alerts_inserted).toBe(0);
    // sil_expedientes should have been updated
    const silUpdates = _updateCalls.filter((c) => c.table === 'sil_expedientes');
    expect(silUpdates).toHaveLength(1);
  });

  // ── Test 10: No state change → 0 alerts, 0 plazos ────────────────────────────

  it('no state change → no alerts, no plazos recalculated', async () => {
    setWatchlist([{ entity_id: '31000', user_id: 'user-q' }]);
    _wfMocks.set(31000, { estado: 'en_comision', numero: '31.000' });
    setSilExpediente(31000, 'en_comision', '31.000'); // matches live

    const result = await syncCentinelaWatchlist();

    expect(result.state_changes).toHaveLength(0);
    expect(result.alerts_inserted).toBe(0);
    expect(result.plazos_recalculated).toBe(0);
    expect(_upsertCalls.filter((c) => c.table === 'centinela_alerts')).toHaveLength(0);
    expect(_upsertCalls.filter((c) => c.table === 'expediente_plazos')).toHaveLength(0);
  });

  // ── Test 11: limit option ─────────────────────────────────────────────────────

  it('limit option caps the number of distinct expedientes processed', async () => {
    // 5 distinct expedientes
    setWatchlist([
      { entity_id: '32001', user_id: 'user-lim' },
      { entity_id: '32002', user_id: 'user-lim' },
      { entity_id: '32003', user_id: 'user-lim' },
      { entity_id: '32004', user_id: 'user-lim' },
      { entity_id: '32005', user_id: 'user-lim' },
    ]);
    for (let i = 32001; i <= 32005; i++) {
      _wfMocks.set(i, { estado: 'en_comision', numero: `32.00${i - 32000}` });
    }
    setSilExpediente(32001, 'en_comision', '32.001');

    const result = await syncCentinelaWatchlist({ limit: 2 });

    // Only 2 distinct expedientes in the watchlist slice
    expect(result.watchlist_size).toBe(2);
  });
});
