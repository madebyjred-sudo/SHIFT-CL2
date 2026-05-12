/**
 * diagnose-sil-pdf.ts — descubrir por qué btnDescargaPDF tira 500.
 *
 * Hipótesis a probar:
 *   H1. El SIL devuelve 500 cuando el expediente no tiene PDF de texto
 *       base. (Esperamos que devuelva HTML re-render, igual que DOCX.)
 *   H2. La sesión queda corrupta después del attempt DOCX fallido.
 *   H3. Falta un campo en el POST (e.g., __LASTFOCUS, __SCROLLPOSITIONX).
 *   H4. El SIL exige cookies extra que no estamos enviando.
 *
 * Cómo correr:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.local \
 *     --import tsx scripts/diagnose-sil-pdf.ts
 *
 * Lo que imprime:
 *   - Por cada expediente: response status, content-type, content-length,
 *     primeros 500 chars del body, primer chunk de magic bytes.
 *   - Si el body es HTML, intenta detectar mensajes de error visibles
 *     ("Error inesperado", "VIEWSTATE inválido", etc.).
 *   - Compara: (a) sesión fresca + PDF directo, (b) sesión fresca + search
 *     + PDF, (c) sesión + search + DOCX fail + PDF (el flujo actual del bulk).
 */
import { Agent as UndiciAgent } from 'undici';

const SIL_BASE = 'https://consultassil3.asamblea.go.cr';
const PAGE = '/frmConsultaProyectos.aspx';
const SIL_AGENT = new UndiciAgent({ connect: { rejectUnauthorized: false } });

const HEADERS = {
  'User-Agent': 'shift-cl2-diag/1.0',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-CR,es;q=0.9',
};

interface FetchResult {
  status: number;
  contentType: string;
  contentLength: number;
  setCookie: string[];
  bodyBytes: Buffer;
  isHtml: boolean;
  isPdf: boolean;
  isDocx: boolean;
}

async function rawFetch(url: string, opts: RequestInit & { dispatcher?: unknown } = {}): Promise<FetchResult> {
  const res = await fetch(url, { ...opts, dispatcher: SIL_AGENT } as RequestInit);
  const buf = Buffer.from(await res.arrayBuffer());
  const sig = buf.subarray(0, 4).toString('hex');
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    contentLength: buf.length,
    setCookie: res.headers.getSetCookie?.() ?? [],
    bodyBytes: buf,
    isHtml: (res.headers.get('content-type') ?? '').toLowerCase().includes('html'),
    isPdf: sig.startsWith('25504446'),       // %PDF
    isDocx: sig.startsWith('504b0304'),     // PK ZIP (DOCX)
  };
}

function parseHidden(html: string): { vs: string; vsg: string; ev: string } {
  const grab = (name: string) => {
    const m = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]*)"`, 'i'));
    return m?.[1] ?? '';
  };
  return {
    vs: grab('__VIEWSTATE'),
    vsg: grab('__VIEWSTATEGENERATOR'),
    ev: grab('__EVENTVALIDATION'),
  };
}

function mergeCookies(prev: string, setCookie: string[]): string {
  const jar: Record<string, string> = {};
  // existentes
  prev.split(';').map((s) => s.trim()).filter(Boolean).forEach((kv) => {
    const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  });
  // nuevos
  for (const sc of setCookie) {
    const [first] = sc.split(';');
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function describe(label: string, r: FetchResult, body?: string) {
  console.log(`\n── ${label} ───────────────────────────`);
  console.log(`status:           ${r.status}`);
  console.log(`content-type:     ${r.contentType}`);
  console.log(`content-length:   ${r.contentLength}`);
  console.log(`magic:            ${r.isPdf ? 'PDF' : r.isDocx ? 'DOCX/ZIP' : r.isHtml ? 'HTML' : 'unknown'}`);
  if (r.setCookie.length) console.log(`set-cookie:       ${r.setCookie.length} cookies`);
  if (r.isHtml || r.status >= 500) {
    const txt = body ?? r.bodyBytes.toString('utf8');
    // mensajes de error típicos de WebForms
    const errMatch = txt.match(/<title>([^<]+)<\/title>/i)?.[1];
    if (errMatch) console.log(`page-title:       "${errMatch.trim()}"`);
    const aspError = txt.match(/<h2[^>]*>([^<]*Error[^<]*)<\/h2>/i)?.[1];
    if (aspError) console.log(`asp-error:        "${aspError.trim()}"`);
    const exc = txt.match(/Exception Details[:.]?\s*([^<\n]+)/i)?.[1];
    if (exc) console.log(`exception:        "${exc.trim()}"`);
    const stack = txt.match(/Stack Trace[:.]?\s*\n([^\n]{1,200})/i)?.[1];
    if (stack) console.log(`stack[0]:         "${stack.trim()}"`);
    // 500 a veces es página de error rica, a veces texto simple
    const hint = txt.length < 3000 ? txt : txt.slice(0, 500);
    if (r.status >= 500 || !r.isHtml) {
      console.log(`body-preview:\n${hint.slice(0, 800)}`);
    }
  }
}

async function getInitialSession(): Promise<{ vs: string; vsg: string; ev: string; cookies: string; html: string }> {
  const r = await rawFetch(`${SIL_BASE}${PAGE}`, { method: 'GET', headers: HEADERS });
  const html = r.bodyBytes.toString('utf8');
  const hidden = parseHidden(html);
  const cookies = mergeCookies('', r.setCookie);
  return { ...hidden, cookies, html };
}

async function search(session: { vs: string; vsg: string; ev: string; cookies: string }, exp: number) {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', session.vs);
  form.set('__VIEWSTATEGENERATOR', session.vsg);
  form.set('__EVENTVALIDATION', session.ev);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(exp));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');
  form.set('ctl00$ContentPlaceHolder1$btnBuscar', 'Buscar');

  const r = await rawFetch(`${SIL_BASE}${PAGE}`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookies,
      Origin: SIL_BASE,
      Referer: `${SIL_BASE}${PAGE}`,
    },
    body: form.toString(),
  });
  const html = r.bodyBytes.toString('utf8');
  const hidden = parseHidden(html);
  const cookies = mergeCookies(session.cookies, r.setCookie);
  return { result: r, html, ...hidden, cookies };
}

