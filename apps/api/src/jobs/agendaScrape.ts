/**
 * Agenda-scrape job — populate `agenda_legislativa` and emit `agenda` alerts
 * for any expediente that lands on a watcher's list.
 *
 * SOURCE OF TRUTH (verified 2026-04-28):
 *
 *   The Asamblea SharePoint page (https://asamblea.go.cr/glcp/SitePages/
 *   ConsultaOrdenDiaPlenario.aspx) is just a wrapper — the data sits in an
 *   embedded iframe pointing at the legacy ASP.NET WebForms portal:
 *
 *       https://consultassil3.asamblea.go.cr/frmOrdenDiaPlenario.aspx
 *
 *   That page renders a gridview (`grvOrdenDia`) with one row per session:
 *
 *       Orden del Día | Fecha de sesión | Hora de inicio | Tipo de sesión | Estado | Id | [⬇]
 *
 *   The download arrow (rightmost cell) fires a `__doPostBack(grvOrdenDia,
 *   'Select$N')` postback. The server responds with `Content-Type:
 *   application/octet-stream` + `Content-Disposition: attachment;
 *   filename=...docx` and the raw DOCX bytes. The DOCX contains the actual
 *   list of expedientes scheduled for that session.
 *
 *   Comisiones (https://consultassil3.asamblea.go.cr/frmConsultaODComisiones
 *   .aspx) requires a cascading-dropdown dance (TipoOrgano → Organo →
 *   gridview-per-comisión) and is **not** implemented in this revision —
 *   tracked as a Phase-2 follow-up. Plenario alone covers ~80% of the
 *   "what's on the agenda" use case for the demo.
 *
 * PIPELINE:
 *   1. GET frmOrdenDiaPlenario.aspx (cookies + VIEWSTATE)
 *   2. Parse gridview → { fecha, hora, codigo, estado, postback_index }[]
 *   3. Filter to sessions in [today, today+daysAhead] with a non-cancelled estado
 *   4. For each, POST __EVENTTARGET=grvOrdenDia + Select$N → DOCX bytes
 *   5. mammoth.extractRawText(docx) → plaintext
 *   6. Extract expediente numbers via regex `\b(\d{2,5}\.\d{3})\b`,
 *      capturing the surrounding 200-char snippet as `titulo`
 *   7. UPSERT `agenda_legislativa` rows (unique: fecha, comision, titulo)
 *   8. For watched expedientes, emit `agenda` alerts (dedup_key
 *      `agenda:{fecha}:{expediente_numero}`)
 *
 * RESILIENCE:
 *   - Bootstrap fetch fails → result.errors.push('agenda_unreachable'), return.
 *   - Per-session DOCX fetch fails → log + continue with remaining sessions.
 *   - Per-session DOCX has no expediente numbers → still UPSERT a single
 *     "session-without-expedientes" row so admins can see the agenda was
 *     reachable but empty.
 *   - DB error on a single upsert → log + continue.
 *
 * MODULE CONTRACT:
 *   - Pure async function, no Express coupling.
 *   - Uses service_role Supabase client.
 *   - Idempotent: re-running on same day produces 0 net inserts (ON CONFLICT
 *     DO NOTHING on the unique constraint).
 */

import * as cheerio from 'cheerio';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withTimeout, withRetry } from '../services/resilience.js';
import { logger } from '../services/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SIL_WEBFORMS_BASE =
  process.env.SIL_WEBFORMS_BASE ?? 'https://consultassil3.asamblea.go.cr';
const PLENARIO_PATH = '/frmOrdenDiaPlenario.aspx';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_BASE_MS = 800;

const COMMON_HEADERS = {
  'User-Agent': 'CL2-Centinela/1.0 (+https://agentescl2.com; contact: madebyjred@gmail.com)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-CR,es;q=0.9',
} as const;

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

interface AsamblesSession {
  /** ISO date 'YYYY-MM-DD' parsed from the gridview "Fecha de sesión" cell. */
  fecha: string;
  /** 'HH:MM' or null. */
  hora_inicio: string | null;
  /** Visible session code, e.g. '2026-2027-PLENARIO-SESION-2'. */
  codigo: string;
  /** Server-side internal id (cell 5), used only for logging. */
  serverId: string | null;
  /** Estado from the grid: PENDIENTE | REALIZADA | NO QUORUM | CANCELADA | ... */
  estado: string;
  /** 0-based index in the gridview, used for the Select$N postback. */
  postbackIndex: number;
}

