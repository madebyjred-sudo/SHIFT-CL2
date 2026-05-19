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
import { Agent as UndiciAgent } from 'undici';
import { withRetry, withTimeout } from './resilience.js';

// El sitio del SIL (consultassil3.asamblea.go.cr) presenta un certificado
// TLS emitido por una CA gubernamental de Costa Rica que NO está en el
// trust store por default de Node.js. Sin esto, todo fetch al SIL falla
// con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. curl funciona porque usa el
// system CA store del SO.
//
// La solución limpia sería distribuir el cert .pem del gov.cr CA y
// setear NODE_EXTRA_CA_CERTS, pero eso requiere tocar el Dockerfile y
// conseguir el cert. Como pragmatismo, usamos un Agent dedicado SOLO
// para los fetch del SIL con `rejectUnauthorized: false`. Esto NO
// afecta a otras llamadas HTTPS del proceso (Supabase, OpenRouter,
// Vertex AI siguen con TLS estricto).
//
// El dominio está hardcoded — el Agent solo se usa cuando la URL apunta
// a asamblea.go.cr. Cualquier otro destino usa el dispatcher default.
const SIL_TLS_AGENT = new UndiciAgent({
  connect: { rejectUnauthorized: false },
});

const SIL_WEBFORMS_BASE =
  process.env.SIL_WEBFORMS_BASE ?? 'https://consultassil3.asamblea.go.cr';
const PAGE_PATH = '/frmConsultaProyectos.aspx';
// SIL upstream is intermittently slow — observed 0.9s to 30s+ response times
// during the post-outage recovery window 2026-04-27. 60s gives the bulk
// loop enough headroom to ride through the spikes without falling back to
// retry-storm. Override via SIL_WEBFORMS_TIMEOUT_MS if needed.
const WEBFORMS_TIMEOUT_MS = Number(process.env.SIL_WEBFORMS_TIMEOUT_MS ?? 60_000);

// IMPORTANTE: usamos un UA simple para no disparar filtros del SIL. El UA
// previo con sintaxis tipo "(+url; contact: email)" — pensada para ser
// transparente con bots responsables — coincidía con patrones de bot que
// IIS/ASP.NET tira al backend. Diagnóstico 2026-05-12 confirmó: el UA
// elaborado da 500; uno simple funciona. Sin canal oficial para
// whitelistear, mantenemos perfil bajo + politeness por rate-limit interno.
const COMMON_HEADERS = {
  'User-Agent': 'shift-cl2/2.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-CR,es;q=0.9,en;q=0.8',
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
          try {
            // Si el destino es asamblea.go.cr, usamos el Agent dedicado
            // que acepta el cert TLS gubernamental. Otros destinos usan
            // el dispatcher default (TLS estricto).
            const fetchInit: RequestInit & { dispatcher?: unknown } = { ...init, signal };
            if (/\.asamblea\.go\.cr$/i.test(new URL(url).hostname) ||
                /asamblea\.go\.cr$/i.test(new URL(url).hostname)) {
              fetchInit.dispatcher = SIL_TLS_AGENT;
            }
            const res = await fetch(url, fetchInit);
            if (!res.ok) throw new Error(`${label} ${res.status}`);
            const sc =
              typeof (res.headers as any).getSetCookie === 'function'
                ? (res.headers as any).getSetCookie()
                : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : null);
            const html = await res.text();
            return { html, setCookie: sc };
          } catch (err) {
            // Node fetch wraps real network errors in `cause`. Without
            // extracting that, all we see in production is "fetch failed"
            // which is useless for triage.
            const cause = (err as Error & { cause?: unknown })?.cause;
            const causeStr =
              cause instanceof Error
                ? `${cause.name}: ${cause.message}${(cause as Error & { code?: string }).code ? ` [${(cause as Error & { code?: string }).code}]` : ''}`
                : cause
                  ? String(cause)
                  : '';
            const newMsg = causeStr
              ? `${(err as Error).message} (cause: ${causeStr})`
              : (err as Error).message;
            // Re-throw with enriched message so the caller's catch (which
            // already logs `error: message`) captures the real cause.
            const enriched = new Error(newMsg);
            (enriched as Error & { cause?: unknown }).cause = cause;
            throw enriched;
          }
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