async function download(
  session: { vs: string; vsg: string; ev: string; cookies: string },
  exp: number,
  button: 'btnDescargaPDF' | 'btnDescargaTexto',
) {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', session.vs);
  form.set('__VIEWSTATEGENERATOR', session.vsg);
  form.set('__EVENTVALIDATION', session.ev);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(exp));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');
  form.set(`ctl00$ContentPlaceHolder1$${button}`, 'Descargar');

  return rawFetch(`${SIL_BASE}${PAGE}`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookies,
      Origin: SIL_BASE,
      Referer: `${SIL_BASE}${PAGE}`,
    },
    body: form.toString(),
  });
}

async function selectDetail(
  session: { vs: string; vsg: string; ev: string; cookies: string },
  exp: number,
) {
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$grvLey');
  form.set('__EVENTARGUMENT', 'Select$0');
  form.set('__VIEWSTATE', session.vs);
  form.set('__VIEWSTATEGENERATOR', session.vsg);
  form.set('__EVENTVALIDATION', session.ev);
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaLey', String(exp));
  form.set('ctl00$ContentPlaceHolder1$tbxBuscaDescripcion', '');

  const r = await rawFetch(`${SIL_BASE}${PAGE}`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookies,
      Origin: SIL_BASE,
      Referer: `${SIL_BASE}${PAGE}`,
    },
    body: form.toString(),
  });
  const html = r.bodyBytes.toString('utf8');
  const hidden = parseHidden(html);
  const cookies = mergeCookies(session.cookies, r.setCookie);
  return { result: r, html, ...hidden, cookies };
}

async function diagnoseExpediente(exp: number) {
  console.log(`\n\n══════════════════════════════════════════════════════════════════`);
  console.log(`EXPEDIENTE ${exp}`);
  console.log(`══════════════════════════════════════════════════════════════════`);

  // Escenario D: flujo completo correcto: search → selectDetail → PDF
  console.log(`\n[D] FLUJO COMPLETO: search → selectDetail → btnDescargaPDF`);
  const sD0 = await getInitialSession();
  const sD1 = await search(sD0, exp);
  describe('D.search', sD1.result);
  const sD2 = await selectDetail(
    { vs: sD1.vs, vsg: sD1.vsg, ev: sD1.ev, cookies: sD1.cookies },
    exp,
  );
  describe('D.selectDetail', sD2.result);
  // ver si el HTML tras select muestra los botones de descarga
  const hasPdfBtn = sD2.html.includes('btnDescargaPDF');
  const hasDocxBtn = sD2.html.includes('btnDescargaTexto');
  console.log(`detail tiene btnDescargaPDF en HTML: ${hasPdfBtn}`);
  console.log(`detail tiene btnDescargaTexto en HTML: ${hasDocxBtn}`);

  const rDpdf = await download(
    { vs: sD2.vs, vsg: sD2.vsg, ev: sD2.ev, cookies: sD2.cookies },
    exp,
    'btnDescargaPDF',
  );
  describe('D: PDF tras select', rDpdf);

  if (rDpdf.status === 500) {
    // intentar DOCX en cambio
    const rDdocx = await download(
      { vs: sD2.vs, vsg: sD2.vsg, ev: sD2.ev, cookies: sD2.cookies },
      exp,
      'btnDescargaTexto',
    );
    describe('D2: DOCX tras select (mismo session)', rDdocx);
  }
}

async function main() {
  // 3 expedientes que fallaron en el bulk + 1 control que sabemos funcionó
  const targets = [
    25591, // CONTROL: funcionó (OVERSIZED 21MB, pero se descargó)
    25587, // fail PDF 500
    25351, // fail DOCX timeout
    24007, // fail PDF 500 (test case original — sabemos que es PDF escaneado)
  ];

  for (const exp of targets) {
    try {
      await diagnoseExpediente(exp);
    } catch (err) {
      console.error(`[exp ${exp}] error inesperado:`, (err as Error).message);
    }
    // pausa entre expedientes para no martillar
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('DIAGNÓSTICO COMPLETADO');
  console.log('══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