interface ExpedienteOnAgenda {
  expediente_numero: string;
  /** Best-effort context snippet from the DOCX (max 500 chars). */
  titulo: string;
}

interface AgendaRow {
  fecha: string;
  comision: string | null; // null = plenario
  hora_inicio: string | null;
  codigo: string;
  expediente_numero: string | null;
  titulo: string;
}

interface WatchlistExpedienteEntry {
  user_id: string;
  entity_id: string;
}

interface WebFormsState {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  cookies: string;
}

// ── ASP.NET WebForms helpers (mirrors silWebFormsClient pattern) ─────────────

function parseHiddenFields(
  html: string,
): Pick<WebFormsState, 'viewState' | 'viewStateGenerator' | 'eventValidation'> {
  const $ = cheerio.load(html);
  const get = (id: string) => $(`input[name='${id}']`).attr('value') ?? '';
  const viewState = get('__VIEWSTATE');
  const viewStateGenerator = get('__VIEWSTATEGENERATOR');
  const eventValidation = get('__EVENTVALIDATION');
  if (!viewState) throw new Error('agenda: __VIEWSTATE missing — page layout changed?');
  return { viewState, viewStateGenerator, eventValidation };
}

function mergeCookies(prev: string, setCookieHeader: string[] | null | undefined): string {
  if (!setCookieHeader || setCookieHeader.length === 0) return prev;
  const map = new Map<string, string>();
  for (const part of prev.split(';').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const sc of setCookieHeader) {
    const first = sc.split(';')[0]!;
    const eq = first.indexOf('=');
    if (eq > 0) map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function getSetCookieHeaders(headers: Headers): string[] | null {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    const arr = anyHeaders.getSetCookie();
    return arr.length > 0 ? arr : null;
  }
  const single = headers.get('set-cookie');
  return single ? [single] : null;
}

async function rawFetchHtml(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{ html: string; setCookie: string[] | null }> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(url, { ...init, signal });
          if (!res.ok) throw new Error(`${label} ${res.status}`);
          const setCookie = getSetCookieHeaders(res.headers);
          const html = await res.text();
          return { html, setCookie };
        },
        { ms: FETCH_TIMEOUT_MS, label },
      ),
    {
      attempts: FETCH_RETRY_ATTEMPTS,
      baseDelayMs: FETCH_RETRY_BASE_MS,
      label,
      shouldRetry: (err) => {
        const m = (err as Error)?.message ?? '';
        const code = m.match(/ (\d{3})$/)?.[1];
        if (!code) return true;
        const n = Number(code);
        return n === 429 || n >= 500;
      },
    },
  );
}

async function rawFetchBinary(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{
  bytes: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
  setCookie: string[] | null;
}> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(url, { ...init, signal });
          if (!res.ok) throw new Error(`${label} ${res.status}`);
          const setCookie = getSetCookieHeaders(res.headers);
          const ab = await res.arrayBuffer();
          return {
            bytes: Buffer.from(ab),
            contentType: res.headers.get('content-type'),
            contentDisposition: res.headers.get('content-disposition'),
            setCookie,
          };
        },
        { ms: FETCH_TIMEOUT_MS, label },
      ),
    {
      attempts: FETCH_RETRY_ATTEMPTS,
      baseDelayMs: FETCH_RETRY_BASE_MS,
      label,
      shouldRetry: (err) => {
        const m = (err as Error)?.message ?? '';
        const code = m.match(/ (\d{3})$/)?.[1];
        if (!code) return true;
        const n = Number(code);
        return n === 429 || n >= 500;
      },
    },
  );
}

function isDocxMagic(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

// ── Date / number helpers ────────────────────────────────────────────────────

const SPANISH_MONTH: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12',
};