/**
 * Estructura rica de un proponente firmante.
 *
 * Apellidos siempre presente (la única columna garantizada del SIL).
 * Las otras 3 dependen de cómo el SIL renderice el bloque:
 * - Para iniciativas de diputado: apellidos + nombre + (admin null) + fraccion
 * - Para iniciativas del Poder Ejecutivo: apellidos="PODER EJECUTIVO"
 *   + (nombre null) + administracion="CHAVES ROBLES" + (fraccion null)
 */
export interface ProponenteFirmante {
  apellidos: string;
  nombre: string | null;
  administracion: string | null;
  fraccion: string | null;
}

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
  /**
   * Apellidos solamente — compat legacy. Para iniciativa del Poder
   * Ejecutivo será ["PODER EJECUTIVO"]. Para diputados, ["RODRÍGUEZ SOLORZANO",
   * "DELGADO RAMÍREZ", ...]. NUEVO callers: usar `proponentesFull`.
   */
  proponentes: string[];
  /**
   * Estructura rica con apellidos + nombre + administracion + fraccion
   * cuando el SIL los expone. Captura desde 2026-05-18 (commit que arregla
   * el bug donde la tabla `sil_expediente_proponentes` quedaba con sólo
   * apellidos y administracion/fraccion siempre null).
   */
  proponentesFull: ProponenteFirmante[];
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

  // Proponentes — captura completa.
  //
  // El SIL renderiza el bloque de firmantes con headers que varían según
  // el tipo de iniciativa:
  //
  // Caso A — iniciativa parlamentaria (mayoritario):
  //   | Secuencia de Firma | Apellidos | Nombre | Fracción |
  //   | 1 | DELGADO RAMÍREZ | JUAN     | LIBERTAD |
  //
  // Caso B — iniciativa del Poder Ejecutivo (~19% del catálogo):
  //   | Secuencia de Firma | Apellidos        | Administración | Fracción |
  //   | 1 | PODER EJECUTIVO | CHAVES ROBLES   |          |
  //
  // Caso C — algunas comisiones especiales tienen 3 columnas:
  //   | Secuencia de Firma | Apellidos | Comisión |
  //
  // Estrategia: detectamos el header con el ancla "Secuencia de Firma"
  // (siempre presente). Una vez dentro del bloque, **leemos los 4 headers
  // como mapa** para saber qué columna es qué (Apellidos / Nombre /
  // Administración / Fracción). Después, cada data row mapeamos por
  // posición. Así soportamos las 3 variantes sin regex frágiles por
  // cada caso.
  //
  // Antes (commit anterior): solo cell[1] como "apellidos" + columnas
  // 2-4 ignoradas. Resultado: 4.207 expedientes con proponente='PODER'
  // (truncado del primer token) y administracion/fraccion siempre null
  // en sil_expediente_proponentes.
  const proponentesFull: ProponenteFirmante[] = [];
  const proponentes: string[] = [];
  let inFirmantes = false;
  let firmantesColumnMap: { apellidos: number; nombre: number; administracion: number; fraccion: number } | null = null;

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const cellTexts = cells.toArray().map((el) => ($(el).text() ?? '').trim());
    const a = cellTexts[0];
    const b = cellTexts[1];

    // Detección del header: cell[0] = "Secuencia de Firma" + cell[1] empieza
    // con "Apellidos" o similar (admite "Apellidos del Proponente" etc.).
    if (/^Secuencia de Firma$/i.test(a) && /apellido/i.test(b)) {
      inFirmantes = true;
      // Mapear las columnas: por defecto cell[1]=apellidos, y buscamos
      // las otras 3 por nombre del header.
      const map = { apellidos: 1, nombre: -1, administracion: -1, fraccion: -1 };
      for (let i = 2; i < cellTexts.length; i++) {
        const h = cellTexts[i].toLowerCase();
        if (h.includes('nombre')) map.nombre = i;
        else if (h.includes('administra')) map.administracion = i;
        else if (h.includes('fracci') || h.includes('partido')) map.fraccion = i;
      }
      firmantesColumnMap = map;
      return;
    }

    if (inFirmantes && firmantesColumnMap) {
      // Las data rows del bloque tienen el primer cell como número entero
      // (orden de firma). El primer cell distinto de número marca el fin.
      if (/^\d+$/.test(a) && b && b.length >= 2 && b.length < 120) {
        const apellidos = b;
        const nombre = firmantesColumnMap.nombre >= 0 && firmantesColumnMap.nombre < cellTexts.length
          ? (cellTexts[firmantesColumnMap.nombre] || '').trim() || null
          : null;
        const administracion = firmantesColumnMap.administracion >= 0 && firmantesColumnMap.administracion < cellTexts.length
          ? (cellTexts[firmantesColumnMap.administracion] || '').trim() || null
          : null;
        const fraccion = firmantesColumnMap.fraccion >= 0 && firmantesColumnMap.fraccion < cellTexts.length
          ? (cellTexts[firmantesColumnMap.fraccion] || '').trim() || null
          : null;

        proponentesFull.push({ apellidos, nombre, administracion, fraccion });
        proponentes.push(apellidos); // legacy compat
      } else if (a !== '' && !/^\d+$/.test(a)) {
        // Nos salimos del bloque de firmantes (otro header o sección).
        inFirmantes = false;
        firmantesColumnMap = null;
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
    proponentesFull,
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

/**
 * Documento descargado del SIL, en cualquier formato. format se deriva de
 * los magic bytes — el SIL etiqueta `application/octet-stream` para ambos
 * formatos así que NO confiamos en contentType.
 *
 * Introducido 2026-05-12 cuando descubrimos que muchos expedientes del
 * 2018+ solo tienen PDF (sin DOCX). El pipeline anterior los marcaba como
 * "sin doc" porque solo aceptaba DOCX magic. Ver 0029_sil_documentos_mime.sql.
 */
export type DocFormat = 'docx' | 'pdf';

export interface SilDownload {
  format: DocFormat;
  bytes: Buffer;
  filename: string | null;
  contentType: string | null;
  mimeType: string;
}

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PDF = 'application/pdf';

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

function isPdfMagic(bytes: Buffer): boolean {
  // `%PDF-` header at start of file.
  return bytes.length > 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Si los bytes son un DOCX o PDF válido, devuelve metadata + format. Si no,
 * retorna null — el caller debe asumir que el server respondió HTML (un
 * re-render del detail panel) y que no hay descarga para este slot/formato.
 */
function classifyDownload(bytes: Buffer, filename: string | null, contentType: string | null): SilDownload | null {
  if (isDocxMagic(bytes)) {
    return { format: 'docx', bytes, filename, contentType, mimeType: MIME_DOCX };
  }
  if (isPdfMagic(bytes)) {
    return { format: 'pdf', bytes, filename, contentType, mimeType: MIME_PDF };
  }
  return null;
}

/**
 * Download the texto base (the proyecto de ley as filed) for the currently-
 * loaded expediente. Caller must have just done a successful
 * searchByNumber + selectExpedienteDetail (the SIL session needs to be on
 * the detail panel of THIS expediente).
 *
 * Returns null when the expediente doesn't have a downloadable texto.
 */
async function downloadTextoBaseInternal(
  session: WebFormsSession,
  expedienteNum: number,
  format: DocFormat,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', session.viewState);
  form.set('__VIEWSTATEGENERATOR', session.viewStateGenerator);
  form.set('__EVENTVALIDATION', session.eventValidation);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(expedienteNum));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');
  // El SIL expone dos botones para el texto base:
  //   btnDescargaTexto → DOCX editable (cuando la oficialía lo generó)
  //   btnDescargaPDF   → PDF universal (siempre disponible si hay texto)
  if (format === 'docx') {
    form.set('ctl00$ContentPlaceHolder1$btnDescargaTexto', 'Descargar');
  } else {
    form.set('ctl00$ContentPlaceHolder1$btnDescargaPDF', 'Descargar');
  }

  const label = `webforms:download_texto_${format}:${expedienteNum}`;
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
    label,
  );

  const cookies = mergeCookies(session.cookies, setCookie);
  const download = classifyDownload(bytes, filename, contentType);
  // El server retorna HTML (re-render del detail panel) cuando no hay file
  // del formato pedido. Detectamos por magic bytes y nos quedamos en
  // session.lastHtml para que el caller pueda hacer fallback al otro formato.
  if (!download) {
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
  // Si los magic bytes coincidieron PERO el formato esperado era distinto,
  // honremos lo que devolvió el server (el SIL ocasionalmente sirve PDF
  // cuando se pidió DOCX si la oficialía generó únicamente PDF).
  return {
    session,
    download: {
      ...download,
      filename: download.filename ?? `expediente_${expedienteNum}_texto.${download.format}`,
    },
  };
}

/**
 * Descarga el texto base del expediente. Intenta DOCX primero (formato
 * editable preferido); si el SIL no lo tiene, cae a PDF. El caller no se
 * preocupa por el formato — solo recibe los bytes con el campo `format`
 * en el objeto.
 *
 * Retorna `download: null` solo cuando NI DOCX NI PDF están disponibles
 * (raro — usualmente al menos PDF existe).
 */
export async function downloadTextoBase(
  session: WebFormsSession,
  expedienteNum: number,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
  const r1 = await downloadTextoBaseInternal(session, expedienteNum, 'docx');
  if (r1.download) return r1;
  // Cuando el SIL devuelve HTML re-render por DOCX inexistente, el server
  // pierde el contexto del detail panel (vuelve al grid de búsqueda).
  // Diagnosticado 2026-05-12: postback directo de btnDescargaPDF en ese
  // estado tira 500 ("Error en runtime") porque ASP.NET intenta resolver
  // el botón en el grid donde no existe. La fix es re-ejecutar
  // search+select para devolver al detail panel ANTES del PDF.
  const reSearch = await searchByNumber(r1.session, expedienteNum);
  if (!reSearch.detail) {
    return { session: reSearch.session, download: null };
  }
  const reSelect = await selectExpedienteDetail(reSearch.session, expedienteNum);
  const r2 = await downloadTextoBaseInternal(reSelect.session, expedienteNum, 'pdf');
  return r2;
}

/**
 * Solo PDF (sin intentar DOCX). Útil cuando ya sabemos que el DOCX no
 * existe y queremos evitar el round-trip extra.
 */
export async function downloadTextoBasePDF(
  session: WebFormsSession,
  expedienteNum: number,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
  return downloadTextoBaseInternal(session, expedienteNum, 'pdf');
}

/**
 * Download the dictamen at index N (0-based) from the grvDictamenes grid.
 * The detail panel for the expediente must be loaded first.
 *
 * Acepta DOCX o PDF — el SIL ocasionalmente sirve PDF para dictámenes
 * cuyo DOCX no se generó. El caller recibe `format` para saber qué parser
 * aplicar.
 */
export async function downloadDictamen(
  session: WebFormsSession,
  expedienteNum: number,
  dictamenIndex: number,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
  return downloadFromGrid(session, expedienteNum, 'grvDictamenes', dictamenIndex, 'dictamen');
}

/**
 * Download the informe técnico at index N (0-based) from grvTecnicos.
 * Acepta DOCX o PDF — ver downloadDictamen para detalles.
 */
export async function downloadInformeTecnico(
  session: WebFormsSession,
  expedienteNum: number,
  tecIndex: number,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
  return downloadFromGrid(session, expedienteNum, 'grvTecnicos', tecIndex, 'tecnico');
}

async function downloadFromGrid(
  session: WebFormsSession,
  expedienteNum: number,
  gridName: 'grvDictamenes' | 'grvTecnicos',
  index: number,
  labelPrefix: string,
): Promise<{ session: WebFormsSession; download: SilDownload | null }> {
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
  const download = classifyDownload(bytes, filename, contentType);
  if (!download) {
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
      ...download,
      filename: download.filename
        ?? `expediente_${expedienteNum}_${labelPrefix}_${index}.${download.format}`,
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

/**
 * Parsea los grids embebidos del detail panel para listar TODOS los
 * documentos disponibles: dictámenes, informes técnicos, mociones, actas,
 * etc. Devuelve metadata + URL del detail (no descarga los PDFs).
 *
 * El SIL expone los docs en varios grids: grvDictamenes, grvTecnicos,
 * y dentro del panel principal hay filas con label "Texto base" + link
 * de descarga. Cada doc se identifica por (gridName, index).
 *
 * El URL devuelto apunta a la página del detail con un fragmento del
 * tipo de doc — el frontend puede mostrarlo como "Documento disponible
 * en el SIL oficial" sin tener el PDF descargado todavía.
 */
export function parseDocumentsFromDetail(
  html: string,
  expedienteNum: number,
): Array<{ tipo: ExpedienteDoc['tipo']; titulo: string | null; fecha: string | null; grid: string; index: number }> {
  const $ = cheerio.load(html);
  const docs: Array<{ tipo: ExpedienteDoc['tipo']; titulo: string | null; fecha: string | null; grid: string; index: number }> = [];

  const grids: Array<{ id: string; defaultLabel: string }> = [
    { id: 'grvDictamenes', defaultLabel: 'Dictamen' },
    { id: 'grvTecnicos', defaultLabel: 'Informe Técnico' },
    { id: 'grvMociones', defaultLabel: 'Moción' },
    { id: 'grvActas', defaultLabel: 'Acta' },
  ];

  // Heurística de detección de fecha en una celda. Acepta "10-oct.-2023",
  // "10/10/2023", "2023-10-10", etc. Si una celda parsea como fecha NO es
  // candidata a título.
  const looksLikeDate = (s: string): boolean => {
    if (!s) return false;
    if (parseSilDate(s)) return true;
    if (/^\d{1,2}[-\/\s][A-Za-záéíóúñ]+\.?[-\/\s]\d{4}$/.test(s)) return true;
    return false;
  };

  for (const g of grids) {
    const rows = $(`[id$="${g.id}"] tr`).filter((_, el) => $(el).find('td').length > 1);
    rows.each((idx, tr) => {
      const tds = $(tr).find('td');
      // Asumimos: [select-button][titulo/desc][fecha?][otras]
      const cellTexts = tds.map((_i, td) => ($(td).text() ?? '').replace(/\s+/g, ' ').trim()).get();
      // Candidatos a título: texto con ≥1 letra, longitud razonable, NO una fecha.
      // El default label del grid es nuestro fallback.
      const tituloCandidato = cellTexts.find(
        (t) => t.length >= 3 && /[A-Za-záéíóúñ]/.test(t) && !looksLikeDate(t),
      );
      const titulo = tituloCandidato ?? g.defaultLabel;
      const fechaText = cellTexts.find((t) => looksLikeDate(t)) ?? null;
      const fecha = fechaText ? parseSilDate(fechaText) : null;
      docs.push({
        tipo: classifyDocByLabel(titulo),
        titulo,
        fecha,
        grid: g.id,
        index: idx,
      });
    });
  }

  // "Texto base" del proyecto: típicamente un solo link, no en un grid sino
  // como botón de descarga en el detail panel. Lo detectamos por el ID del
  // botón btnDescargaTextoBase / lnkTextoBase / similar.
  const hasTextoBase = $('[id*="btnDescargaTextoBase"], [id*="btnTextoBase"], [id*="lnkTextoBase"]').length > 0
    || /texto\s+base/i.test($('body').text());
  if (hasTextoBase) {
    docs.unshift({
      tipo: 'texto_base',
      titulo: 'Texto base del proyecto',
      fecha: null,
      grid: 'main',
      index: 0,
    });
  }

  return docs;
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

// ─── Tramite (grvTramite — timeline procesal) ───────────────────────────────
// El SIL muestra la pestaña "Tramitación" como un grid `grvTramite` con
// columnas [Órgano, Fecha de Inicio, Fecha de Término, Tipo de Trámite].
// Cada fila es un evento del expediente (PRESENTACIÓN, ENVÍO A IMPRENTA,
// RECEPCIÓN COMISIÓN, VOTACIÓN, etc). Esto alimenta `sil_expediente_tramite`.

export interface TramiteEvent {
  organo: string;            // 'PLENARIO', 'AMBIENTE (ÁREA IV)', 'ARCHIVO'
  fechaInicio: string;       // ISO YYYY-MM-DD
  fechaTermino: string | null;
  descripcion: string;       // 'PRESENTACIÓN DEL PROYECTO DE LEY'
}

/**
 * Parsea el grid `grvTramite` del detail HTML del SIL. Retorna los eventos
 * en el orden que vienen del SIL (cronológico).
 *
 * Limitación: el SIL pagina el grid a 10 filas; expedientes con >10 eventos
 * dejan visibles solo las primeras. Para capturar TODO se necesitaría un
 * postback adicional al pager — fuera del alcance de este enricher inicial.
 */
export function parseTramiteFromDetail(html: string): TramiteEvent[] {
  const $ = cheerio.load(html);
  const events: TramiteEvent[] = [];
  const rows = $('[id$="grvTramite"] tr').filter((_, el) => $(el).find('td').length > 1);
  rows.each((_, tr) => {
    const tds = $(tr).find('td');
    // Header del grid se repite por cada página de paginador — saltearlo.
    // Las celdas vienen en orden: [Órgano][Fecha Inicio][Fecha Término][Descripción]
    const cellTexts = tds
      .map((_i, td) => ($(td).text() ?? '').replace(/\s+/g, ' ').trim())
      .get()
      .filter((t) => t && t !== ' '); // tira nbsp's vacíos
    if (cellTexts.length < 4) return;
    const organo = cellTexts[0];
    const fechaInicioRaw = cellTexts[1];
    const fechaTerminoRaw = cellTexts[2];
    const descripcion = cellTexts[3];
    // El grid tiene una fila de paginador con números "1 2" — no es un evento.
    if (/^\d+$/.test(organo) || organo.length > 80) return;
    const fechaInicio = parseSilDate(fechaInicioRaw);
    if (!fechaInicio) return;
    events.push({
      organo,
      fechaInicio,
      fechaTermino: parseSilDate(fechaTerminoRaw),
      descripcion: descripcion.length > 500 ? descripcion.slice(0, 500) : descripcion,
    });
  });
  return events;
}

// ─── Audiencias (grvConvocatoria) ──────────────────────────────────────────
// El SIL expone "Audiencias, Convocatorias" como grid `grvConvocatoria` con
// columnas [Id_Audiencia, (blank), Fecha Sesión, Órgano, Visitante, Puesto,
// Entidad]. Cada fila es una audiencia agendada de la persona X (cargo Y, de
// la entidad Z) ante el órgano. Alimenta `sil_expediente_audiencias` con
// asistente real (no como `agenda_legislativa` que solo trae fecha+comisión).

export interface AudienciaEvent {
  fecha: string;             // ISO YYYY-MM-DD
  comision: string;          // 'AMBIENTE (ÁREA IV)'
  asistenteNombre: string;
  asistenteCargo: string | null;
  asistenteOrganizacion: string | null;
  idAudiencia: string | null; // 8788 — útil para dedup si re-corremos
}

/**
 * Parsea grid `grvConvocatoria`. Como el SIL pagina a 10 filas, solo
 * capturamos la primera página — extender al resto requeriría postbacks
 * adicionales que el enricher hace cost-prohibitive (1 req extra por página
 * por expediente × ~21k expedientes activos = explotamos el rate limit).
 */
export function parseAudienciasFromDetail(html: string): AudienciaEvent[] {
  const $ = cheerio.load(html);
  const events: AudienciaEvent[] = [];
  const rows = $('[id$="grvConvocatoria"] tr').filter((_, el) => $(el).find('td').length > 1);
  rows.each((_, tr) => {
    const tds = $(tr).find('td');
    const cellTexts = tds
      .map((_i, td) => ($(td).text() ?? '').replace(/\s+/g, ' ').trim())
      .get();
    // Cells: [Id_Audiencia][nbsp/blank][Fecha Sesión][Órgano][Visitante][Puesto][Entidad]
    // El "blank" column es siempre un &nbsp; — buscamos por posición pero
    // tolerando que algunas celdas vengan vacías.
    if (cellTexts.length < 6) return;
    const idAudiencia = cellTexts[0]?.trim() || null;
    // El primer celda del header dice "Id_Audiencia" — saltear.
    if (!idAudiencia || !/^\d+$/.test(idAudiencia)) return;
    // Heurística: encontrar la primera celda que parsee como fecha.
    let fechaCellIdx = -1;
    let fecha: string | null = null;
    for (let i = 0; i < cellTexts.length; i++) {
      const f = parseSilDate(cellTexts[i]);
      if (f) {
        fechaCellIdx = i;
        fecha = f;
        break;
      }
    }
    if (!fecha || fechaCellIdx < 0) return;
    const after = cellTexts.slice(fechaCellIdx + 1).filter((t) => t && t !== ' ');
    // after = [organo, visitante, puesto, entidad]
    const organo = after[0] ?? '';
    const visitante = after[1] ?? '';
    const puesto = after[2] ?? null;
    const entidad = after[3] ?? null;
    if (!organo || !visitante) return;
    if (organo.length > 80 || visitante.length > 120) return;
    events.push({
      fecha,
      comision: organo,
      asistenteNombre: visitante,
      asistenteCargo: puesto && puesto.length < 120 ? puesto : null,
      asistenteOrganizacion: entidad && entidad.length < 200 ? entidad : null,
      idAudiencia,
    });
  });
  return events;
}
