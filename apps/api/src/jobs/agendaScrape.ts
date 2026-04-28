/**
 * Agenda-scrape job — scrape the Asamblea's orden del día and generate
 * 'agenda' alerts for watched expedientes.
 *
 * SOURCE: https://www.asamblea.go.cr/Orden_Dia/ (HTML, no API).
 * The page structure is unknown without a live test. Selectors are best-guess
 * based on common Costa Rican legislative portal patterns (tabla-driven layout).
 * TODO: validate selectors against live HTML before promoting to production.
 *
 * PIPELINE:
 *   1. Fetch HTML with withTimeout(30s) + withRetry(2 attempts)
 *   2. Parse with cheerio: extract rows with { fecha, comision, hora_inicio, titulo, expediente_numero? }
 *   3. UPSERT each row into agenda_legislativa (unique: fecha, comision, titulo)
 *   4. For rows with expediente_numero matching centinela_watchlist entries,
 *      insert 'agenda' alerts with dedup_key `agenda:${fecha}:${expediente_numero}`
 *   5. Return result
 *
 * RESILIENCE:
 *   - 404 / unreachable: log warning, return { scraped_count: 0, error: 'agenda_unreachable' }
 *   - Row parse failure: skip that row, continue
 *   - Empty watchlist: zero alerts, scrape still proceeds
 *
 * MODULE CONTRACT:
 *   - Pure async function, no Express coupling.
 *   - Uses service_role Supabase client.
 *   - Idempotent: re-running on same agenda produces 0 net inserts (ON CONFLICT DO NOTHING).
 */

import * as cheerio from 'cheerio';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withTimeout, withRetry } from '../services/resilience.js';
import { logger } from '../services/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENDA_URL = 'https://www.asamblea.go.cr/Orden_Dia/';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_ATTEMPTS = 2;
const FETCH_RETRY_BASE_MS = 2_000;

// ── Supabase client (lazy, service role) ─────────────────────────────────────

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      'supabase env missing for agendaScrape (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AgendaScrapeResult {
  scraped_count: number;
  agenda_inserted: number;
  alerts_inserted: number;
  errors: string[];
  duration_ms: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface AgendaRow {
  fecha: string;           // ISO date string: 'YYYY-MM-DD'
  comision: string | null; // null = plenario
  hora_inicio: string | null; // 'HH:MM' or null
  titulo: string;
  expediente_numero: string | null; // '24.429' format or null
}

interface WatchlistExpedienteEntry {
  user_id: string;
  entity_id: string; // expediente_numero as stored in watchlist
}

// ── HTML fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch agenda HTML from the Asamblea portal.
 * Returns null if unreachable (non-2xx or network error).
 */
async function fetchAgendaHtml(): Promise<string | null> {
  try {
    const res = await withRetry(
      () =>
        withTimeout(
          (signal) =>
            fetch(AGENDA_URL, {
              signal,
              headers: {
                // Identify ourselves politely
                'User-Agent': 'CL2-Centinela/1.0 (+https://agentescl2.com)',
                Accept: 'text/html,application/xhtml+xml',
              },
            }),
          { ms: FETCH_TIMEOUT_MS, label: 'agendaScrape:fetch' },
        ),
      {
        attempts: FETCH_RETRY_ATTEMPTS,
        baseDelayMs: FETCH_RETRY_BASE_MS,
        label: 'agendaScrape:fetch',
        shouldRetry: (err, _attempt) => {
          // Don't retry on 4xx (404 means the page doesn't exist in that form)
          if (err instanceof Error && err.message.includes('HTTP 4')) return false;
          return true;
        },
      },
    );

    if (!res.ok) {
      logger.warn('agenda_scrape_fetch_non2xx', { status: res.status, url: AGENDA_URL });
      return null;
    }

    return await res.text();
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn('agenda_scrape_fetch_error', { error: message, url: AGENDA_URL });
    return null;
  }
}

// ── HTML parser ───────────────────────────────────────────────────────────────

/**
 * Normalize a Costa Rica date string to ISO format.
 * Handles: 'DD/MM/YYYY', 'YYYY-MM-DD', 'D de Mes de YYYY'
 * Returns null if unparseable.
 */