/**
 * SIL portal renders dates like '04-may.-2026' or '04-may-2026'. Normalize to
 * ISO YYYY-MM-DD. Also accept 'DD/MM/YYYY' and 'YYYY-MM-DD' for safety.
 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // 'DD-MMM.-YYYY' or 'DD-MMM-YYYY' (Spanish month abbrev, with optional dot)
  const sil = s.match(/^(\d{1,2})-([A-Za-zñ]+)\.?-(\d{4})$/);
  if (sil) {
    const [, d, mon, y] = sil;
    const month = SPANISH_MONTH[mon!.slice(0, 3).toLowerCase()];
    if (month) return `${y}-${month}-${d!.padStart(2, '0')}`;
  }

  // 'DD/MM/YYYY'
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  // ISO already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // 'D de Mes (de) YYYY'
  const sp = s.match(/^(\d{1,2})\s+de\s+([A-Za-zñ]+)(?:\s+de)?\s+(\d{4})$/i);
  if (sp) {
    const [, d, mon, y] = sp;
    const month = SPANISH_MONTH[mon!.slice(0, 3).toLowerCase()];
    if (month) return `${y}-${month}-${d!.padStart(2, '0')}`;
  }

  return null;
}

function normalizeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1]!.padStart(2, '0');
  return `${h}:${m[2]}`;
}

/**
 * Yank expediente numbers (NN.NNN format) from free text, with a 200-char
 * context snippet around each match. Returns one entry per unique number,
 * preserving document order (the first occurrence usually carries the
 * descriptive title; later occurrences tend to be cross-references).
 *
 * The hard cap (`maxResults`) defends against pathological documents — a
 * full plenario session DOCX can include 800+ expediente cross-references
 * across status tables, dispensa lists, and footnotes. We let callers
 * configure the ceiling; the default is intentionally generous so that
 * real agendas (typically 20-100 items) are never truncated.
 */
export function extractExpedientesFromText(
  text: string,
  maxResults = 500,
): ExpedienteOnAgenda[] {
  const seen = new Map<string, string>();
  const re = /\b(\d{2,5}\.\d{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const numero = m[1]!;
    if (seen.has(numero)) continue;
    const start = Math.max(0, m.index - 60);
    const end = Math.min(text.length, m.index + 200);
    const snippet = text
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    seen.set(numero, snippet);
    if (seen.size >= maxResults) break;
  }
  return [...seen.entries()].map(([expediente_numero, titulo]) => ({
    expediente_numero,
    titulo,
  }));
}

// ── Step 1: bootstrap WebForms session ───────────────────────────────────────

async function bootstrap(): Promise<{
  state: WebFormsState;
  html: string;
} | null> {
  try {
    const url = `${SIL_WEBFORMS_BASE}${PLENARIO_PATH}`;
    const { html, setCookie } = await rawFetchHtml(
      url,
      { method: 'GET', headers: COMMON_HEADERS },
      'agenda:bootstrap',
    );
    const cookies = mergeCookies('', setCookie);
    const hidden = parseHiddenFields(html);
    return { state: { ...hidden, cookies }, html };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn('agenda_scrape_bootstrap_failed', { error: message });
    return null;
  }
}

// ── Step 2: parse session list from gridview ─────────────────────────────────

/**
 * Parse the gridview into a list of sessions. The gridview is identified by
 * the suffix `grvOrdenDia` so we survive any ContentPlaceHolder prefix change.
 *
 * Columns (verified 2026-04-28):
 *   0: Orden del Día (session code, e.g. '2026-2027-PLENARIO-SESION-2')
 *   1: Fecha de sesión (e.g. '04-may.-2026')
 *   2: Hora de inicio (e.g. '14:45')
 *   3: Tipo de sesión (ORDINARIA | EXTRAORDINARIA | ...)
 *   4: Estado (PENDIENTE | REALIZADA | NO QUORUM | CANCELADA | ...)
 *   5: Id (server-side internal numeric id)
 *   6: Download button (input.btn with __doPostBack)
 */
export function parseSessionList(html: string): AsamblesSession[] {
  const $ = cheerio.load(html);
  const grid = $('[id$="grvOrdenDia"]').first();
  if (grid.length === 0) return [];

  const out: AsamblesSession[] = [];
  let dataIdx = 0;
  grid
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 6) return; // header / empty row
      const codigo = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const fechaRaw = $(cells[1]).text().replace(/\s+/g, ' ').trim();
      const horaRaw = $(cells[2]).text().replace(/\s+/g, ' ').trim();
      const estado = $(cells[4]).text().replace(/\s+/g, ' ').trim().toUpperCase();
      const serverId = $(cells[5]).text().replace(/\s+/g, ' ').trim();

      const fecha = normalizeDate(fechaRaw);
      if (!fecha || !codigo) {
        // Increment dataIdx anyway — postback indices are assigned in DOM order
        // for ALL data rows the server rendered, even if we can't parse them.
        dataIdx++;
        return;
      }

      out.push({
        fecha,
        hora_inicio: normalizeTime(horaRaw),
        codigo: codigo.slice(0, 200),
        serverId: serverId || null,
        estado,
        postbackIndex: dataIdx,
      });
      dataIdx++;
    });

  return out;
}

