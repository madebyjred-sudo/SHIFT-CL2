/**
 * shift-cl2 — SIL document processor (D2 of SIL integration).
 *
 * Pulls pending docs from sil_documentos, downloads each from asamblea.go.cr,
 * mirrors the original to GCS (bucket: GCS_BUCKET_SIL), extracts text (PDF
 * via pdf-parse, HTML via cheerio), chunks it, embeds with Vertex
 * gemini-embedding-001, and writes the chunks into legislative_chunks with
 * the right SIL source_type so search_sil_corpus can find them.
 *
 * Pre-req:
 *   - 0005_sil_corpus.sql applied
 *   - Some sil_documentos rows already inserted by backfill-sil-webforms.ts
 *   - GCS bucket shift-cl2-sil created with storage.objectAdmin on the SA
 *
 * Run:
 *   npm run process:sil:docs
 *   # or with caps for an iterative run:
 *   LIMIT=200 PRIORITY_MONTHS=12 npm run process:sil:docs
 *
 * Resumable: docs marked status='downloaded'/'parsed'/'embedded' are skipped
 * unless FORCE=1. Errors are sticky (status='error', error_message set) so
 * the operator can investigate and retry selectively.
 *
 * Priority order (when LIMIT is set):
 *   1. Leyes aprobadas (sil_leyes_aprobadas linked docs).
 *   2. Dictámenes mayoría/minoría from expedientes touched in last
 *      PRIORITY_MONTHS (default 12).
 *   3. Texto base of those expedientes.
 *   4. Everything else (mociones, votaciones, actas) — only if budget.
 */
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import * as cheerio from 'cheerio';

// ─── Config ───────────────────────────────────────────────────────────

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const GCS_BUCKET = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';

if (!SUPA_URL || !SUPA_KEY) { console.error('[sil-docs] Supabase env missing'); process.exit(1); }
if (!GCP_PROJECT) { console.error('[sil-docs] GCP_PROJECT_ID missing'); process.exit(1); }
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) { console.error('[sil-docs] GOOGLE_APPLICATION_CREDENTIALS missing'); process.exit(1); }

const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const storage = new Storage();

// CLI args
const LIMIT = Number(process.env.LIMIT ?? '500');
const PRIORITY_MONTHS = Number(process.env.PRIORITY_MONTHS ?? '12');
const FORCE = process.env.FORCE === '1';
const CONCURRENCY = Number(process.env.SIL_DOCS_CONCURRENCY ?? '4');
const CHUNK_CHARS = 1500;
const VERTEX_CONCURRENCY = 4;
const HTTP_TIMEOUT_MS = 30_000;

// Vertex setup
const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? '3072');

// pdf-parse v2 ESM/CJS dance — same pattern as ingest.ts route.
let _PDFParse: any | null = null;
async function getPDFParse(): Promise<any> {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = (mod as any).PDFParse ?? (mod as any).default?.PDFParse;
  if (!_PDFParse) throw new Error('pdf-parse: PDFParse class not found');
  return _PDFParse;
}