const MONTH_MAP: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  setiembre: '09', septiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};

function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // 'DD/MM/YYYY'
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return `${y}-${m.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  // 'YYYY-MM-DD' already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // 'D de Mes de YYYY' or 'D de Mes YYYY'
  const spanishMatch = s.match(/^(\d{1,2})\s+de\s+(\w+)(?:\s+de)?\s+(\d{4})$/i);
  if (spanishMatch) {
    const [, d, mes, y] = spanishMatch;
    const m = MONTH_MAP[mes!.toLowerCase()];
    if (m) return `${y}-${m}-${d!.padStart(2, '0')}`;
  }

  return null;
}

/**
 * Extract expediente number (e.g. '24.429') from free text.
 * Matches the pattern NN.NNN (2+ digits, dot, 3 digits).
 */
function extractExpedienteNumero(text: string): string | null {
  const match = text.match(/\b(\d{2,5}\.\d{3})\b/);
  return match ? match[1]! : null;
}

/**
 * Parse agenda HTML into rows.
 *
 * TODO: validate selectors against live HTML; current selectors are best-guess
 * based on typical ASP.NET WebForms tabla layout observed on Costa Rican
 * government portals. The Asamblea portal uses nested tables — we target
 * the innermost data tables and scan rows for date/comision/time/title fields.
 *
 * Strategy (defensive, multi-attempt):
 *   1. Try to find a dedicated agenda table with date + comision + title columns
 *   2. Fall back to extracting any row that contains an expediente number
 *
 * Returns an array of parsed rows (possibly empty on parse failure).
 */
function parseAgendaHtml(html: string, daysAhead: number): AgendaRow[] {
  const rows: AgendaRow[] = [];
  const $ = cheerio.load(html);

  // Determine date range to accept: today through today + daysAhead
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setUTCDate(maxDate.getUTCDate() + daysAhead);

  /**
   * Attempt 1: look for tables with headers that mention Fecha/Comisión/Hora/Proyecto.
   * This targets explicitly structured agenda tables.
   */
  $('table').each((_, table) => {
    const headerCells = $(table).find('tr').first().find('th, td');
    if (headerCells.length === 0) return; // no header row

    // Build column index map by scanning header text
    const colMap: Record<string, number> = {};
    headerCells.each((colIdx, cell) => {
      const text = $(cell).text().toLowerCase().trim();
      if (/fecha/.test(text)) colMap['fecha'] = colIdx;
      else if (/comisi[oó]n/.test(text)) colMap['comision'] = colIdx;
      else if (/hora/.test(text)) colMap['hora'] = colIdx;
      else if (/proyecto|expediente|asunto|punto/.test(text)) colMap['titulo'] = colIdx;
    });

    // Need at least a title-like column to proceed
    if (colMap['titulo'] === undefined && colMap['fecha'] === undefined) return;

    $(table)
      .find('tr')
      .slice(1) // skip header row
      .each((_, tr) => {
        try {
          const cells = $(tr).find('td');
          if (cells.length === 0) return;

          const getCell = (key: string): string =>
            colMap[key] !== undefined
              ? $(cells[colMap[key]!]).text().replace(/\s+/g, ' ').trim()
              : '';

          const rawFecha = getCell('fecha');
          const rawComision = getCell('comision');
          const rawHora = getCell('hora');
          const rawTitulo = getCell('titulo') || $(tr).text().replace(/\s+/g, ' ').trim();

          if (!rawTitulo) return; // empty row

          // If fecha column exists, parse it; otherwise use today's date
          let fecha: string | null = null;
          if (rawFecha) {
            fecha = normalizeDate(rawFecha);
          }
          // Default to today if no date found in this row
          if (!fecha) fecha = today.toISOString().slice(0, 10);

          // Filter by date range
          const fechaDate = new Date(fecha + 'T00:00:00Z');
          if (fechaDate < today || fechaDate > maxDate) return;

          const comision = rawComision
            ? rawComision.toLowerCase().includes('plenario')
              ? null
              : rawComision || null
            : null;

          const hora_inicio = rawHora ? rawHora.match(/\d{1,2}:\d{2}/)?.[0] ?? null : null;
          const expediente_numero = extractExpedienteNumero(rawTitulo);

          rows.push({ fecha, comision, hora_inicio, titulo: rawTitulo.slice(0, 500), expediente_numero });
        } catch (err) {
          // Per-row parse failure: skip and continue
          logger.warn('agenda_scrape_row_parse_error', {
            error: (err as Error)?.message ?? String(err),
          });
        }
      });
  });

  /**
   * Attempt 2 (fallback): if no structured table found, scan all rows for
   * any expediente number pattern. This is a best-effort heuristic.
   */
  if (rows.length === 0) {
    $('tr').each((_, tr) => {
      try {
        const text = $(tr).text().replace(/\s+/g, ' ').trim();
        if (!text) return;

        const expediente_numero = extractExpedienteNumero(text);
        if (!expediente_numero) return; // only grab rows mentioning an expediente

        const fecha = today.toISOString().slice(0, 10);
        rows.push({
          fecha,
          comision: null,
          hora_inicio: null,
          titulo: text.slice(0, 500),
          expediente_numero,
        });
      } catch {
        // skip
      }
    });
  }

  return rows;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

/**
 * Load all distinct expediente entity_ids from centinela_watchlist
 * that are of entity_type 'expediente'. Returns a map from expediente_numero
 * (e.g. '24.429') to list of user_ids.
 *
 * NOTE: watchlist stores entity_id — which for expedientes is the SIL integer ID
 * (e.g. '24429'), but display number is '24.429'. We store BOTH formats in the
 * map to match against agenda rows regardless of format.
 */
async function loadExpedienteWatchlist(): Promise<Map<string, string[]>> {
  const { data, error } = await supa()
    .from('centinela_watchlist')
    .select('entity_id, user_id')
    .eq('entity_type', 'expediente');

  if (error) throw new Error(`agendaScrape:loadWatchlist: ${error.message}`);

  const map = new Map<string, string[]>();
  for (const row of (data ?? []) as WatchlistExpedienteEntry[]) {
    const id = row.entity_id.trim();
    // Store as-is
    const existing = map.get(id) ?? [];
    existing.push(row.user_id);
    map.set(id, existing);
    // Also store with dot-format (e.g. '24429' → '24.429')
    if (/^\d{5,}$/.test(id)) {
      const dotted = id.slice(0, -3) + '.' + id.slice(-3);
      const e2 = map.get(dotted) ?? [];
      e2.push(row.user_id);
      map.set(dotted, e2);
    }
    // Also store without dot (e.g. '24.429' → '24429')
    if (/^\d{2,5}\.\d{3}$/.test(id)) {
      const plain = id.replace('.', '');
      const e3 = map.get(plain) ?? [];
      e3.push(row.user_id);
      map.set(plain, e3);
    }
  }
  return map;
}

/**
 * UPSERT an agenda row. Uses ON CONFLICT DO NOTHING on (fecha, comision, titulo).
 * Returns true if a new row was inserted.
 */
async function upsertAgendaRow(row: AgendaRow, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;

  const { error } = await supa()
    .from('agenda_legislativa')
    .upsert(
      {
        fecha: row.fecha,
        comision: row.comision ?? null,
        expediente_numero: row.expediente_numero ?? null,
        titulo: row.titulo,
        hora_inicio: row.hora_inicio ?? null,
        scraped_at: new Date().toISOString(),
      },
      { onConflict: 'fecha,comision,titulo', ignoreDuplicates: true },
    );

  if (error) throw new Error(`agendaScrape:upsertAgendaRow: ${error.message}`);
  return true; // we can't distinguish insert vs no-op without .select(), caller accumulates
}

/**
 * Insert an 'agenda' alert for a single user. Idempotent via ON CONFLICT DO NOTHING.
 */
async function insertAgendaAlert(
  userId: string,
  agendaRow: AgendaRow,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  const dedupKey = `agenda:${agendaRow.fecha}:${agendaRow.expediente_numero}`;

  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: 'expediente',
        entity_id: agendaRow.expediente_numero ?? '',
        alert_type: 'agenda',
        severity: 'info',
        dedup_key: dedupKey,
        payload: {
          fecha: agendaRow.fecha,
          comision: agendaRow.comision,
          hora_inicio: agendaRow.hora_inicio,
          titulo: agendaRow.titulo,
          expediente_numero: agendaRow.expediente_numero,
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );

  if (error) throw new Error(`agendaScrape:insertAgendaAlert(${userId}): ${error.message}`);
  return true;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Scrape the Asamblea's order-of-business, populate agenda_legislativa,
 * and generate 'agenda' alerts for watched expedientes.
 *
 * @param opts.daysAhead   How many days ahead to accept from the agenda (default 14)
 * @param opts.dryRun      If true, no DB writes; result shows what would be inserted
 */
export async function scrapeAgenda(opts?: {
  daysAhead?: number;
  dryRun?: boolean;
}): Promise<AgendaScrapeResult> {
  const dryRun = opts?.dryRun ?? false;
  const daysAhead = opts?.daysAhead ?? 14;
  const startMs = Date.now();

  logger.info('agenda_scrape_start', { dryRun, daysAhead });

  const result: AgendaScrapeResult = {
    scraped_count: 0,
    agenda_inserted: 0,
    alerts_inserted: 0,
    errors: [],
    duration_ms: 0,
  };

  // ── Step 1: Fetch HTML ──────────────────────────────────────────────────────
  const html = await fetchAgendaHtml();

  if (!html) {
    result.errors.push('agenda_unreachable');
    result.duration_ms = Date.now() - startMs;
    logger.warn('agenda_scrape_unreachable', { url: AGENDA_URL });
    return result;
  }

  // ── Step 2: Parse rows ──────────────────────────────────────────────────────
  let parsedRows: AgendaRow[] = [];
  try {
    parsedRows = parseAgendaHtml(html, daysAhead);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`parse_failed: ${message}`);
    logger.error('agenda_scrape_parse_failed', { error: message });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  result.scraped_count = parsedRows.length;

  logger.info('agenda_scrape_parsed', { count: parsedRows.length, dryRun });

  if (parsedRows.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.warn('agenda_scrape_empty_parse', {
      html_length: html.length,
      note: 'No rows parsed — selectors may need updating for live HTML',
    });
    return result;
  }

  // ── Step 3: Load watchlist ──────────────────────────────────────────────────
  let watchlistMap = new Map<string, string[]>();
  try {
    watchlistMap = await loadExpedienteWatchlist();
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`watchlist_load_failed: ${message}`);
    logger.error('agenda_scrape_watchlist_load_failed', { error: message });
    // Continue: we can still insert agenda rows without alerts
  }

  // ── Step 4: UPSERT agenda rows + generate alerts ────────────────────────────
  for (const row of parsedRows) {
    // 4a. UPSERT agenda row
    try {
      await upsertAgendaRow(row, dryRun);
      result.agenda_inserted++;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      result.errors.push(`agenda_upsert_failed: ${message}`);
      logger.error('agenda_scrape_upsert_error', { error: message, row });
      continue; // skip alert generation for this row
    }

    // 4b. Check watchlist match
    if (!row.expediente_numero) continue;

    const watchers = watchlistMap.get(row.expediente_numero) ?? [];
    if (watchers.length === 0) continue;

    // 4c. Insert alerts for each watcher
    for (const userId of watchers) {
      try {
        const inserted = await insertAgendaAlert(userId, row, dryRun);
        if (inserted) result.alerts_inserted++;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result.errors.push(`alert_insert_failed(${userId}): ${message}`);
        logger.error('agenda_scrape_alert_error', { userId, error: message });
      }
    }
  }

  result.duration_ms = Date.now() - startMs;

  logger.info('agenda_scrape_complete', {
    scraped_count: result.scraped_count,
    agenda_inserted: result.agenda_inserted,
    alerts_inserted: result.alerts_inserted,
    errors: result.errors.length,
    duration_ms: result.duration_ms,
    dryRun,
  });

  return result;
}

// ── Export for testing ────────────────────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}

// Export internals for unit testing
export { parseAgendaHtml, normalizeDate, extractExpedienteNumero };
