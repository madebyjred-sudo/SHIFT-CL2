/**
 * Tests for noveltyDetector.ts — pedido 16j del cliente (algoritmo de Carlos).
 *
 * Cubre los 4 tipos de novedades + helpers puros:
 *   1. detectNovedades retorna [] cuando no hay rows en SharePoint
 *   2. Moción "segundo día" sin reflejo en tramite → mocion_segundo_dia_sin_primer_dia
 *   3. Moción con reflejo en tramite dentro de ±5d → no novedad
 *   4. Moción "primer día" sin reflejo → mocion_137_no_reflejada_en_tramite
 *   5. Acta sin evento de tramite en ±3d → acta_sin_evento_tramite
 *   6. Acta con evento dentro de ventana → no novedad
 *   7. Confidence por recencia (3d / 14d / 30d)
 *   8. extractExpedienteNumero (via Title parsing en SharePoint)
 *   9. daysBetween (via ventanas de cruce)
 *  10. Logger emite duration_ms en cada corrida
 *
 * Supabase se mockea al nivel del módulo. No se hace red ni I/O real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Supabase mock ───────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown };

// Per-table mock responses. Tests configuran antes de llamar al subject.
const _tables: Record<string, MockResult | undefined> = {};

// Reset between tests
function resetTables() {
  Object.keys(_tables).forEach((k) => delete _tables[k]);
}

/**
 * Builder fluent que acepta cualquier secuencia de filtros (or/eq/ilike/limit)
 * y termina devolviendo el contenido de `_tables[table]`. Igual API que
 * supabase-js v2.
 */
vi.mock('@supabase/supabase-js', () => {
  function buildChain(table: string): Record<string, (...args: unknown[]) => unknown> {
    const get = (): MockResult => _tables[table] ?? { data: [], error: null };

    const c: Record<string, (...args: unknown[]) => unknown> = {
      // Fluent filter methods — all return `c` for chaining
      eq: () => c,
      or: () => c,
      ilike: () => c,
      limit: () => c,

      // Terminal thenable resolution (await chain)
      then: (...args: unknown[]) =>
        Promise.resolve(get()).then(
          args[0] as Parameters<Promise<MockResult>['then']>[0],
          args[1] as Parameters<Promise<MockResult>['then']>[1],
        ),
      catch: (...args: unknown[]) =>
        Promise.resolve(get()).catch(args[0] as Parameters<Promise<MockResult>['catch']>[0]),

      // Top-of-chain select — devuelve el mismo chain con thenable
      select: () => c,
    };

    return c;
  }

  return {
    createClient: () => ({
      from: (table: unknown) => buildChain(table as string),
    }),
  };
});

// ─── Logger mock — capturado para verificar duration_ms ──────────────────────

const _loggerCalls: Array<{ level: 'info' | 'warn' | 'error'; msg: string; ctx?: unknown }> = [];

vi.mock('./logger.js', () => ({
  logger: {
    info: (msg: string, ctx?: unknown) => _loggerCalls.push({ level: 'info', msg, ctx }),
    warn: (msg: string, ctx?: unknown) => _loggerCalls.push({ level: 'warn', msg, ctx }),
    error: (msg: string, ctx?: unknown) => _loggerCalls.push({ level: 'error', msg, ctx }),
    debug: () => {},
  },
}));

// ─── Subject under test — must come AFTER vi.mock() ──────────────────────────

import { detectNovedades } from './noveltyDetector.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setSharepoint(rows: Array<Record<string, unknown>>) {
  _tables['sil_sharepoint_raw'] = { data: rows, error: null };
}

function setTramite(rows: Array<Record<string, unknown>>) {
  _tables['sil_expediente_tramite'] = { data: rows, error: null };
}