// Vertex client (lazy — same pattern as embeddings.ts).
let _vertex: any | null = null;
let _vertexHelpers: any | null = null;
async function vertex(): Promise<{ client: any; helpers: any; endpoint: string }> {
  if (!_vertex) {
    const mod = await import('@google-cloud/aiplatform');
    _vertex = new mod.PredictionServiceClient({
      apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com`,
    });
    _vertexHelpers = mod.helpers;
  }
  return {
    client: _vertex,
    helpers: _vertexHelpers,
    endpoint: `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`,
  };
}

// ─── Types ────────────────────────────────────────────────────────────

interface SilDocRow {
  id: string;
  expediente_id: number | null;
  tipo: string;
  titulo: string | null;
  fecha: string | null;
  source_url: string;
  status: string;
}

interface ExpedienteJoinRow {
  id: number;
  numero: string;
  titulo: string | null;
  comision: string | null;
  fecha_presentacion: string | null;
  estado: string | null;
  url_detalle: string;
}

// Map sil_documentos.tipo → legislative_chunks.source_type. The latter is
// what `search_sil_corpus` filters on; keeping the discriminator wide lets
// the UI render different badge labels per doc kind.
function mapSourceType(docTipo: string): string {
  switch (docTipo) {
    case 'dictamen_mayoria':
    case 'dictamen_minoria': return 'sil_dictamen';
    case 'mocion': return 'sil_mocion';
    case 'votacion': return 'sil_votacion';
    case 'acta': return 'sil_acta';
    case 'texto_base':
    case 'enmienda': return 'sil_expediente';
    default: return 'sil_expediente';
  }
}

interface Stats {
  scanned: number;
  skipped: number;
  downloaded: number;
  parsed: number;
  embedded: number;
  failed: number;
  totalChunks: number;
  bytesIn: number;
}

// ─── Pull priority queue ──────────────────────────────────────────────

async function fetchPendingDocs(): Promise<Array<SilDocRow & { exp: ExpedienteJoinRow | null }>> {
  // Window: docs whose expediente has fecha_presentacion within last
  // PRIORITY_MONTHS, OR docs with no expediente fecha (orphans we still want).
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PRIORITY_MONTHS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Two-stage fetch: first the expediente ids in window, then the docs.
  const { data: expsRecent, error: expErr } = await supa
    .from('sil_expedientes')
    .select('id, numero, titulo, comision, fecha_presentacion, estado, url_detalle')
    .gte('fecha_presentacion', cutoffIso)
    .order('fecha_presentacion', { ascending: false })
    .limit(2000);
  if (expErr) throw new Error(`fetch expedientes: ${expErr.message}`);

  const expById = new Map<number, ExpedienteJoinRow>();
  for (const e of (expsRecent ?? []) as ExpedienteJoinRow[]) expById.set(e.id, e);
  const expIds = [...expById.keys()];
  if (expIds.length === 0) {
    console.warn(`[sil-docs] no expedientes within last ${PRIORITY_MONTHS} months — running full scan`);
  }

  let q = supa
    .from('sil_documentos')
    .select('id, expediente_id, tipo, titulo, fecha, source_url, status');
  if (!FORCE) q = q.eq('status', 'pending');
  if (expIds.length > 0) q = q.in('expediente_id', expIds);
  // Order: dictámenes first (highest analytical value), texto_base second.
  q = q.order('tipo', { ascending: true });
  q = q.limit(LIMIT);

  const { data: docs, error: docErr } = await q;
  if (docErr) throw new Error(`fetch docs: ${docErr.message}`);

  return (docs ?? []).map((d) => ({
    ...(d as SilDocRow),
    exp: d.expediente_id != null ? expById.get(d.expediente_id) ?? null : null,
  }));
}

// ─── Per-doc pipeline ─────────────────────────────────────────────────

async function downloadAndMirror(doc: SilDocRow): Promise<{ buf: Buffer; gcsPath: string; mime: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(doc.source_url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'shift-cl2/1.0 (+https://cl2.shiftlab.io)',
        Accept: 'application/pdf,text/html,*/*',
      },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';

    // Mirror to GCS — path: doc-id-as-uuid + extension guess.
    const ext = mime.includes('pdf')
      ? 'pdf'
      : mime.includes('html')
        ? 'html'
        : 'bin';
    const gcsPath = `docs/${doc.id}.${ext}`;
    await storage.bucket(GCS_BUCKET).file(gcsPath).save(buf, {
      contentType: mime,
      // Avoid public read by default — bucket should not be public.
      // metadata: { source_url: doc.source_url } is set via custom metadata.
      metadata: { metadata: { source_url: doc.source_url, sil_doc_id: doc.id } },
    });
    return { buf, gcsPath, mime };
  } finally {
    clearTimeout(timer);
  }
}

async function extractText(buf: Buffer, mime: string): Promise<string> {
  if (mime.includes('pdf')) {
    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: buf });
    const parsed = await parser.getText();
    await parser.destroy?.();
    return (parsed.text ?? '').trim();
  }
  if (mime.includes('html') || mime.includes('xhtml')) {
    const $ = cheerio.load(buf.toString());
    // Strip nav/footer/script — keep only main content.
    $('script, style, nav, footer, header, aside').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }
  // Best-effort fallback.
  return buf.toString('utf8').replace(/\s+/g, ' ').trim();
}

interface Chunk { text: string; index: number; }

function chunkText(text: string, maxChars: number): Chunk[] {
  if (!text) return [];
  // Split on paragraph boundaries first; if a paragraph itself is huge,
  // sub-split at sentence boundaries; if still huge, hard-cut.
  const paragraphs = text.split(/\n{2,}|\.\s+(?=[A-ZÁÉÍÓÚÑ])/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf = '';
  let idx = 0;

  const flush = () => {
    const t = buf.trim();
    if (t.length >= 100) {
      chunks.push({ text: t, index: idx++ });
    }
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > maxChars) {
      // Hard-cut oversized paragraph.
      if (buf) flush();
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push({ text: p.slice(i, i + maxChars).trim(), index: idx++ });
      }
      continue;
    }
    if ((buf.length + p.length + 2) > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const v = await vertex();
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  const workers = Array.from({ length: Math.min(VERTEX_CONCURRENCY, texts.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      let attempt = 0;
      while (true) {
        try {
          const instance = v.helpers.toValue({ content: item.t, task_type: 'RETRIEVAL_DOCUMENT' });
          const parameters = v.helpers.toValue({ outputDimensionality: EMBED_DIM });
          const [response] = await v.client.predict({
            endpoint: v.endpoint,
            instances: instance ? [instance] : [],
            parameters,
          });
          const decoded = v.helpers.fromValue(response.predictions?.[0] as never) as {
            embeddings?: { values?: number[] };
          };
          const values = decoded?.embeddings?.values;
          if (!values || !Array.isArray(values)) throw new Error('vertex: no values');
          out[item.i] = values;
          break;
        } catch (err) {
          attempt += 1;
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function processDoc(
  doc: SilDocRow & { exp: ExpedienteJoinRow | null },
  stats: Stats,
): Promise<void> {
  const docLabel = `${doc.tipo}#${doc.id.slice(0, 8)}${doc.exp ? ` (Exp.${doc.exp.numero})` : ''}`;

  try {
    // 1. Download + mirror to GCS.
    const { buf, gcsPath, mime } = await downloadAndMirror(doc);
    stats.bytesIn += buf.byteLength;
    stats.downloaded += 1;

    await supa
      .from('sil_documentos')
      .update({
        gcs_path: `gs://${GCS_BUCKET}/${gcsPath}`,
        status: 'downloaded',
        updated_at: new Date().toISOString(),
      })
      .eq('id', doc.id);

    // 2. Extract text.
    const text = await extractText(buf, mime);
    if (text.length < 50) {
      // Not enough signal to embed. Mark as parsed-but-empty so we don't retry.
      await supa
        .from('sil_documentos')
        .update({
          text_extracted: text,
          text_chars: text.length,
          status: 'parsed',
          error_message: 'extraction yielded too little text',
          updated_at: new Date().toISOString(),
        })
        .eq('id', doc.id);
      console.warn(`[skip] ${docLabel} parsed empty (${text.length} chars)`);
      return;
    }
    stats.parsed += 1;

    // 3. Chunk.
    const chunks = chunkText(text, CHUNK_CHARS);
    if (chunks.length === 0) {
      await supa
        .from('sil_documentos')
        .update({
          text_extracted: text.slice(0, 200_000),
          text_chars: text.length,
          status: 'parsed',
          error_message: 'chunking produced zero chunks',
          updated_at: new Date().toISOString(),
        })
        .eq('id', doc.id);
      return;
    }

    // 4. Embed.
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    // 5. Insert into legislative_chunks.
    // Schema requires session_id (FK to sessions, nullable). For SIL docs we
    // leave it null and use source_ref to identify the expediente.
    const sourceType = mapSourceType(doc.tipo);
    const sourceRef = doc.exp
      ? `Exp. ${doc.exp.numero} — ${doc.tipo}`
      : `${doc.tipo}#${doc.id.slice(0, 8)}`;
    const rows = chunks.map((c, i) => ({
      session_id: null,
      source_type: sourceType,
      source_ref: sourceRef,
      chunk_index: c.index,
      content: c.text,
      embedding: embeddings[i] as unknown as string,
      metadata: {
        sil_doc_id: doc.id,
        sil_doc_tipo: doc.tipo,
        sil_doc_titulo: doc.titulo,
        sil_doc_fecha: doc.fecha,
        sil_doc_url: doc.source_url,
        gcs_path: `gs://${GCS_BUCKET}/${gcsPath}`,
        expediente_numero: doc.exp?.numero ?? null,
        expediente_titulo: doc.exp?.titulo ?? null,
        expediente_url: doc.exp?.url_detalle ?? null,
        comision: doc.exp?.comision ?? null,
        estado: doc.exp?.estado ?? null,
        fecha_presentacion: doc.exp?.fecha_presentacion ?? null,
      },
    }));

    // Insert in batches to stay under payload limits with 3072-d vectors.
    for (let i = 0; i < rows.length; i += 50) {
      const slice = rows.slice(i, i + 50);
      const { error: cErr } = await supa.from('legislative_chunks').insert(slice);
      if (cErr) throw new Error(`chunks insert (batch ${i}): ${cErr.message}`);
    }

    await supa
      .from('sil_documentos')
      .update({
        text_extracted: text.slice(0, 500_000),
        text_chars: text.length,
        status: 'embedded',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', doc.id);

    stats.embedded += 1;
    stats.totalChunks += chunks.length;
    console.log(`[ok]   ${docLabel} → ${chunks.length} chunks (${text.length} chars)`);
  } catch (err) {
    stats.failed += 1;
    const msg = (err as Error).message ?? String(err);
    console.error(`[err]  ${docLabel}: ${msg}`);
    await supa
      .from('sil_documentos')
      .update({
        status: 'error',
        error_message: msg.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', doc.id);
  }
}

// ─── Driver ───────────────────────────────────────────────────────────

async function inChunks<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`[sil-docs] start. bucket=${GCS_BUCKET} embed=${EMBED_MODEL}/${EMBED_DIM}d limit=${LIMIT} months=${PRIORITY_MONTHS} concurrency=${CONCURRENCY}${FORCE ? ' (force)' : ''}`);

  const docs = await fetchPendingDocs();
  console.log(`[sil-docs] fetched ${docs.length} pending docs`);
  if (docs.length === 0) {
    console.log('[sil-docs] nothing to do');
    return;
  }

  // crawl_runs row for observability.
  const { data: crawlRow } = await supa
    .from('sil_crawl_runs')
    .insert({
      source: 'sharepoint_odata', // closest existing enum value; consider extending in 0006
      list_or_target: 'sil_documents:embed',
      detail: { limit: LIMIT, priority_months: PRIORITY_MONTHS, force: FORCE },
    })
    .select('id')
    .single();
  const crawlId = crawlRow?.id ?? null;

  const stats: Stats = {
    scanned: docs.length,
    skipped: 0,
    downloaded: 0,
    parsed: 0,
    embedded: 0,
    failed: 0,
    totalChunks: 0,
    bytesIn: 0,
  };

  await inChunks(docs, CONCURRENCY, (doc) => processDoc(doc, stats));

  if (crawlId) {
    await supa
      .from('sil_crawl_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in: stats.scanned,
        rows_out: stats.embedded,
        errors: stats.failed,
        status: stats.failed === 0 ? 'success' : 'partial',
        detail: {
          limit: LIMIT,
          priority_months: PRIORITY_MONTHS,
          force: FORCE,
          downloaded: stats.downloaded,
          parsed: stats.parsed,
          embedded: stats.embedded,
          totalChunks: stats.totalChunks,
          bytesInMB: Math.round(stats.bytesIn / 1024 / 1024),
        },
      })
      .eq('id', crawlId);
  }

  console.log(
    `\n[sil-docs] DONE — scanned=${stats.scanned} downloaded=${stats.downloaded} parsed=${stats.parsed} embedded=${stats.embedded} failed=${stats.failed} chunks=${stats.totalChunks} bytes=${Math.round(stats.bytesIn / 1024 / 1024)}MB`,
  );
}

main().catch((err) => {
  console.error('[sil-docs] fatal', err);
  process.exit(1);
});
