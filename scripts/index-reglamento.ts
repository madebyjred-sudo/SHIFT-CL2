/**
 * shift-cl2 — Indexa el Reglamento de la Asamblea Legislativa de CR.
 *
 * Source: https://asamblea.go.cr/sd/Reglamento_Asamblea/ (96 .htm files,
 * uno por artículo). Documento de dominio público (norma vigente).
 *
 * Output: insertions en legislative_chunks con source_type='reglamento'.
 * Cada artículo es UN chunk (típicamente 200-2000 caracteres — no requiere
 * sub-chunking). Esto da a Lexa knowledge procedimental con citation
 * directa al artículo cuando responde preguntas como "¿cuál es el plazo
 * para dictamen?", "¿cómo se vota un proyecto urgente?", etc.
 *
 * Pre-req: 0001_init aplicada. Vertex creds + Supabase service role.
 *
 * Run:   npm run index:reglamento
 * Time:  ~5-8 min para 96 artículos (1 embed por artículo).
 *
 * Idempotent: borra todos los chunks con source_type='reglamento' al inicio
 * y reinserta. Re-running siempre da el mismo estado final.
 */
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;

if (!SUPA_URL || !SUPA_KEY) { console.error('[reglamento] Supabase env missing'); process.exit(1); }
if (!GCP_PROJECT) { console.error('[reglamento] GCP_PROJECT_ID missing'); process.exit(1); }
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('[reglamento] GOOGLE_APPLICATION_CREDENTIALS missing');
  process.exit(1);
}

const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const REGLAMENTO_BASE = 'https://asamblea.go.cr/sd/Reglamento_Asamblea';
const CONCURRENCY_FETCH = 6;
const CONCURRENCY_EMBED = 4;

const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);
const vertex = new PredictionServiceClient({
  apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com`,
});
const VERTEX_ENDPOINT = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;

// ─── Step 1: enumerate articles via directory listing ─────────────────

async function fetchDirectoryListing(): Promise<string[]> {
  const res = await fetch(`${REGLAMENTO_BASE}/`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`directory listing ${res.status}`);
  const html = await res.text();
  // The IIS directory listing serves anchors with UTF-8 characters AS-IS in
  // the href (literal "Artículo_..."), but some mirrors / proxies URL-encode
  // them ("Art%C3%ADculo_..."). Match both shapes.
  const re = /href="(https?:\/\/[^"]*\/(?:Art%C3%ADculo|Art[íi]culo)[^"]*\.htm)"/gi;
  const urls = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Normalize to URL-encoded form so fetch() doesn't get confused on
    // shells that don't preserve the í byte. encodeURI is idempotent.
    urls.add(encodeURI(decodeURI(m[1])));
  }
  return [...urls].sort();
}

// ─── Step 2: download + extract text ──────────────────────────────────

interface ArticleDoc {
  url: string;
  numero: number;          // 113 (parsed from filename)
  numeroStr: string;       // "113"
  titulo: string;          // "Presentación del proyecto"
  fullTitle: string;       // "Artículo 113.- Presentación del proyecto"
  content: string;         // clean body text
}

function parseFilename(url: string): { numero: number; numeroStr: string; titulo: string; fullTitle: string } | null {
  // ".../Artículo_113.-_Presentación_del_proyecto.htm" (URL-encoded variant tolerated)
  const decoded = decodeURIComponent(url);
  const m = decoded.match(/Art[íi]culo_(\d+)\.?-?_?(.+?)\.htm$/i);
  if (!m) return null;
  const numeroStr = m[1];
  const numero = parseInt(numeroStr, 10);
  const titulo = m[2].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const fullTitle = `Artículo ${numeroStr}.- ${titulo}`;
  return { numero, numeroStr, titulo, fullTitle };
}

async function fetchArticle(url: string): Promise<ArticleDoc | null> {
  const meta = parseFilename(url);
  if (!meta) {
    console.warn(`[reglamento] cannot parse filename: ${url}`);
    return null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[reglamento] ${meta.fullTitle} → http ${res.status}`);
      return null;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    // Strip noise — RoboHelp dumps a lot of inline JS and CSS in <script>/<style>.
    $('script, style, link, meta, noscript').remove();
    // Visible body text only.
    const raw = $('body').text() || $.root().text();
    const cleaned = raw
      .replace(/\u00a0/g, ' ')        // nbsp
      .replace(/\/\*[\s\S]*?\*\//g, '') // residual /* */ comments
      .replace(/<!--[\s\S]*?-->/g, '')  // residual HTML comments
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 30) {
      console.warn(`[reglamento] ${meta.fullTitle} → empty after cleanup`);
      return null;
    }
    // Strip the title from the body if it appears at the start (avoids
    // duplication once we prepend it as section header).
    let body = cleaned;
    const titlePattern = new RegExp(`^Art[íi]culo\\s*${meta.numeroStr}[.\\s\\-]*${meta.titulo}\\s*`, 'i');
    body = body.replace(titlePattern, '').trim();
    return {
      url,
      numero: meta.numero,
      numeroStr: meta.numeroStr,
      titulo: meta.titulo,
      fullTitle: meta.fullTitle,
      content: body,
    };
  } catch (err) {
    console.warn(`[reglamento] ${meta.fullTitle} → error: ${(err as Error).message}`);
    return null;
  }
}

