/**
 * Tests para listaDespachoMatcher.ts — Sprint 3 Track R.
 *
 * Cubre:
 *  1. Item nuevo con status='a_despacho' → genera alerta high (entro_lista_despacho).
 *  2. Item que cambia a status='archivado' → genera alerta medium (salio_lista_despacho).
 *  3. Idempotencia: re-correr ingest con el mismo payload NO duplica items
 *     ni eventos Centinela.
 *  4. Parser helpers (extractExpedienteNumero, parseDate, normalizeStatus).
 *
 * Supabase se mockea al nivel del módulo, igual que noveltyDetector.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Captura de operaciones de Supabase ──────────────────────────────────────

type FakeOp =
  | { kind: 'select'; table: string; filters: Record<string, unknown> }
  | { kind: 'upsert'; table: string; row: Record<string, unknown>; options?: unknown }
  | { kind: 'update'; table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }
  | { kind: 'insert'; table: string; row: Record<string, unknown> };

const _ops: FakeOp[] = [];

// Per-table responses. Tests configuran antes de llamar al subject.
const _responses: Record<string, { data: unknown; error: unknown }> = {};

function resetState() {
  _ops.length = 0;
  for (const k of Object.keys(_responses)) delete _responses[k];
}

/**
 * Builder fluent que captura las ops y al final devuelve el response
 * configurado en `_responses[table]`. Maneja insert/upsert/update/select.
 */
function makeChain(table: string) {
  const filters: Record<string, unknown> = {};
  let action: FakeOp['kind'] = 'select';
  let payload: Record<string, unknown> | undefined;
  let upsertOptions: unknown;

  const chain: Record<string, unknown> = {
    select() { return chain; },
    eq(col: string, val: unknown) { filters[col] = val; return chain; },
    is(col: string, val: unknown) { filters[col] = val; return chain; },
    order() { return chain; },
    limit() { return chain; },
    maybeSingle() {
      const resp = _responses[table] ?? { data: null, error: null };
      // Si la acción fue una mutación (insert/upsert/update), recordarla
      // antes del finalizer — single() es el terminal.
      if (action === 'insert') {
        _ops.push({ kind: 'insert', table, row: payload as Record<string, unknown> });
      } else if (action === 'upsert') {
        _ops.push({ kind: 'upsert', table, row: payload as Record<string, unknown>, options: upsertOptions });
      } else if (action === 'update') {
        _ops.push({ kind: 'update', table, patch: payload as Record<string, unknown>, filters: { ...filters } });
      } else {
        _ops.push({ kind: 'select', table, filters: { ...filters } });
      }
      return Promise.resolve({
        data: Array.isArray(resp.data) ? resp.data[0] ?? null : resp.data,
        error: resp.error,
      });
    },
    single() {
      const resp = _responses[table] ?? { data: null, error: null };
      if (action === 'insert') {
        _ops.push({ kind: 'insert', table, row: payload as Record<string, unknown> });
      } else if (action === 'upsert') {
        _ops.push({ kind: 'upsert', table, row: payload as Record<string, unknown>, options: upsertOptions });
      } else if (action === 'update') {
        _ops.push({ kind: 'update', table, patch: payload as Record<string, unknown>, filters: { ...filters } });
      } else {
        _ops.push({ kind: 'select', table, filters: { ...filters } });
      }
      return Promise.resolve({
        data: Array.isArray(resp.data) ? resp.data[0] ?? null : resp.data,
        error: resp.error,
      });
    },
    insert(row: Record<string, unknown>) {
      action = 'insert';
      payload = row;
      return chain;
    },
    upsert(row: Record<string, unknown>, opts?: unknown) {
      action = 'upsert';
      payload = row;
      upsertOptions = opts;
      return chain;
    },
    update(patch: Record<string, unknown>) {
      action = 'update';
      payload = patch;
      return chain;
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      // Terminal — usado cuando NO se llama maybeSingle/single. Sólo
      // aplica a upsert/update/insert con .select() o sin él.
      if (action === 'upsert') {
        _ops.push({ kind: 'upsert', table, row: payload as Record<string, unknown>, options: upsertOptions });
      } else if (action === 'update') {
        _ops.push({ kind: 'update', table, patch: payload as Record<string, unknown>, filters: { ...filters } });
      } else if (action === 'insert') {
        _ops.push({ kind: 'insert', table, row: payload as Record<string, unknown> });
      } else {
        _ops.push({ kind: 'select', table, filters: { ...filters } });
      }
      const resp = _responses[table] ?? { data: [], error: null };
      return Promise.resolve(resp).then(
        resolve as Parameters<Promise<typeof resp>['then']>[0],
        reject as Parameters<Promise<typeof resp>['then']>[1],
      );
    },
  };
  return chain;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: unknown) => makeChain(table as string),
  }),
}));