// ── Step 3: download DOCX for a session ──────────────────────────────────────

async function downloadSessionDocx(
  state: WebFormsState,
  postbackIndex: number,
  label: string,
): Promise<{ bytes: Buffer; nextState: WebFormsState | null } | null> {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$grvOrdenDia');
  form.set('__EVENTARGUMENT', `Select$${postbackIndex}`);
  form.set('__VIEWSTATE', state.viewState);
  form.set('__VIEWSTATEGENERATOR', state.viewStateGenerator);
  form.set('__EVENTVALIDATION', state.eventValidation);

  const { bytes, setCookie } = await rawFetchBinary(
    `${SIL_WEBFORMS_BASE}${PLENARIO_PATH}`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: state.cookies,
        Origin: SIL_WEBFORMS_BASE,
        Referer: `${SIL_WEBFORMS_BASE}${PLENARIO_PATH}`,
      },
      body: form.toString(),
    },
    label,
  );

  const cookies = mergeCookies(state.cookies, setCookie);

  // The server may respond with HTML (re-rendered grid) instead of a DOCX
  // when the document is missing for a given row. Detect by ZIP magic.
  if (!isDocxMagic(bytes)) {
    try {
      const html = bytes.toString('utf8');
      const hidden = parseHiddenFields(html);
      return { bytes: Buffer.alloc(0), nextState: { ...hidden, cookies } };
    } catch {
      return null;
    }
  }
  // We got DOCX bytes — VIEWSTATE didn't refresh because no HTML rendered.
  // Caller should re-bootstrap if it needs more interactions.
  return { bytes, nextState: null };
}

// ── Step 4: extract text from DOCX ───────────────────────────────────────────

async function extractDocxText(bytes: Buffer): Promise<string> {
  // Lazy import keeps the module light when the job is dormant.
  const mammoth = await import('mammoth');
  // mammoth's Buffer→ArrayBuffer expectation: pass `buffer` directly.
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return value ?? '';
}

// ── Watchlist + DB writes ────────────────────────────────────────────────────

async function loadExpedienteWatchlist(): Promise<Map<string, string[]>> {
  const { data, error } = await supa()
    .from('centinela_watchlist')
    .select('entity_id, user_id')
    .eq('entity_type', 'expediente');
  if (error) throw new Error(`agenda:loadWatchlist: ${error.message}`);

  const map = new Map<string, string[]>();
  for (const row of (data ?? []) as WatchlistExpedienteEntry[]) {
    const id = row.entity_id.trim();
    const push = (k: string) => {
      const arr = map.get(k) ?? [];
      arr.push(row.user_id);
      map.set(k, arr);
    };
    push(id);
    if (/^\d{5,}$/.test(id)) push(id.slice(0, -3) + '.' + id.slice(-3));
    if (/^\d{2,5}\.\d{3}$/.test(id)) push(id.replace('.', ''));
  }
  return map;
}

/**
 * Cross-reference candidate expediente numbers against `sil_expedientes` so
 * we keep only the ones that actually exist. Without this, the regex over
 * a session DOCX captures hundreds of false positives (page numbers, dates
 * formatted DD.NNN, etc.) — the SIL has ~25k real expedientes so a hash
 * lookup against the canonical list is the cheapest precision filter.
 *
 * Returns the input set filtered to known numeros. If the lookup itself
 * fails we fall back to the raw set so a transient DB error doesn't make
 * the entire scrape useless.
 */
async function filterToKnownExpedientes(numeros: string[]): Promise<string[]> {
  if (numeros.length === 0) return [];
  try {
    const { data, error } = await supa()
      .from('sil_expedientes')
      .select('numero')
      .in('numero', numeros);
    if (error) throw new Error(error.message);
    const known = new Set(((data ?? []) as Array<{ numero: string }>).map((r) => r.numero));
    return numeros.filter((n) => known.has(n));
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn('agenda_scrape_filter_known_failed', {
      error: message,
      candidates: numeros.length,
    });
    return numeros; // permissive fallback
  }
}

