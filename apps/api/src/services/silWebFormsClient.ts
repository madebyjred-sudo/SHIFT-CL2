/**
 * SIL WebForms client — speaks ASP.NET WebForms to consultassil3.asamblea.go.cr.
 *
 * Why this file exists: SharePoint OData (silSharePointClient.ts) covers the
 * structural lists (iniciativas/mociones/dictámenes/votaciones), but the
 * canonical "expediente by number" detail page lives on the legacy ASP.NET
 * site, which is 100% form-driven (VIEWSTATE postbacks, no JSON). We need it
 * to fetch the full ~25500 historical expedientes and follow PDF links.
 *
 * State machine each WebForms session goes through:
 *   1. createSession()  → GET initial page, parse hidden fields → Session
 *   2. searchByNumber() → POST with txtNumExp=N + button event → Session'
 *   3. parseDetail()    → cheerio over the response HTML → ExpedienteDetail
 *
 * No JS execution required: postbacks are pure form-encoded HTTP. We avoid
 * Playwright entirely (50x faster, 10x fewer moving parts).
 *
 * Politeness: 1 req/s default. The site is government-owned with no anti-bot
 * but also no CDN — hammering would be detected as anomaly.
 */
import * as cheerio from 'cheerio';
import { withRetry, withTimeout } from './resilience.js';

const SIL_WEBFORMS_BASE =
  process.env.SIL_WEBFORMS_BASE ?? 'https://consultassil3.asamblea.go.cr';
const PAGE_PATH = '/frmConsultaProyectos.aspx';
const WEBFORMS_TIMEOUT_MS = 20_000;

const COMMON_HEADERS = {
  'User-Agent': 'shift-cl2/1.0 (+https://cl2.shiftlab.io; contact: madebyjred@gmail.com)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-CR,es;q=0.9',
} as const;

export interface WebFormsSession {
  /** ASP.NET hidden fields harvested from the most recent response. */
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  /** Cookies returned by the server (sessionId etc). */
  cookies: string;
  /** Last-rendered HTML — handy for debug or for chained postbacks. */
  lastHtml: string;
}

/**
 * Snapshot of a single expediente as parsed from the SIL detail page.
 * Fields are best-effort: the SIL doesn't expose a stable schema, so missing
 * values land as null instead of throwing.
 */
export interface ExpedienteDetail {
  numero: string;                       // "22.293"
  numeroNum: number;                    // 22293
  titulo: string | null;
  proponente: string | null;
  comision: string | null;
  fechaPresentacion: string | null;     // ISO YYYY-MM-DD when parseable
  estado: string | null;
  tipo: string | null;
  legislatura: string | null;
  documentos: ExpedienteDoc[];
  rawTextSnippet: string | null;        // first 4KB of the detail body — debug
  detailUrl: string;
}

export interface ExpedienteDoc {
  tipo: string;                         // "texto_base", "dictamen", "mocion", etc.
  titulo: string | null;
  fecha: string | null;
  url: string;                          // absolute URL to PDF/HTML
}

// ─── Internal helpers ─────────────────────────────────────────────────

function parseHiddenFields(html: string): Pick<WebFormsSession, 'viewState' | 'viewStateGenerator' | 'eventValidation'> {
  const $ = cheerio.load(html);
  const get = (id: string) => $(`input[name='${id}']`).attr('value') ?? '';
  const viewState = get('__VIEWSTATE');
  const viewStateGenerator = get('__VIEWSTATEGENERATOR');
  const eventValidation = get('__EVENTVALIDATION');
  if (!viewState) throw new Error('webforms: __VIEWSTATE missing — page layout changed?');
  return { viewState, viewStateGenerator, eventValidation };
}