async function inFlight<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Step 3: embed ────────────────────────────────────────────────────

async function embedOne(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: EMBED_DIM });
  const [response] = await vertex.predict({
    endpoint: VERTEX_ENDPOINT,
    instances: instance ? [instance] : [],
    parameters,
  });
  const decoded = helpers.fromValue(response.predictions?.[0] as never) as {
    embeddings?: { values?: number[] };
  };
  const values = decoded?.embeddings?.values;
  if (!values || !Array.isArray(values)) throw new Error('vertex: missing embeddings.values');
  return values;
}

// ─── Step 4: persist ──────────────────────────────────────────────────

async function clearReglamentoChunks(): Promise<void> {
  const { error } = await supa
    .from('legislative_chunks')
    .delete()
    .eq('source_type', 'metadata') // reuse 'metadata' bucket if 0005 didn't add 'reglamento'
    .ilike('source_ref', 'Reglamento Asamblea%');
  // Best-effort: also try the explicit source_type if migration 0006 ran.
  await supa
    .from('legislative_chunks')
    .delete()
    .eq('source_type', 'reglamento')
    .then(undefined, () => null);
  if (error && !error.message.includes('source_type_check')) {
    console.warn(`[reglamento] clear pre-existing failed: ${error.message}`);
  }
}

async function insertChunks(articles: ArticleDoc[], embeddings: number[][]): Promise<number> {
  // Try source_type='reglamento' first; if the constraint rejects it (i.e.
  // migration 0006 hasn't been applied), fall back to 'metadata' bucket
  // with a recognizable source_ref so the chat tool can filter on it.
  const tryRows = (sourceType: string) => articles.map((art, i) => ({
    session_id: null,
    source_type: sourceType,
    source_ref: `Reglamento Asamblea · ${art.fullTitle}`,
    chunk_index: art.numero,
    content: `${art.fullTitle}\n\n${art.content}`,
    embedding: embeddings[i] as unknown as string,
    metadata: {
      reglamento: true,
      articulo_numero: art.numero,
      articulo_numero_str: art.numeroStr,
      articulo_titulo: art.titulo,
      articulo_full_title: art.fullTitle,
      url: art.url,
      doc: 'Reglamento de la Asamblea Legislativa de Costa Rica',
    },
  }));

  let attempted = tryRows('reglamento');
  let { error, count } = await supa.from('legislative_chunks').insert(attempted, { count: 'exact' });
  if (error?.message?.includes('source_type_check')) {
    console.log('[reglamento] migration 0006 not applied; falling back to source_type=metadata');
    attempted = tryRows('metadata');
    ({ error, count } = await supa.from('legislative_chunks').insert(attempted, { count: 'exact' }));
  }
  if (error) {
    console.error(`[reglamento] insert error: ${error.message}`);
    return 0;
  }
  return count ?? attempted.length;
}

// ─── Driver ───────────────────────────────────────────────────────────

async function main() {
  console.log(`[reglamento] start. embed=${EMBED_MODEL}/${EMBED_DIM}d`);

  console.log('[reglamento] step 1/4 — discover articles…');
  const urls = await fetchDirectoryListing();
  console.log(`[reglamento]   discovered ${urls.length} article URLs`);
  if (urls.length === 0) {
    console.error('[reglamento] no articles discovered — abort');
    process.exit(1);
  }

  console.log('[reglamento] step 2/4 — download + extract…');
  const t0 = Date.now();
  const fetched = await inFlight(urls, CONCURRENCY_FETCH, fetchArticle);
  const articles: ArticleDoc[] = fetched.filter((x): x is ArticleDoc => x !== null);
  console.log(`[reglamento]   ${articles.length}/${urls.length} OK in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (articles.length === 0) {
    console.error('[reglamento] zero successful fetches — abort');
    process.exit(1);
  }

  console.log('[reglamento] step 3/4 — embed…');
  const t1 = Date.now();
  const embeddings = await inFlight(
    articles,
    CONCURRENCY_EMBED,
    async (art) => embedOne(`${art.fullTitle}\n\n${art.content}`),
  );
  console.log(`[reglamento]   ${embeddings.length} embeddings in ${Math.round((Date.now() - t1) / 1000)}s`);

  console.log('[reglamento] step 4/4 — persist (clear + insert)…');
  await clearReglamentoChunks();
  const inserted = await insertChunks(articles, embeddings);
  console.log(`[reglamento]   inserted ${inserted} chunks`);

  console.log(`[reglamento] DONE — ${articles.length} articles indexed in ${Math.round((Date.now() - t0) / 1000)}s total`);
}

main().catch((err) => {
  console.error('[reglamento] fatal', err);
  process.exit(1);
});