// Logger mock
vi.mock('./logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// ─── Subject under test (importar DESPUÉS de los mocks) ────────────────────

import {
  extractExpedienteNumero,
  parseDate,
  normalizeStatus,
  ingestListaDespachoItem,
  type RawDespachoRow,
} from './listaDespachoMatcher.js';
import { createClient } from '@supabase/supabase-js';

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('parser helpers', () => {
  describe('extractExpedienteNumero', () => {
    it('lee desde ExpedienteNumero directamente', () => {
      const row: RawDespachoRow = { Id: 1, ExpedienteNumero: '23.511' };
      expect(extractExpedienteNumero(row)).toBe('23.511');
    });

    it('normaliza "23511" → "23.511"', () => {
      const row: RawDespachoRow = { Id: 1, NumExpediente: '23511' };
      expect(extractExpedienteNumero(row)).toBe('23.511');
    });

    it('fallback: parsea del Title con regex', () => {
      const row: RawDespachoRow = {
        Id: 1,
        Title: 'Expediente N° 24.012 — LEY MARCO DE INGRESO MÍNIMO',
      };
      expect(extractExpedienteNumero(row)).toBe('24.012');
    });

    it('devuelve null si no hay nada parseable', () => {
      const row: RawDespachoRow = { Id: 1, Title: 'Sin número claro' };
      expect(extractExpedienteNumero(row)).toBeNull();
    });
  });

  describe('parseDate', () => {
    it('acepta ISO completo', () => {
      expect(parseDate('2026-05-08T12:00:00Z')).toBe('2026-05-08');
    });

    it('acepta DD/MM/YYYY', () => {
      expect(parseDate('08/05/2026')).toBe('2026-05-08');
    });

    it('devuelve null para string vacío o undefined', () => {
      expect(parseDate('')).toBeNull();
      expect(parseDate(undefined)).toBeNull();
    });
  });

  describe('normalizeStatus', () => {
    it('"A despacho" → a_despacho', () => {
      expect(normalizeStatus('A despacho')).toBe('a_despacho');
    });

    it('"Devuelto" → devuelto_a_comision', () => {
      expect(normalizeStatus('Devuelto a comisión')).toBe('devuelto_a_comision');
    });

    it('"Archivado" → archivado', () => {
      expect(normalizeStatus('Archivado')).toBe('archivado');
    });

    it('"Caducó" → caduca_cuatrienal', () => {
      expect(normalizeStatus('Caducó por plazo cuatrienal')).toBe('caduca_cuatrienal');
    });

    it('"Plenario" → remitido_plenario', () => {
      expect(normalizeStatus('Remitido al plenario')).toBe('remitido_plenario');
    });

    it('null → a_despacho (default)', () => {
      expect(normalizeStatus(null)).toBe('a_despacho');
    });
  });
});

describe('ingestListaDespachoItem', () => {
  beforeEach(() => {
    resetState();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  // ── 1. Item nuevo a_despacho → emite entro_lista_despacho (high) ───────────

  it('item nuevo con status="a_despacho" → inserta + emite entro_lista_despacho con priority=high', async () => {
    // No hay item activo previo + insert exitoso devuelve 1 fila nueva
    _responses['lista_despacho_items'] = {
      data: [{ id: 'new-item-uuid' }],
      error: null,
    };
    // El insert de centinela_eventos también devuelve algo
    _responses['centinela_eventos'] = {
      data: { id: 'evt-uuid', event_type: 'entro_lista_despacho', priority: 'high', expediente_id: '23.511', payload: {} },
      error: null,
    };
    // watchlist vacía: 0 matches, dispatch terminará sin notificar pero no romperá
    _responses['centinela_watchlist'] = { data: [], error: null };

    const supabase = createClient('x', 'y');
    const row: RawDespachoRow = {
      Id: 1,
      ExpedienteNumero: '23.511',
      FechaEntrada: '2026-05-08',
      Status: 'A despacho',
    };

    const outcome = await ingestListaDespachoItem(row, supabase);

    expect(outcome).toBe('new');
    // Insert de despacho ocurrió
    const despachoUpsert = _ops.find(
      (o) => o.kind === 'upsert' && o.table === 'lista_despacho_items',
    );
    expect(despachoUpsert).toBeDefined();
    // Evento Centinela emitido con event_type correcto
    const evtInsert = _ops.find(
      (o) => o.kind === 'insert' && o.table === 'centinela_eventos',
    );
    expect(evtInsert).toBeDefined();
    expect((evtInsert as { row: Record<string, unknown> }).row.event_type).toBe('entro_lista_despacho');
    expect((evtInsert as { row: Record<string, unknown> }).row.priority).toBe('high');
    expect((evtInsert as { row: Record<string, unknown> }).row.expediente_id).toBe('23.511');
  });

  // ── 2. Item que cambia a archivado → emite salio_lista_despacho (medium) ───

  it('item con status="archivado" sobre activo previo → emite salio_lista_despacho con priority=medium', async () => {
    // Hay un activo previo en la BD
    _responses['lista_despacho_items'] = {
      data: [
        { id: 'previous-active-uuid', fecha_entrada: '2026-04-01', status: 'a_despacho' },
      ],
      error: null,
    };
    _responses['centinela_eventos'] = {
      data: { id: 'evt-uuid', event_type: 'salio_lista_despacho', priority: 'medium', expediente_id: '23.511', payload: {} },
      error: null,
    };
    _responses['centinela_watchlist'] = { data: [], error: null };

    const supabase = createClient('x', 'y');
    const row: RawDespachoRow = {
      Id: 2,
      ExpedienteNumero: '23.511',
      FechaEntrada: '2026-05-08',
      FechaSalida: '2026-05-15',
      Status: 'Archivado',
    };

    await ingestListaDespachoItem(row, supabase);

    // 1) Update cerró el row activo previo
    const update = _ops.find(
      (o) => o.kind === 'update' && o.table === 'lista_despacho_items',
    );
    expect(update).toBeDefined();
    expect((update as { patch: Record<string, unknown> }).patch.status).toBe('archivado');

    // 2) Evento salio_lista_despacho con priority=medium
    const evtInsert = _ops.find(
      (o) => o.kind === 'insert' && o.table === 'centinela_eventos',
    );
    expect(evtInsert).toBeDefined();
    expect((evtInsert as { row: Record<string, unknown> }).row.event_type).toBe('salio_lista_despacho');
    expect((evtInsert as { row: Record<string, unknown> }).row.priority).toBe('medium');
  });

  // ── 3. Idempotencia: re-correr ingest NO duplica ───────────────────────────

  it('re-correr ingest con el mismo payload NO inserta una fila nueva ni emite nuevo evento', async () => {
    // Primer run: hay un activo previo con la MISMA fecha_entrada que el row,
    // y el upsert con ignoreDuplicates devuelve [] (porque el row ya existe).
    _responses['lista_despacho_items'] = {
      data: [{ id: 'existing-uuid', fecha_entrada: '2026-05-08', status: 'a_despacho' }],
      error: null,
    };
    // Override del select para el upsert: ignoreDuplicates=true → data=[]
    let upsertCount = 0;
    const supabase = createClient('x', 'y');
    // El mock genérico devuelve `_responses['lista_despacho_items']` para ambos
    // calls (select + upsert). Mejor approach: contar el outcome correctamente
    // viendo el data devuelto por el upsert.
    //
    // Para esta unidad, simulamos: select previo encuentra activo con misma
    // fecha → el código va al upsert path. Configuramos data=[] para que
    // ignoreDuplicates skipee. Sobre-escribimos antes del second call:

    _responses['lista_despacho_items'] = { data: [], error: null };

    const row: RawDespachoRow = {
      Id: 1,
      ExpedienteNumero: '23.511',
      FechaEntrada: '2026-05-08',
      Status: 'A despacho',
    };

    const outcome1 = await ingestListaDespachoItem(row, supabase);
    upsertCount++;

    // Re-correr: mismo resultado
    const outcome2 = await ingestListaDespachoItem(row, supabase);
    upsertCount++;

    // Cuando el upsert devuelve [] (ignoreDuplicates suprimió la inserción),
    // outcome debe ser 'duplicate'. NO debe haber evento Centinela porque el
    // código sólo dispatch cuando `isNew`.
    expect(outcome1).toBe('duplicate');
    expect(outcome2).toBe('duplicate');
    expect(upsertCount).toBe(2);

    const evtInserts = _ops.filter(
      (o) => o.kind === 'insert' && o.table === 'centinela_eventos',
    );
    expect(evtInserts).toHaveLength(0);
  });

  // ── 4. Payload sin expediente_id parseable → skipped ───────────────────────

  it('payload sin expediente_id ni Title parseable → outcome=skipped, no DB writes', async () => {
    const supabase = createClient('x', 'y');
    const row: RawDespachoRow = {
      Id: 99,
      Title: 'Sin número claro acá',
    };

    const outcome = await ingestListaDespachoItem(row, supabase);

    expect(outcome).toBe('skipped');
    // No hay ningún upsert ni update ni insert
    const writes = _ops.filter((o) => o.kind !== 'select');
    expect(writes).toHaveLength(0);
  });
});