function mergeCookies(prev: string, setCookieHeader: string[] | null | undefined): string {
  if (!setCookieHeader || setCookieHeader.length === 0) return prev;
  // Each Set-Cookie value: "name=val; Path=/; HttpOnly". We only keep name=val.
  const map = new Map<string, string>();
  for (const part of prev.split(';').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const sc of setCookieHeader) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function rawFetch(
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
          // Express/Node: getSetCookie() returns string[]; older versions: get('set-cookie').
          const sc =
            typeof (res.headers as any).getSetCookie === 'function'
              ? (res.headers as any).getSetCookie()
              : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : null);
          const html = await res.text();
          return { html, setCookie: sc };
        },
        { ms: WEBFORMS_TIMEOUT_MS, label },
      ),
    {
      attempts: 3,
      baseDelayMs: 800,
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

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Bootstrap a session against the SIL search page. The result must be passed
 * to subsequent searchByNumber() calls; do NOT reuse a session across many
 * minutes — VIEWSTATE expires server-side after a while.
 */
export async function createSession(): Promise<WebFormsSession> {
  const url = `${SIL_WEBFORMS_BASE}${PAGE_PATH}`;
  const { html, setCookie } = await rawFetch(
    url,
    { method: 'GET', headers: COMMON_HEADERS },
    'webforms:bootstrap',
  );
  const cookies = mergeCookies('', setCookie);
  const hidden = parseHiddenFields(html);
  return { ...hidden, cookies, lastHtml: html };
}

/**
 * Push the search form WITHOUT the Select$N postback. Returns just the
 * grid row. Used by the bulk lightweight backfill.
 */
export async function searchByNumber(
  session: WebFormsSession,
  expedienteNum: number,
): Promise<{ session: WebFormsSession; detail: ExpedienteDetail | null }> {
  if (!Number.isInteger(expedienteNum) || expedienteNum <= 0) {
    throw new Error(`searchByNumber: invalid expediente number ${expedienteNum}`);
  }

  // ASP.NET MasterPage prefixes every server control with the placeholder
  // id, so on the wire the field names look like
  // `ctl00$ContentPlaceHolder1$<localId>`. The search form has:
  //   tbxBuscaLey         → number input (expediente number)
  //   tbxBuscaDescripcion → text input (kept empty — we filter by number)
  //   btnBuscar           → submit button (the `__EVENTTARGET`)
  // Verified by inspecting the live page on 2026-04-25.
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', session.viewState);
  form.set('__VIEWSTATEGENERATOR', session.viewStateGenerator);
  form.set('__EVENTVALIDATION', session.eventValidation);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(expedienteNum));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');
  form.set('ctl00$ContentPlaceHolder1$btnBuscar', 'Buscar');

  const { html, setCookie } = await rawFetch(
    `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookies,
        Origin: SIL_WEBFORMS_BASE,
        Referer: `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
      },
      body: form.toString(),
    },
    `webforms:search:${expedienteNum}`,
  );

  const cookies = mergeCookies(session.cookies, setCookie);
  const hidden = parseHiddenFields(html);
  const newSession: WebFormsSession = { ...hidden, cookies, lastHtml: html };

  const detail = parseExpedienteDetail(html, expedienteNum);
  return { session: newSession, detail };
}

/**
 * Cheerio walk over the SIL search result. The grid (`grvLey`) carries the
 * minimal expediente row: select-button + número + título. Full details
 * (proponente, comisión, fecha, dictámenes, PDFs) require a SECOND postback
 * (`Select$0`) which we don't perform during bulk backfill — that flow
 * lives in the on-demand `fetch_sil_live` tool. The number + title pair is
 * enough to make `search_sil_expedientes` work and to give the LLM a
 * citable URL to the SIL.
 *
 * The grid id renders as `ContentPlaceHolder1_grvLey` because of ASP.NET's
 * MasterPage prefix; we use a `[id$=grvLey]` selector so the parser
 * survives any prefix changes.
 */
export function parseExpedienteDetail(html: string, expedienteNum: number): ExpedienteDetail | null {
  const $ = cheerio.load(html);

  // Defensive selector: any element ending in "grvLey" → tr without forcing
  // tbody (ASP.NET sometimes omits it). First row is the header (uses
  // <th>); the filter `td > 1` keeps only data rows.
  const allRows = $('[id$="grvLey"] tr');
  const dataRows = allRows.filter((_, el) => $(el).find('td').length > 1);
  if (dataRows.length === 0) return null;

  const targetStr = String(expedienteNum);
  const numeroFormatted = formatExpedienteNumber(expedienteNum);

  // Find the row whose number cell matches the requested expediente.
  // The grid columns are: [select-button][número][título].
  let titulo: string | null = null;
  let matchedRow: cheerio.Cheerio<any> | null = null;
  dataRows.each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const numText = ($(tds[1]).text() ?? '').replace(/[^\d]/g, '');
    if (numText === targetStr) {
      titulo = ($(tds[2]).text() ?? '').replace(/\s+/g, ' ').trim() || null;
      matchedRow = $(tr);
      return false; // break .each
    }
  });
  if (!matchedRow) return null;

  // Detail URL: ASP.NET WebForms is stateful, there is no per-expediente
  // deep link. Best we can give the citation card is the search page —
  // the user lands there and the result row is one click away. Encoding
  // the number in a query param is harmless even though the server
  // ignores it (helps debugging).
  const detailUrl = `${SIL_WEBFORMS_BASE}${PAGE_PATH}?expediente=${expedienteNum}`;

  // Snippet of the visible body for debugging — kept small.
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const rawTextSnippet = bodyText.length > 1000 ? bodyText.slice(0, 1000) : bodyText;

  return {
    numero: numeroFormatted,
    numeroNum: expedienteNum,
    titulo,
    // Detail-only fields stay null in the bulk backfill path. Filled later
    // by the on-demand selectExpediente() flow (see fetchExpedienteFull).
    proponente: null,
    comision: null,
    fechaPresentacion: null,
    estado: null,
    tipo: null,
    legislatura: null,
    documentos: [],
    rawTextSnippet,
    detailUrl,
  };
}

