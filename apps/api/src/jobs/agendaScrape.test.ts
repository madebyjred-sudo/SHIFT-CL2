/**
 * Unit tests for agendaScrape.ts (rewritten 2026-04-28).
 *
 * The job now speaks ASP.NET WebForms (consultassil3.asamblea.go.cr/
 * frmOrdenDiaPlenario.aspx) with VIEWSTATE postbacks that return DOCX bytes,
 * not the previous HTML-table guess. These tests focus on:
 *
 *   - Pure helpers (parseSessionList, normalizeDate, extractExpedientesFromText)
 *     where the contract is HTML-in / structured-out, fully testable without
 *     fetch or supabase.
 *   - One integration smoke test for the unreachable-bootstrap path, which
 *     is the most important failure mode to handle gracefully.
 *
 * The full DOCX postback round-trip is exercised by the live integration
 * test (`apps/api/src/jobs/agendaScrape.live.test.ts`, opt-in) — we don't
 * mock mammoth or VIEWSTATE state machines in unit tests because the value
 * is in catching real schema drift, which only the live test can do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fetch mock ────────────────────────────────────────────────────────────────

let _fetchResponse: {
  ok: boolean;
  status: number;
  headers?: Headers;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
} = {
  ok: false,
  status: 404,
  text: async () => '',
};

vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: unknown, _opts: unknown) => _fetchResponse as unknown as Response),
);

// ── Supabase mock ─────────────────────────────────────────────────────────────

const _tables: Record<string, { data: unknown; error: unknown }> = {};
const _upsertCalls: Array<{ table: string; rows: unknown; opts?: unknown }> = [];

vi.mock('@supabase/supabase-js', () => {
  function chain(table: string): Record<string, (...args: unknown[]) => unknown> {
    return {
      select: () => ({
        eq: () => Promise.resolve(_tables[table] ?? { data: [], error: null }),
      }),
      upsert: (rows: unknown, opts?: unknown) => {
        _upsertCalls.push({ table, rows, opts });
        return Promise.resolve({ data: null, error: null });
      },
    };
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
  scrapeAgenda,
  parseSessionList,
  normalizeDate,
  extractExpedientesFromText,
  _resetSupaClient,
} from './agendaScrape.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal HTML mirroring the live grvOrdenDia structure (verified 2026-04-28). */
function makeGridHtml(sessions: Array<{
  codigo: string;
  fecha: string; // 'DD-mmm.-YYYY'
  hora: string;
  estado: string;
  serverId?: string;
}>): string {
  const rows = sessions
    .map(
      (s, i) => `
    <tr>
      <td>${s.codigo}</td>
      <td>${s.fecha}</td>
      <td>${s.hora}</td>
      <td>ORDINARIA</td>
      <td>${s.estado}</td>
      <td>${s.serverId ?? 1000 + i}</td>
      <td><input type="image" class="btn" onclick="javascript:__doPostBack('ctl00$ContentPlaceHolder1$grvOrdenDia','Select$${i}');return false;" /></td>
    </tr>`,
    )
    .join('');
  return `<html><body>
    <input type="hidden" name="__VIEWSTATE" value="VIEWSTATE_VALUE" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" value="GENERATOR_VALUE" />
    <input type="hidden" name="__EVENTVALIDATION" value="EVENTVALIDATION_VALUE" />
    <table id="ContentPlaceHolder1_grvOrdenDia" class="gridview">
      <tr>
        <th>Orden del Día</th><th>Fecha de sesión</th><th>Hora</th>
        <th>Tipo</th><th>Estado</th><th>Id</th><th></th>
      </tr>
      ${rows}
    </table>
  </body></html>`;
}

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe('normalizeDate', () => {
  it('SIL format "04-may.-2026" → "2026-05-04"', () => {
    expect(normalizeDate('04-may.-2026')).toBe('2026-05-04');
  });
  it('SIL format without dot "04-may-2026" → "2026-05-04"', () => {
    expect(normalizeDate('04-may-2026')).toBe('2026-05-04');
  });
  it('"setiembre" alias → 09', () => {
    expect(normalizeDate('15-set.-2026')).toBe('2026-09-15');
  });
  it('DD/MM/YYYY → YYYY-MM-DD', () => {
    expect(normalizeDate('15/04/2026')).toBe('2026-04-15');
  });
  it('already ISO stays the same', () => {
    expect(normalizeDate('2026-04-15')).toBe('2026-04-15');
  });
  it('Spanish prose: "15 de abril de 2026"', () => {
    expect(normalizeDate('15 de abril de 2026')).toBe('2026-04-15');
  });
  it('empty / unparseable → null', () => {
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('not a date')).toBeNull();
  });
});