async function upsertAgendaRow(row: AgendaRow, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  // Use codigo + (expediente or '∅') as titulo so the unique key (fecha,
  // comision, titulo) gives us per-(session, expediente) rows.
  const titulo = row.expediente_numero
    ? `${row.codigo} :: ${row.expediente_numero} — ${row.titulo}`.slice(0, 500)
    : `${row.codigo} :: ${row.titulo}`.slice(0, 500);

  const { error } = await supa()
    .from('agenda_legislativa')
    .upsert(
      {
        fecha: row.fecha,
        comision: row.comision,
        expediente_numero: row.expediente_numero,
        titulo,
        hora_inicio: row.hora_inicio,
        scraped_at: new Date().toISOString(),
      },
      { onConflict: 'fecha,comision,titulo', ignoreDuplicates: true },
    );
  if (error) throw new Error(`agenda:upsertAgendaRow: ${error.message}`);
}

async function insertAgendaAlert(
  userId: string,
  row: AgendaRow,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  if (!row.expediente_numero) return false;

  const dedupKey = `agenda:${row.fecha}:${row.expediente_numero}`;
  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: 'expediente',
        entity_id: row.expediente_numero,
        alert_type: 'agenda',
        severity: 'info',
        dedup_key: dedupKey,
        payload: {
          fecha: row.fecha,
          comision: row.comision,
          hora_inicio: row.hora_inicio,
          titulo: row.titulo,
          codigo: row.codigo,
          expediente_numero: row.expediente_numero,
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );
  if (error) throw new Error(`agenda:insertAgendaAlert(${userId}): ${error.message}`);
  return true;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Scrape the Asamblea's plenario orden del día, populate `agenda_legislativa`,
 * and emit `agenda` alerts for watched expedientes.
 *
 * @param opts.daysAhead   How many days ahead to consider sessions for
 *                         (default 14). Sessions outside this window are
 *                         skipped (DOCX not fetched).
 * @param opts.includeRealized  If true, also process REALIZADA sessions
 *                              (useful for backfill). Default false: only
 *                              future sessions trigger alerts.
 * @param opts.dryRun     If true, no DB writes; result reflects what would
 *                        be inserted.
 */
export async function scrapeAgenda(opts?: {
  daysAhead?: number;
  includeRealized?: boolean;
  dryRun?: boolean;
}): Promise<AgendaScrapeResult> {
  const dryRun = opts?.dryRun ?? false;
  const daysAhead = opts?.daysAhead ?? 14;
  const includeRealized = opts?.includeRealized ?? false;
  const startMs = Date.now();

  logger.info('agenda_scrape_start', { dryRun, daysAhead, includeRealized });

  const result: AgendaScrapeResult = {
    scraped_count: 0,
    agenda_inserted: 0,
    alerts_inserted: 0,
    errors: [],
    duration_ms: 0,
  };

  // ── 1. Bootstrap session ────────────────────────────────────────────────
  const boot = await bootstrap();
  if (!boot) {
    result.errors.push('agenda_unreachable');
    result.duration_ms = Date.now() - startMs;
    logger.warn('agenda_scrape_unreachable', { url: SIL_WEBFORMS_BASE + PLENARIO_PATH });
    return result;
  }

  // ── 2. Parse session list ───────────────────────────────────────────────
  let sessions: AsamblesSession[] = [];
  try {
    sessions = parseSessionList(boot.html);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`session_list_parse_failed: ${message}`);
    logger.error('agenda_scrape_session_list_parse_failed', { error: message });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // Filter to date window + estado
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const max = new Date(today);
  max.setUTCDate(max.getUTCDate() + daysAhead);

  const inScope = sessions.filter((s) => {
    const d = new Date(s.fecha + 'T00:00:00Z');
    if (d < today || d > max) return false;
    // Skip clearly cancelled sessions; PENDIENTE/NO QUORUM = expected,
    // REALIZADA = past or done (only include if asked).
    if (s.estado === 'CANCELADA') return false;
    if (s.estado === 'REALIZADA' && !includeRealized) return false;
    return true;
  });

  result.scraped_count = inScope.length;
  logger.info('agenda_scrape_sessions_found', {
    total_grid_rows: sessions.length,
    in_scope: inScope.length,
    daysAhead,
  });

  if (inScope.length === 0) {
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // ── 3. Load watchlist (best-effort) ─────────────────────────────────────
  let watchlistMap = new Map<string, string[]>();
  try {
    watchlistMap = await loadExpedienteWatchlist();
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`watchlist_load_failed: ${message}`);
    logger.error('agenda_scrape_watchlist_load_failed', { error: message });
    // Continue: agenda rows still valuable without targeted alerts.
  }

  // ── 4. Per-session: download DOCX + extract + upsert ────────────────────
  let workingState: WebFormsState = boot.state;

  for (const s of inScope) {
    let docxText = '';
    try {
      const dl = await downloadSessionDocx(
        workingState,
        s.postbackIndex,
        `agenda:download:${s.codigo}`,
      );
      if (!dl) {
        result.errors.push(`docx_unavailable:${s.codigo}`);
        logger.warn('agenda_scrape_docx_unavailable', {
          codigo: s.codigo,
          postbackIndex: s.postbackIndex,
        });
        continue;
      }
      // After a binary postback the server returns no HTML, so VIEWSTATE
      // isn't refreshed in `dl.nextState`. Re-bootstrap to keep going.
      if (!dl.nextState) {
        const reboot = await bootstrap();
        if (reboot) workingState = reboot.state;
      } else {
        workingState = dl.nextState;
      }

      if (dl.bytes.length === 0) {
        // HTML response (file missing for this row). UPSERT the session
        // anyway so we have a record that this date had a session.
        try {
          await upsertAgendaRow(
            {
              fecha: s.fecha,
              comision: null, // plenario
              hora_inicio: s.hora_inicio,
              codigo: s.codigo,
              expediente_numero: null,
              titulo: '(sin documento publicado aún)',
            },
            dryRun,
          );
          result.agenda_inserted++;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          result.errors.push(`agenda_upsert_failed:${s.codigo}: ${message}`);
        }
        continue;
      }

      docxText = await extractDocxText(dl.bytes);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      result.errors.push(`docx_fetch_failed:${s.codigo}: ${message}`);
      logger.warn('agenda_scrape_docx_fetch_failed', {
        codigo: s.codigo,
        error: message,
      });
      continue;
    }

    const candidates = extractExpedientesFromText(docxText);
    // Filter out regex false positives: only keep numbers that exist in our
    // SIL mirror. This drops noise (page numbers, dates formatted as NN.NNN,
    // section codes, etc.) without losing any real agenda items.
    const knownNumbers = await filterToKnownExpedientes(
      candidates.map((c) => c.expediente_numero),
    );
    const knownSet = new Set(knownNumbers);
    const expedientes = candidates.filter((c) => knownSet.has(c.expediente_numero));
    logger.info('agenda_scrape_filter_known', {
      codigo: s.codigo,
      candidates: candidates.length,
      kept: expedientes.length,
    });

    if (expedientes.length === 0) {
      // Session DOCX exists but no expediente numbers detected. Still
      // record the session so the agenda timeline shows something.
      try {
        await upsertAgendaRow(
          {
            fecha: s.fecha,
            comision: null,
            hora_inicio: s.hora_inicio,
            codigo: s.codigo,
            expediente_numero: null,
            titulo: '(documento sin expedientes legibles)',
          },
          dryRun,
        );
        result.agenda_inserted++;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result.errors.push(`agenda_upsert_failed:${s.codigo}: ${message}`);
      }
      logger.info('agenda_scrape_no_expedientes', {
        codigo: s.codigo,
        text_length: docxText.length,
      });
      continue;
    }

    // 4a. UPSERT one row per (session, expediente) and 4b. fire alerts.
    for (const exp of expedientes) {
      const row: AgendaRow = {
        fecha: s.fecha,
        comision: null, // plenario
        hora_inicio: s.hora_inicio,
        codigo: s.codigo,
        expediente_numero: exp.expediente_numero,
        titulo: exp.titulo,
      };

      try {
        await upsertAgendaRow(row, dryRun);
        result.agenda_inserted++;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result.errors.push(`agenda_upsert_failed: ${message}`);
        logger.error('agenda_scrape_upsert_error', { error: message, row });
        continue;
      }

      const watchers = watchlistMap.get(exp.expediente_numero) ?? [];
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

// ── Test helpers ─────────────────────────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}