function formatExpedienteNumber(n: number): string {
  // CR convention: 22293 → "22.293"
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, s.length - 3)}.${s.slice(-3)}`;
}

function parseDate(input: string | null): string | null {
  if (!input) return null;
  // CR locale: "31/03/2024" → "2024-03-31".
  const m = input.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // ISO already?
  const iso = input.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

// ─── Enriched detail (Select$0 postback) ─────────────────────────────

export interface ExpedienteEnriched {
  numero: string;
  numeroNum: number;
  titulo: string | null;
  proponente: string | null;
  tipo: string | null;
  fechaPresentacion: string | null;     // ISO date when parseable
  fechaPublicacion: string | null;
  numeroGaceta: string | null;
  numeroAlcance: string | null;
  numeroArchivado: string | null;
  vencimientoCuatrienal: string | null;
  vencimientoOrdinario: string | null;
  fechaDispensa: string | null;
  numeroLey: string | null;
  numeroAcuerdo: string | null;
  proponentes: string[];                // multiple firmantes if any
  comisiones: Array<{ organo: string; fecha: string | null }>;
}

/**
 * After searchByNumber lands a row in the grid, fire the inline Select$0
 * postback to expand the detail panel. Returns the parsed enriched fields
 * (proponente, fechas, comisión, gaceta, ley number, etc.) — NOT the PDFs
 * because those live in further nested grids that require additional
 * postbacks (out of scope for bulk).
 *
 * Idempotent in spirit: running twice produces the same result for the
 * same expediente, but the SIL VIEWSTATE rotates so callers should pass
 * a freshly-searched session each time (don't reuse across expedientes).
 */
export async function selectExpedienteDetail(
  session: WebFormsSession,
  expedienteNum: number,
): Promise<{ session: WebFormsSession; enriched: ExpedienteEnriched | null }> {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$grvLey');
  form.set('__EVENTARGUMENT', 'Select$0');
  form.set('__VIEWSTATE', session.viewState);
  form.set('__VIEWSTATEGENERATOR', session.viewStateGenerator);
  form.set('__EVENTVALIDATION', session.eventValidation);
  // Echo the search inputs back so the server keeps the same row context.
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(expedienteNum));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');

  const { html, setCookie } = await rawFetch(
    `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookies,
        Origin: SIL_WEBFORMS_BASE,
        Referer: `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
      },
      body: form.toString(),
    },
    `webforms:select:${expedienteNum}`,
  );

  const cookies = mergeCookies(session.cookies, setCookie);
  const hidden = parseHiddenFields(html);
  const newSession: WebFormsSession = { ...hidden, cookies, lastHtml: html };

  const enriched = parseEnrichedDetail(html, expedienteNum);
  return { session: newSession, enriched };
}

/** Flatten the detail panel into a flat label→value map for downstream parse. */
function buildFieldMap(html: string): Map<string, string> {
  const $ = cheerio.load(html);
  const map = new Map<string, string>();
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const label = ($(cells[0]).text() ?? '').trim();
    const value = ($(cells[1]).text() ?? '').trim();
    if (!label || label.length > 80) return;
    if (!map.has(label)) map.set(label, value);
  });
  return map;
}

const SPANISH_MONTH: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12',
};

function parseSilDate(input: string | null | undefined): string | null {
  if (!input) return null;
  // SIL formats: "09-nov.-2020" / "09-nov-2020" / "9 de noviembre de 2020"
  const m1 = input.match(/(\d{1,2})[-\s\/]+([A-Za-zñ]+)\.?[-\s\/]+(\d{4})/);
  if (m1) {
    const [, d, m, y] = m1;
    const monthKey = m.slice(0, 3).toLowerCase();
    const month = SPANISH_MONTH[monthKey];
    if (month) return `${y}-${month}-${d.padStart(2, '0')}`;
  }
  const m2 = input.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return m2[0];
  // dd/mm/yyyy
  const m3 = input.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m3) return `${m3[3]}-${m3[2].padStart(2, '0')}-${m3[1].padStart(2, '0')}`;
  return null;
}

/**
 * Pull what we can out of the rendered detail panel. The SIL doesn't expose
 * stable element ids on these labels, so we rely on visible label strings.
 * Anything not found stays null — callers shouldn't trust nullable fields.
 */
export function parseEnrichedDetail(html: string, expedienteNum: number): ExpedienteEnriched | null {
  const $ = cheerio.load(html);
  // The Select$0 response should still carry the grid row; if it doesn't,
  // the postback failed.
  const allRows = $('[id$="grvLey"] tr');
  const dataRows = allRows.filter((_, el) => $(el).find('td').length > 1);
  if (dataRows.length === 0) return null;

  const targetStr = String(expedienteNum);
  let titulo: string | null = null;
  dataRows.each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const numText = ($(tds[1]).text() ?? '').replace(/[^\d]/g, '');
    if (numText === targetStr) {
      titulo = ($(tds[2]).text() ?? '').replace(/\s+/g, ' ').trim() || null;
      return false;
    }
  });

  const fields = buildFieldMap(html);
  const get = (...labels: string[]): string | null => {
    for (const l of labels) {
      // case-insensitive label scan
      for (const [k, v] of fields) {
        if (k.toLowerCase().includes(l.toLowerCase())) return v || null;
      }
    }
    return null;
  };

  // Proponentes: the "Secuencia de Firma → Apellidos" row is followed by
  // ordered numbered rows like "1 → RODRIGUEZ STELLER". Capture them.
  const proponentes: string[] = [];
  let inFirmantes = false;
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const a = ($(cells[0]).text() ?? '').trim();
    const b = ($(cells[1]).text() ?? '').trim();
    if (/^Secuencia de Firma$/i.test(a) && /Apellidos/i.test(b)) {
      inFirmantes = true;
      return;
    }
    if (inFirmantes) {
      if (/^\d+$/.test(a) && b && b.length > 1 && b.length < 80) {
        proponentes.push(b);
      } else if (a !== '' && !/^\d+$/.test(a)) {
        // we left the firmantes block
        inFirmantes = false;
      }
    }
  });

  // Comisiones: rows under "Órgano → Fecha de Inicio" header.
  const comisiones: Array<{ organo: string; fecha: string | null }> = [];
  let inOrganos = false;
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const a = ($(cells[0]).text() ?? '').trim();
    const b = ($(cells[1]).text() ?? '').trim();
    if (/^Órgano$/i.test(a) && /Fecha/i.test(b)) {
      inOrganos = true;
      return;
    }
    if (inOrganos) {
      if (a && a.length > 0 && a.length < 80 && b && /\d{4}/.test(b)) {
        // a tends to be ALL CAPS like "PLENARIO", "ARCHIVO", "JURIDICOS (ÁREA VII)"
        if (a === a.toUpperCase() || /^[A-ZÑÁÉÍÓÚ]/.test(a)) {
          comisiones.push({ organo: a, fecha: parseSilDate(b) });
        }
      } else if (!b || !/\d{4}/.test(b)) {
        inOrganos = false;
      }
    }
  });

  return {
    numero: formatExpedienteNumber(expedienteNum),
    numeroNum: expedienteNum,
    titulo,
    proponente: proponentes[0] ?? null,
    tipo: get('Tipo de Expediente', 'Tipo'),
    fechaPresentacion: parseSilDate(get('Fecha de Inicio', 'Fecha de Presentación', 'Fecha presentación')),
    fechaPublicacion: parseSilDate(get('Fecha de Publicación', 'Fecha publicación')),
    numeroGaceta: get('Número de Gaceta'),
    numeroAlcance: get('Número de Alcance'),
    numeroArchivado: get('Número de Archivado'),
    vencimientoCuatrienal: parseSilDate(get('Vencimiento Cuatrienal')),
    vencimientoOrdinario: parseSilDate(get('Vencimiento Ordinario')),
    fechaDispensa: parseSilDate(get('Fecha de Dispensa')),
    numeroLey: get('Número de Ley'),
    numeroAcuerdo: get('Número de Acuerdo'),
    proponentes,
    comisiones,
  };
}

// ─── Document downloads (DOCX, NOT PDF) ──────────────────────────────
// Findings of the 2026-04-25 reconnaissance (sub-agent abb106391e7faa862):
//   - SIL serves expediente documents as DOCX (Word 2007+, magic PK\x03\x04),
//     not PDF.
//   - There is no canonical URL per document. Downloads happen through the
//     same `frmConsultaProyectos.aspx` ASP.NET WebForms postback mechanism,
//     just with a different __EVENTTARGET / __EVENTARGUMENT.
//   - Three surfaces, all reachable from the detail panel after a
//     `searchByNumber` + `selectExpedienteDetail` pair:
//        a) Texto base       — POST `btnDescargaTexto=Descargar` (single doc).
//        b) Dictámenes       — POST __EVENTTARGET=grvDictamenes, EVENTARGUMENT=Select$N.
//        c) Informes técnicos — POST __EVENTTARGET=grvTecnicos,    EVENTARGUMENT=Select$N.
// The server responds with `Content-Disposition: attachment; filename=...`
// + `Content-Type: application/octet-stream` + the raw DOCX bytes.

export interface DocxDownload {
  /** raw bytes of the .docx file. */
  bytes: Buffer;
  /** filename surfaced by the server in Content-Disposition (best-effort). */
  filename: string | null;
  /** content type the server reported (octet-stream typically). */
  contentType: string | null;
}

async function rawFetchBinary(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{
  bytes: Buffer;
  filename: string | null;
  contentType: string | null;
  setCookie: string[] | null;
}> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(url, { ...init, signal });
          if (!res.ok) throw new Error(`${label} ${res.status}`);
          const sc =
            typeof (res.headers as any).getSetCookie === 'function'
              ? (res.headers as any).getSetCookie()
              : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : null);
          const cd = res.headers.get('content-disposition') ?? '';
          // filename can come quoted, unquoted, or RFC5987 (filename*=).
          let filename: string | null = null;
          const m1 = cd.match(/filename\*=UTF-8''([^;]+)/i);
          if (m1) filename = decodeURIComponent(m1[1]);
          if (!filename) {
            const m2 = cd.match(/filename="?([^";]+)"?/i);
            if (m2) filename = m2[1];
          }
          const contentType = res.headers.get('content-type');
          const ab = await res.arrayBuffer();
          const bytes = Buffer.from(ab);
          return { bytes, filename, contentType, setCookie: sc };
        },
        { ms: 30_000, label },
      ),
    {
      attempts: 3,
      baseDelayMs: 800,
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
  // ZIP signature (.docx is a zipped Office Open XML container).
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Download the texto base (the proyecto de ley as filed) for the currently-
 * loaded expediente. Caller must have just done a successful
 * searchByNumber + selectExpedienteDetail (the SIL session needs to be on
 * the detail panel of THIS expediente).
 *
 * Returns null when the expediente doesn't have a downloadable texto.
 */
export async function downloadTextoBase(
  session: WebFormsSession,
  expedienteNum: number,
): Promise<{ session: WebFormsSession; download: DocxDownload | null }> {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', session.viewState);
  form.set('__VIEWSTATEGENERATOR', session.viewStateGenerator);
  form.set('__EVENTVALIDATION', session.eventValidation);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(expedienteNum));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');
  form.set('ctl00$ContentPlaceHolder1$btnDescargaTexto', 'Descargar');

  const { bytes, filename, contentType, setCookie } = await rawFetchBinary(
    `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookies,
        Origin: SIL_WEBFORMS_BASE,
        Referer: `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
      },
      body: form.toString(),
    },
    `webforms:download_texto:${expedienteNum}`,
  );

  const cookies = mergeCookies(session.cookies, setCookie);
  // The server may respond with HTML (the detail panel re-rendered) instead
  // of a DOCX when the texto isn't available. Detect by magic bytes.
  if (!isDocxMagic(bytes)) {
    // Try to recover hidden state from the HTML response so the session is
    // still usable for subsequent calls.
    try {
      const html = bytes.toString('utf8');
      const hidden = parseHiddenFields(html);
      return {
        session: { ...hidden, cookies, lastHtml: html },
        download: null,
      };
    } catch {
      return { session, download: null };
    }
  }
  // We got a binary; the in-memory session VIEWSTATE didn't refresh because
  // the server didn't render HTML. Keep the current state — caller should
  // do another GET/search round-trip if it needs more interactions.
  return {
    session,
    download: {
      bytes,
      filename: filename ?? `expediente_${expedienteNum}_texto.docx`,
      contentType,
    },
  };
}

/**
 * Download the dictamen at index N (0-based) from the grvDictamenes grid.
 * The detail panel for the expediente must be loaded first.
 */
export async function downloadDictamen(
  session: WebFormsSession,
  expedienteNum: number,
  dictamenIndex: number,
): Promise<{ session: WebFormsSession; download: DocxDownload | null }> {
  return downloadFromGrid(session, expedienteNum, 'grvDictamenes', dictamenIndex, 'dictamen');
}

/**
 * Download the informe técnico at index N (0-based) from grvTecnicos.
 */
export async function downloadInformeTecnico(
  session: WebFormsSession,
  expedienteNum: number,
  tecIndex: number,
): Promise<{ session: WebFormsSession; download: DocxDownload | null }> {
  return downloadFromGrid(session, expedienteNum, 'grvTecnicos', tecIndex, 'tecnico');
}

async function downloadFromGrid(
  session: WebFormsSession,
  expedienteNum: number,
  gridName: 'grvDictamenes' | 'grvTecnicos',
  index: number,
  labelPrefix: string,
): Promise<{ session: WebFormsSession; download: DocxDownload | null }> {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', `ctl00$ContentPlaceHolder1$${gridName}`);
  form.set('__EVENTARGUMENT', `Select$${index}`);
  form.set('__VIEWSTATE', session.viewState);
  form.set('__VIEWSTATEGENERATOR', session.viewStateGenerator);
  form.set('__EVENTVALIDATION', session.eventValidation);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(expedienteNum));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');

  const { bytes, filename, contentType, setCookie } = await rawFetchBinary(
    `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookies,
        Origin: SIL_WEBFORMS_BASE,
        Referer: `${SIL_WEBFORMS_BASE}${PAGE_PATH}`,
      },
      body: form.toString(),
    },
    `webforms:download_${labelPrefix}:${expedienteNum}:${index}`,
  );

  const cookies = mergeCookies(session.cookies, setCookie);
  if (!isDocxMagic(bytes)) {
    try {
      const html = bytes.toString('utf8');
      const hidden = parseHiddenFields(html);
      return {
        session: { ...hidden, cookies, lastHtml: html },
        download: null,
      };
    } catch {
      return { session, download: null };
    }
  }
  return {
    session,
    download: {
      bytes,
      filename: filename ?? `expediente_${expedienteNum}_${labelPrefix}_${index}.docx`,
      contentType,
    },
  };
}

