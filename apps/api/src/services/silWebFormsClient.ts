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
 * Look up a specific expediente by its sequential number. Returns null if
 * the SIL didn't surface a result (deleted, archived, or out of range).
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