/** ISO date `n` days antes de hoy. */
function daysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('detectNovedades', () => {
  beforeEach(() => {
    resetTables();
    _loggerCalls.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  // ── 1. Caso vacío ──────────────────────────────────────────────────────────

  it('returns [] when no SharePoint rows match the expediente', async () => {
    setSharepoint([]);
    setTramite([]);

    const novedades = await detectNovedades('23.511');

    expect(novedades).toEqual([]);
  });

  // ── 2. Moción segundo día sin reflejo en tramite ───────────────────────────

  it('moción "segundo día" en SharePoint sin reflejo en tramite → mocion_segundo_dia_sin_primer_dia', async () => {
    const fechaConsulta = daysAgoIso(3); // <7 días → confidence 0.9
    setSharepoint([
      {
        list_id: 'L1',
        item_id: 'I1',
        list_title: 'Consultas_mociones',
        scraped_at: fechaConsulta,
        payload: {
          Title: 'Moción art. 137 segundo día — Expediente 23.511 LEY MARCO',
          FechaConsulta: fechaConsulta,
        },
      },
    ]);
    setTramite([]); // ningún evento en tramite

    const novedades = await detectNovedades('23.511');

    // Como el mock no filtra por list_title, la misma row puede ser procesada
    // por ambos algoritmos. Verificamos específicamente la novedad de moción.
    const mocion = novedades.find((n) => n.tipo === 'mocion_segundo_dia_sin_primer_dia');
    expect(mocion).toBeDefined();
    expect(mocion?.expediente_numero).toBe('23.511');
    expect(mocion?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(mocion?.fuentes.aparece_en.sistema).toBe('sharepoint');
    expect(mocion?.fuentes.no_aparece_en.sistema).toBe('sil_expediente_tramite');
    expect(mocion?.fuentes.no_aparece_en.ventana_dias).toBe(5);
  });

  // ── 3. Moción con reflejo dentro de ±5 días → NO novedad ───────────────────

  it('moción con reflejo en tramite dentro de ±5d → no se reporta novedad', async () => {
    const fechaConsulta = '2026-05-12T12:00:00Z';
    const fechaTramite = '2026-05-10T08:00:00Z'; // 2 días de diferencia
    setSharepoint([
      {
        list_id: 'L1',
        item_id: 'I1',
        list_title: 'Consultas_mociones',
        scraped_at: fechaConsulta,
        payload: {
          Title: 'Moción art. 137 segundo día — Expediente 23.511',
          FechaConsulta: fechaConsulta,
        },
      },
    ]);
    setTramite([
      {
        descripcion: 'Mocion 137 remitida a comisión',
        fecha_inicio: fechaTramite,
        organo_legislativo: 'PLENARIO',
      },
    ]);

    // Solo el algoritmo de mociones puede generar match.
    // Como list_title contiene 'Consultas_mociones' (no '%Actas%'),
    // el algoritmo 2 (actas) no agarra esta row → 0 novedades totales.
    const novedades = await detectNovedades('23.511');

    // Filtramos solo las del tipo de mociones para chequear
    const mocionesNovs = novedades.filter(
      (n) =>
        n.tipo === 'mocion_137_no_reflejada_en_tramite' ||
        n.tipo === 'mocion_segundo_dia_sin_primer_dia',
    );
    expect(mocionesNovs).toHaveLength(0);
  });

  // ── 4. Moción primer día sin reflejo → tipo mocion_137_no_reflejada ────────

  it('moción "primer día" sin reflejo → tipo mocion_137_no_reflejada_en_tramite', async () => {
    const fechaConsulta = daysAgoIso(3);
    setSharepoint([
      {
        list_id: 'L1',
        item_id: 'I9',
        list_title: 'Consultas_mociones',
        scraped_at: fechaConsulta,
        payload: {
          Title: 'Moción art. 137 primer día — Expediente 23.987',
          FechaConsulta: fechaConsulta,
        },
      },
    ]);
    setTramite([]);

    const novedades = await detectNovedades('23.987');

    const mocion = novedades.find((n) => n.tipo === 'mocion_137_no_reflejada_en_tramite');
    expect(mocion).toBeDefined();
    expect(mocion?.expediente_numero).toBe('23.987');
  });

  // ── 5. Acta sin evento de tramite ──────────────────────────────────────────

  it('acta sin evento de tramite en ±3d → acta_sin_evento_tramite', async () => {
    const fechaSesion = daysAgoIso(2);
    setSharepoint([
      {
        list_id: 'L2',
        item_id: 'I2',
        list_title: 'Actas',
        scraped_at: fechaSesion,
        payload: {
          Title: 'Acta de sesión — Expediente 23.511',
          FechaSesion: fechaSesion,
        },
      },
    ]);
    setTramite([]);

    const novedades = await detectNovedades('23.511');

    // Como el list_title 'Actas' no matchea con %mociones% ni %Consultas_mociones%
    // en supabase real, el algoritmo de mociones devolvería []. En el mock
    // el filter se aplica en código (extractExpedienteNumero), pero el row
    // SÍ se devuelve para AMBOS algoritmos. El algoritmo de mociones lo
    // procesará igual y emitirá una novedad de tipo mocion_137_no_reflejada
    // porque no hay tramite. Para aislar el caso de actas, verificamos que
    // exista AL MENOS una novedad de tipo acta_sin_evento_tramite.
    const actaNovs = novedades.filter((n) => n.tipo === 'acta_sin_evento_tramite');
    expect(actaNovs).toHaveLength(1);
    expect(actaNovs[0]?.expediente_numero).toBe('23.511');
    expect(actaNovs[0]?.fuentes.no_aparece_en.ventana_dias).toBe(3);
    expect(actaNovs[0]?.confidence).toBeCloseTo(0.7, 5);
  });

  // ── 6. Acta con evento dentro de ventana → NO novedad de tipo acta ─────────

  it('acta con evento de tramite dentro de ±3d → no se reporta acta_sin_evento_tramite', async () => {
    const fechaSesion = '2026-05-14T12:00:00Z';
    const fechaTramite = '2026-05-13T09:00:00Z'; // 1 día de diferencia
    setSharepoint([
      {
        list_id: 'L2',
        item_id: 'I2',
        list_title: 'Actas',
        scraped_at: fechaSesion,
        payload: {
          Title: 'Acta — Expediente 23.511',
          FechaSesion: fechaSesion,
        },
      },
    ]);
    setTramite([
      {
        descripcion: 'Sesión de comisión',
        fecha_inicio: fechaTramite,
        organo_legislativo: 'COMISION',
      },
    ]);

    const novedades = await detectNovedades('23.511');

    const actaNovs = novedades.filter((n) => n.tipo === 'acta_sin_evento_tramite');
    expect(actaNovs).toHaveLength(0);
  });

  // ── 7. Confidence por recencia ─────────────────────────────────────────────

  describe('confidence por recencia del item SharePoint', () => {
    function makeRow(daysAgo: number): Record<string, unknown> {
      const iso = daysAgoIso(daysAgo);
      return {
        list_id: 'L1',
        item_id: `I-${daysAgo}`,
        list_title: 'Consultas_mociones',
        scraped_at: iso,
        payload: {
          Title: 'Moción art. 137 primer día — Expediente 23.511',
          FechaConsulta: iso,
        },
      };
    }

    it('item de 3 días atrás → confidence 0.9', async () => {
      setSharepoint([makeRow(3)]);
      setTramite([]);
      const [nov] = await detectNovedades('23.511');
      expect(nov?.confidence).toBe(0.9);
    });

    it('item de 14 días atrás → confidence 0.75', async () => {
      setSharepoint([makeRow(14)]);
      setTramite([]);
      const [nov] = await detectNovedades('23.511');
      expect(nov?.confidence).toBe(0.75);
    });

    it('item de 30 días atrás → confidence 0.5', async () => {
      setSharepoint([makeRow(30)]);
      setTramite([]);
      const [nov] = await detectNovedades('23.511');
      expect(nov?.confidence).toBe(0.5);
    });
  });

  // ── 8. extractExpedienteNumero — caracterizado vía Title parsing ───────────

  describe('expediente number extraction from SharePoint Title', () => {
    function makeRow(title: string | null | undefined): Record<string, unknown> {
      return {
        list_id: 'L1',
        item_id: 'I-x',
        list_title: 'Consultas_mociones',
        scraped_at: daysAgoIso(3),
        payload: { Title: title, FechaConsulta: daysAgoIso(3) },
      };
    }

    it('title con "23.511 LEY..." extrae 23.511 y matchea expediente', async () => {
      setSharepoint([makeRow('Moción art. 137 — Expediente 23.511 LEY MARCO')]);
      setTramite([]);
      const novs = await detectNovedades('23.511');
      // El número del expediente debe matchear → al menos una novedad para este expediente
      expect(novs.length).toBeGreaterThan(0);
      expect(novs.every((n) => n.expediente_numero === '23.511')).toBe(true);
    });

    it('title sin numero canónico → no matchea ningún expediente', async () => {
      setSharepoint([makeRow('Moción art. 137 sin numero')]);
      setTramite([]);
      const novs = await detectNovedades('23.511');
      expect(novs).toEqual([]);
    });

    it('title null → no matchea', async () => {
      setSharepoint([makeRow(null)]);
      setTramite([]);
      const novs = await detectNovedades('23.511');
      expect(novs).toEqual([]);
    });

    it('title con "1.234" (1 dígito antes del punto) NO matchea regex (mínimo 2 dígitos)', async () => {
      setSharepoint([makeRow('Moción — Expediente 1.234')]);
      setTramite([]);
      const novs = await detectNovedades('1.234');
      expect(novs).toEqual([]);
    });

    it('title con "99.999" matchea regex correctamente', async () => {
      setSharepoint([makeRow('Moción art. 137 primer día — Expediente 99.999')]);
      setTramite([]);
      const novs = await detectNovedades('99.999');
      expect(novs.length).toBeGreaterThan(0);
      expect(novs.every((n) => n.expediente_numero === '99.999')).toBe(true);
    });
  });

  // ── 9. daysBetween — caracterizado por la ventana de cruce ──────────────────

  describe('daysBetween window crossing behavior', () => {
    it('diff = 0 días (mismo día) → match dentro de ventana de ±5d', async () => {
      const iso = '2026-05-12T12:00:00Z';
      setSharepoint([
        {
          list_id: 'L1',
          item_id: 'I1',
          list_title: 'Consultas_mociones',
          scraped_at: iso,
          payload: {
            Title: 'Moción art. 137 — Expediente 23.511',
            FechaConsulta: iso,
          },
        },
      ]);
      setTramite([
        { descripcion: 'moción remitida', fecha_inicio: iso, organo_legislativo: 'PLEN' },
      ]);

      const novs = await detectNovedades('23.511');
      const mocionNovs = novs.filter(
        (n) =>
          n.tipo === 'mocion_137_no_reflejada_en_tramite' ||
          n.tipo === 'mocion_segundo_dia_sin_primer_dia',
      );
      expect(mocionNovs).toHaveLength(0);
    });

    it('diff = 6 días (fuera de ventana ±5d) → SÍ se reporta novedad', async () => {
      const fechaSp = '2026-05-12T12:00:00Z';
      const fechaTr = '2026-05-06T12:00:00Z'; // 6 días
      setSharepoint([
        {
          list_id: 'L1',
          item_id: 'I1',
          list_title: 'Consultas_mociones',
          scraped_at: fechaSp,
          payload: {
            Title: 'Moción art. 137 primer día — Expediente 23.511',
            FechaConsulta: fechaSp,
          },
        },
      ]);
      setTramite([
        { descripcion: 'moción remitida', fecha_inicio: fechaTr, organo_legislativo: 'PLEN' },
      ]);

      const novs = await detectNovedades('23.511');
      const mocionNovs = novs.filter(
        (n) =>
          n.tipo === 'mocion_137_no_reflejada_en_tramite' ||
          n.tipo === 'mocion_segundo_dia_sin_primer_dia',
      );
      expect(mocionNovs).toHaveLength(1);
    });
  });

  // ── 10. Logger duration_ms ─────────────────────────────────────────────────

  it('emite log con duration_ms al terminar la corrida', async () => {
    setSharepoint([]);
    setTramite([]);

    await detectNovedades('23.511');

    const doneLog = _loggerCalls.find(
      (c) => c.level === 'info' && c.msg.includes('[noveltyDetector] done'),
    );
    expect(doneLog).toBeDefined();
    const ctx = doneLog!.ctx as Record<string, unknown>;
    expect(ctx.expediente).toBe('23.511');
    expect(typeof ctx.duration_ms).toBe('number');
    expect(ctx.novedades_count).toBe(0);
  });

  // ── 11. Bonus: error en sharepoint query → [] sin throw ────────────────────

  it('error en sharepoint query → captura el warn y retorna []', async () => {
    _tables['sil_sharepoint_raw'] = {
      data: null,
      error: { message: 'connection lost' },
    };
    setTramite([]);

    const novs = await detectNovedades('23.511');

    expect(novs).toEqual([]);
    const warnLog = _loggerCalls.find(
      (c) => c.level === 'warn' && c.msg.includes('sharepoint query failed'),
    );
    expect(warnLog).toBeDefined();
  });
});