/**
 * Count the rows currently shown in a child grid (`grvDictamenes` /
 * `grvTecnicos`) of the detail panel. Used by the bulk downloader to know
 * how many Select$N postbacks to fire per expediente.
 */
export function countGridRows(html: string, gridName: 'grvDictamenes' | 'grvTecnicos'): number {
  const $ = cheerio.load(html);
  const rows = $(`[id$="${gridName}"] tr`).filter((_, el) => $(el).find('td').length > 1);
  return rows.length;
}

function classifyDocByLabel(label: string | null): ExpedienteDoc['tipo'] {
  if (!label) return 'otro';
  const l = label.toLowerCase();
  if (l.includes('texto base') || l.includes('proyecto')) return 'texto_base';
  if (l.includes('dictamen mayoría') || l.includes('dictamen mayoria')) return 'dictamen_mayoria';
  if (l.includes('dictamen minoría') || l.includes('dictamen minoria')) return 'dictamen_minoria';
  if (l.includes('dictamen')) return 'dictamen_mayoria';
  if (l.includes('moción') || l.includes('mocion')) return 'mocion';
  if (l.includes('votación') || l.includes('votacion')) return 'votacion';
  if (l.includes('acta')) return 'acta';
  if (l.includes('enmienda')) return 'enmienda';
  return 'otro';
}