describe('extractExpedientesFromText', () => {
  it('finds NN.NNN format with snippet', () => {
    const text = 'Sesión Plenaria: discusión del expediente 24.429, Reforma fiscal integral...';
    const out = extractExpedientesFromText(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.expediente_numero).toBe('24.429');
    expect(out[0]!.titulo).toContain('24.429');
    expect(out[0]!.titulo).toContain('Reforma');
  });
  it('deduplicates repeated numbers', () => {
    const text = '24.429 ... continuamos con 24.429 ... y luego 25.100';
    const out = extractExpedientesFromText(text);
    expect(out.map((e) => e.expediente_numero).sort()).toEqual(['24.429', '25.100']);
  });
  it('returns empty when no expediente numbers found', () => {
    expect(extractExpedientesFromText('Acta de la sesión sin números')).toEqual([]);
  });
});

describe('parseSessionList', () => {
  it('parses one row from a minimal grvOrdenDia', () => {
    const html = makeGridHtml([
      { codigo: '2026-2027-PLENARIO-SESION-2', fecha: '04-may.-2026', hora: '14:45', estado: 'PENDIENTE' },
    ]);
    const out = parseSessionList(html);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      codigo: '2026-2027-PLENARIO-SESION-2',
      fecha: '2026-05-04',
      hora_inicio: '14:45',
      estado: 'PENDIENTE',
      postbackIndex: 0,
    });
  });

  it('parses multiple rows with sequential postback indices', () => {
    const html = makeGridHtml([
      { codigo: 'SESION-1', fecha: '01-may.-2026', hora: '09:00', estado: 'PENDIENTE' },
      { codigo: 'SESION-2', fecha: '04-may.-2026', hora: '14:45', estado: 'PENDIENTE' },
      { codigo: 'SESION-3', fecha: '06-may.-2026', hora: '14:45', estado: 'REALIZADA' },
    ]);
    const out = parseSessionList(html);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.postbackIndex)).toEqual([0, 1, 2]);
    expect(out[2]!.estado).toBe('REALIZADA');
  });

  it('returns empty array when no grvOrdenDia exists', () => {
    expect(parseSessionList('<html><body><p>nope</p></body></html>')).toEqual([]);
  });
});

// ── Integration tests (limited) ───────────────────────────────────────────────

describe('scrapeAgenda', () => {
  beforeEach(() => {
    _upsertCalls.length = 0;
    Object.keys(_tables).forEach((k) => delete _tables[k]);
    _resetSupaClient();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  });

  it('agenda unreachable (bootstrap GET 404): returns scraped_count=0, errors contains agenda_unreachable', async () => {
    _fetchResponse = {
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    };
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await scrapeAgenda({ dryRun: false });

    expect(result.scraped_count).toBe(0);
    expect(result.agenda_inserted).toBe(0);
    expect(result.alerts_inserted).toBe(0);
    expect(result.errors).toContain('agenda_unreachable');
  });

  it('bootstrap succeeds but grid is empty: scraped_count=0, no errors', async () => {
    _fetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => makeGridHtml([]),
    };
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await scrapeAgenda({ dryRun: false });

    expect(result.scraped_count).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(_upsertCalls).toHaveLength(0);
  });

  it('all sessions out of date window: scraped_count=0', async () => {
    _fetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        makeGridHtml([
          // Far past
          { codigo: 'OLD', fecha: '04-ene.-2024', hora: '14:45', estado: 'REALIZADA' },
        ]),
    };
    _tables['centinela_watchlist'] = { data: [], error: null };

    const result = await scrapeAgenda({ dryRun: false, daysAhead: 14 });

    expect(result.scraped_count).toBe(0);
  });
});
