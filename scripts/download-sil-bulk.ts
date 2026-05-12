/**
 * shift-cl2 — Bulk DOCX downloader from the SIL.
 *
 * Findings of the 2026-04-25 reconnaissance: the SIL DOES expose the
 * actual document bytes (texto base, dictámenes, informes técnicos) but
 * NOT as PDFs and NOT as canonical URLs. They come back as DOCX (Word
 * 2007+, ZIP container) via ASP.NET WebForms postbacks against the same
 * `frmConsultaProyectos.aspx` page.
 *
 * This script does the full pipeline per expediente:
 *   1. createSession()                                    — bootstrap WebForms
 *   2. searchByNumber(num)                                — load grid
 *   3. selectExpedienteDetail(num)                        — load detail panel
 *   4. downloadTextoBase(num)                             — DOCX of the project
 *   5. for each dictamen index:    downloadDictamen(num, i)
 *   6. for each tec index:         downloadInformeTecnico(num, i)
 * Each successful DOCX is uploaded to gs://${GCS_BUCKET_SIL}/expedientes/
 * /<numero>/<tipo>_<idx>.docx, parsed to plain text with mammoth, chunked,
 * embedded with Vertex, and persisted to legislative_chunks +
 * sil_documentos.
 *
 * Pre-req: GCS bucket exists; 0006/0007/0008 applied (or fallback paths).
 *
 * Run:        npm run download:sil:bulk
 * Time:       ~6-8h for 21k expedientes (concurrency 4, ~5 docs/exp avg).
 *             Designed to run overnight or in background.
 * Resumable:  set START_FROM=N to skip lower expediente numbers; LIMIT=N
 *             caps the total count.
 * Order:      ascending by expediente id (oldest first) by default.
 *             Set NEWEST_FIRST=1 to walk descending — covers the active
 *             period first (most relevant for current legislative work),
 *             leaving historical bulk for later. SIL's webforms backend
 *             also tends to be more responsive for recent expedientes,
 *             which means fewer 30s timeouts per batch.
 *
 * Idempotent: existing sil_documentos rows for an expediente are deleted
 * and re-inserted on each run for that expediente. Set FORCE=0 to skip
 * expedientes that already have any sil_documentos row.
 */
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import * as mammoth from 'mammoth';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  downloadTextoBase,
  downloadDictamen,
  downloadInformeTecnico,
  type SilDownload,
  countGridRows,
  type WebFormsSession,
  // DocxDownload (type legacy) ya no se usa — DocSlot wraps SilDownload
} from '../apps/api/src/services/silWebFormsClient.js';

// ─── Config ───────────────────────────────────────────────────────────

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const GCS_BUCKET = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';
if (!SUPA_URL || !SUPA_KEY) { console.error('[bulk] Supabase env missing'); process.exit(1); }
if (!GCP_PROJECT) { console.error('[bulk] GCP_PROJECT_ID missing'); process.exit(1); }
// Auth path: prefer GOOGLE_APPLICATION_CREDENTIALS (a JSON key file
// path) if set; otherwise fall through to Application Default
// Credentials, which works after `gcloud auth application-default
// login`. This lets the user run the bulk locally without managing a
// downloaded SA key file.
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('[bulk] GOOGLE_APPLICATION_CREDENTIALS not set — falling back to ADC (gcloud auth application-default login).');
}

const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const storage = new Storage();

const CONCURRENCY = Number(process.env.SIL_BULK_CONCURRENCY ?? 4);
const PER_WORKER_DELAY_MS = Number(process.env.SIL_BULK_DELAY_MS ?? 800);
const LIMIT = Number(process.env.LIMIT ?? Number.POSITIVE_INFINITY);
const START_FROM = Number(process.env.START_FROM ?? 0);
const NEWEST_FIRST = (process.env.NEWEST_FIRST ?? '0') === '1';
const SESSION_REFRESH_EVERY = 50; // refresh more aggressively — heavier per-exp work
const FORCE = (process.env.FORCE ?? '0') === '1';
const CHUNK_CHARS = 1500;
const VERTEX_CONCURRENCY = 4;
// STOP_BEFORE: detener el walk cuando bajamos por debajo de este id.
// Útil con NEWEST_FIRST=1: arranca en START_FROM (más alto) y para cuando
// llega a este piso. Por ejemplo NEWEST_FIRST=1 START_FROM=25700 STOP_BEFORE=20000
// procesa solo la legislatura activa (post-2020) sin tocar el histórico.
const STOP_BEFORE = process.env.STOP_BEFORE ? Number(process.env.STOP_BEFORE) : null;
// ENABLE_OCR: si true, hace fallback a Cloud Vision Document Text Detection
// cuando el PDF descargado no tiene capa de texto (PDFs escaneados del SIL).
// Costo: ~$1.50 / 1000 páginas. Default true.
const ENABLE_OCR = (process.env.ENABLE_OCR ?? '1') === '1';
// Cap defensivo de tamaño de doc — PDFs muy grandes (escaneados de alta
// resolución, p. ej. 25.591 de 22 MB) consumen heap masivo en pdfjs y
// hacen OOM. Saltamos esos y los registramos en metadata para hacer un
// pass dedicado después con un script más conservador.
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? 15 * 1024 * 1024);
// Forzar GC entre expedientes para combatir leaks de pdfjs/buffers retenidos.
// Requiere arrancar Node con --expose-gc; si no, no-op.
function forceGc(): void {
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch { /* swallow */ }
  }
}

const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);
const vertex = new PredictionServiceClient({ apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com` });
const VERTEX_ENDPOINT = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;

// ─── Helpers ──────────────────────────────────────────────────────────

interface DocSlot {
  tipo: 'texto_base' | 'dictamen' | 'tecnico';
  index: number;            // 0 for texto_base, N for dictamen/tecnico
  download: SilDownload;
}

async function docxToText(bytes: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return (result.value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Extrae texto de un documento según su formato:
 *   - DOCX  → mammoth (rápido, gratis, nativo)
 *   - PDF   → pdfjs primero; si está vacío (PDF escaneado) y OCR está
 *             habilitado, fallback a Cloud Vision Document Text Detection.
 *
 * Devuelve `{ text, ocrUsed }` — ocrUsed se loggea en stats y en
 * sil_documentos.metadata para auditoría de costo.
 */
async function extractTextFromDownload(
  download: SilDownload,
  label: string,
): Promise<{ text: string; ocrUsed: boolean }> {
  if (download.format === 'docx') {
    return { text: await docxToText(download.bytes), ocrUsed: false };
  }
  // PDF — try pdfjs (nativo, gratis) first
  const { pdfToText } = await import('../apps/api/src/services/pdfExtractor.js');
  const nativeText = await pdfToText(download.bytes);
  if (nativeText.length >= 200) {
    // Tiene texto nativo razonable — listo.
    return { text: nativeText, ocrUsed: false };
  }
  if (!ENABLE_OCR) {
    return { text: nativeText, ocrUsed: false }; // dejamos lo que haya
  }
  // PDF escaneado — fallback a OCR.
  const { pdfToTextOCR } = await import('../apps/api/src/services/ocrExtractor.js');
  const ocrText = await pdfToTextOCR(download.bytes, { sourceLabel: label });
  return { text: ocrText, ocrUsed: true };
}

function chunkText(text: string, maxChars: number): Array<{ text: string; index: number }> {
  if (!text) return [];
  // Paragraph-first split, sentence-fallback inside oversize paragraphs.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: Array<{ text: string; index: number }> = [];
  let buf = '';
  let idx = 0;
  const flush = () => {
    const t = buf.trim();
    if (t.length >= 100) chunks.push({ text: t, index: idx++ });
    buf = '';
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      if (buf) flush();
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push({ text: p.slice(i, i + maxChars).trim(), index: idx++ });
      }
      continue;
    }
    if (buf.length + p.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

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
  if (!values || !Array.isArray(values)) throw new Error('vertex: missing values');
  return values;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  await Promise.all(
    Array.from({ length: Math.min(VERTEX_CONCURRENCY, texts.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        let attempt = 0;
        while (true) {
          try { out[item.i] = await embedOne(item.t); break; }
          catch (err) {
            attempt += 1;
            if (attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
    }),
  );
  return out;
}

interface ExpRow {
  id: number;
  numero: string;
  titulo: string | null;
  comision: string | null;
  estado: string | null;
  fecha_presentacion: string | null;
  url_detalle: string;
}

async function fetchTargets(): Promise<ExpRow[]> {
  const out: ExpRow[] = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    // NEWEST_FIRST flips the walk so we cover the active legislative period
    // first. START_FROM still applies but its semantics flip too: in newest-
    // first mode it means "skip ids ABOVE this value" (i.e. resume below a
    // given id). Default ascending mode keeps the original gte semantics.
    let q = supa
      .from('sil_expedientes')
      .select('id, numero, titulo, comision, estado, fecha_presentacion, url_detalle')
      .order('id', { ascending: !NEWEST_FIRST })
      .range(offset, offset + pageSize - 1);
    if (START_FROM > 0) {
      q = NEWEST_FIRST ? q.lte('id', START_FROM) : q.gte('id', START_FROM);
    }
    // STOP_BEFORE: piso para el rango. Con NEWEST_FIRST=1 vamos bajando
    // ids y queremos detenernos cuando crucemos por debajo de este valor.
    // Con orden ascendente, queremos detenernos cuando subamos por encima.
    if (STOP_BEFORE != null) {
      q = NEWEST_FIRST ? q.gte('id', STOP_BEFORE) : q.lte('id', STOP_BEFORE);
    }
    const { data, error } = await q;
    if (error) throw new Error(`fetchTargets: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) out.push(r as ExpRow);
    if (data.length < pageSize) break;
    offset += pageSize;
    if (out.length >= LIMIT) break;
  }
  return out.slice(0, LIMIT === Number.POSITIVE_INFINITY ? out.length : LIMIT);
}

async function alreadyHasDocs(expedienteId: number): Promise<boolean> {
  const { count } = await supa
    .from('sil_documentos')
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId);
  return (count ?? 0) > 0;
}

interface Stats {
  expedientes_processed: number;
  docs_downloaded: number;
  docs_embedded: number;
  bytes_in: number;
  total_chunks: number;
  errors: number;
  skipped: number;
  ocr_used: number;
}

async function processExpediente(exp: ExpRow, stats: Stats): Promise<void> {
  if (!FORCE && (await alreadyHasDocs(exp.id))) {
    stats.skipped += 1;
    // Heartbeat de skip cada 100 — confirma que el loop no está stuck en
    // skips silenciosos. No afecta perf (solo loggea).
    if (stats.skipped % 100 === 0) {
      console.log(`[bulk] skipped=${stats.skipped} (sample: ${exp.numero} ya tiene docs)`);
    }
    return;
  }

  let session: WebFormsSession;
  try { session = await createSession(); }
  catch (err) {
    stats.errors += 1;
    console.warn(`[exp ${exp.numero}] session bootstrap failed: ${(err as Error).message}`);
    return;
  }

  try {
    const r1 = await searchByNumber(session, exp.id);
    session = r1.session;
    if (!r1.detail) { stats.skipped += 1; return; }

    const r2 = await selectExpedienteDetail(session, exp.id);
    session = r2.session;
    const numDictamenes = countGridRows(session.lastHtml, 'grvDictamenes');
    const numTecnicos = countGridRows(session.lastHtml, 'grvTecnicos');

    const slots: DocSlot[] = [];

    // Texto base
    {
      const r = await downloadTextoBase(session, exp.id);
      session = r.session;
      if (r.download) slots.push({ tipo: 'texto_base', index: 0, download: r.download });
    }

    // Dictámenes — re-search/select between downloads to keep state fresh
    // (the server sometimes invalidates VIEWSTATE after a download).
    for (let i = 0; i < numDictamenes; i++) {
      try {
        const rr1 = await searchByNumber(session, exp.id);
        session = rr1.session;
        const rr2 = await selectExpedienteDetail(session, exp.id);
        session = rr2.session;
        const r = await downloadDictamen(session, exp.id, i);
        session = r.session;
        if (r.download) slots.push({ tipo: 'dictamen', index: i, download: r.download });
      } catch (err) {
        console.warn(`[exp ${exp.numero}] dictamen[${i}] failed: ${(err as Error).message}`);
      }
    }

    // Informes técnicos
    for (let i = 0; i < numTecnicos; i++) {
      try {
        const rr1 = await searchByNumber(session, exp.id);
        session = rr1.session;
        const rr2 = await selectExpedienteDetail(session, exp.id);
        session = rr2.session;
        const r = await downloadInformeTecnico(session, exp.id, i);
        session = r.session;
        if (r.download) slots.push({ tipo: 'tecnico', index: i, download: r.download });
      } catch (err) {
        console.warn(`[exp ${exp.numero}] tecnico[${i}] failed: ${(err as Error).message}`);
      }
    }

    if (slots.length === 0) { stats.expedientes_processed += 1; return; }

    // Persist each slot: GCS upload → text extraction (DOCX/PDF/OCR) →
    // embed → legislative_chunks → sil_documentos.
    const docRows: Array<Record<string, unknown>> = [];
    const chunkRowsBatch: Array<Record<string, unknown>> = [];
    for (const slot of slots) {
      const ext = slot.download.format === 'docx' ? 'docx' : 'pdf';
      const fallbackName = `expediente_${exp.id}_${slot.tipo}_${slot.index}.${ext}`;
      // Si el filename del server termina en .docx pero el formato real es PDF
      // (el SIL etiqueta mal), normalizamos a la extensión correcta para evitar
      // confusión downstream.
      const rawName = slot.download.filename ?? fallbackName;
      const filename = rawName.endsWith(`.${ext}`)
        ? rawName
        : `${rawName.replace(/\.(docx?|pdf)$/i, '')}.${ext}`;
      const safeName = filename.replace(/[^\w.\-]+/g, '_');
      const gcsPath = `expedientes/${exp.id}/${slot.tipo}_${slot.index}_${safeName}`;

      // GUARD: PDFs muy grandes matan el heap durante el parse/OCR.
      // Subimos a GCS para conservar el archivo (signed URL sigue
      // siendo descargable desde la UI), pero saltamos el parse + chunks
      // + embeddings. Quedan en sil_documentos con status='parsed' y
      // metadata.oversized=true para un pass dedicado posterior.
      const oversized = slot.download.bytes.length > MAX_DOC_BYTES;

      try {
        await storage.bucket(GCS_BUCKET).file(gcsPath).save(slot.download.bytes, {
          contentType: slot.download.mimeType,
          metadata: { metadata: { sil_expediente_id: String(exp.id), sil_doc_kind: slot.tipo, sil_doc_index: String(slot.index), original_filename: filename, oversized: oversized ? 'true' : 'false' } },
        });
        stats.docs_downloaded += 1;
        stats.bytes_in += slot.download.bytes.length;
      } catch (err) {
        console.warn(`[exp ${exp.numero}] gcs upload failed: ${(err as Error).message}`);
        stats.errors += 1;
        continue;
      }

      let text = '';
      let ocrUsed = false;
      if (oversized) {
        console.warn(`[exp ${exp.numero}] slot ${slot.tipo}[${slot.index}] OVERSIZED ${(slot.download.bytes.length / 1024 / 1024).toFixed(1)} MB — skip parse/embed`);
      } else {
        try {
          const extracted = await extractTextFromDownload(slot.download, `${exp.numero}:${slot.tipo}`);
          text = extracted.text;
          ocrUsed = extracted.ocrUsed;
          if (ocrUsed) stats.ocr_used += 1;
        } catch (err) {
          console.warn(`[exp ${exp.numero}] ${slot.download.format} text extraction failed: ${(err as Error).message}`);
          stats.errors += 1;
        }
      }

      // ASAP: liberar los bytes raw del PDF/DOCX. El upload + extract ya
      // terminaron. Sin esto los buffers se retienen hasta que el GC
      // pasa, y con PDFs de 5-22 MB × varios slots se acumula rápido.
      (slot as { download: { bytes: Buffer | null } }).download.bytes = null as unknown as Buffer;

      // Insert sil_documentos row first (so we have an id for back-reference).
      const docRow = {
        expediente_id: exp.id,
        tipo: slot.tipo === 'texto_base' ? 'texto_base'
            : slot.tipo === 'dictamen' ? 'dictamen_mayoria'   // best-effort; mayoría/minoría discriminator not in HTML
            : 'otro',
        titulo: filename,
        fecha: null,
        source_url: `${exp.url_detalle}#${slot.tipo}-${slot.index}`,
        gcs_path: `gs://${GCS_BUCKET}/${gcsPath}`,
        mime_type: slot.download.mimeType,
        text_extracted: text.slice(0, 500_000),
        text_chars: text.length,
        status: text.length >= 50 ? 'embedded' : 'parsed',
        metadata: {
          ...(ocrUsed ? { ocr: 'cloud_vision_documents' } : {}),
          ...(oversized ? { oversized: true } : {}),
        },
      };
      docRows.push(docRow);

      if (text.length < 50) continue;
      const chunks = chunkText(text, CHUNK_CHARS);
      if (chunks.length === 0) continue;
      const embeddings = await embedBatch(chunks.map((c) => c.text));
      stats.total_chunks += chunks.length;

      const sourceType = slot.tipo === 'texto_base' ? 'sil_expediente'
                        : slot.tipo === 'dictamen' ? 'sil_dictamen'
                        : 'sil_dictamen'; // técnico → sil_dictamen flavor (informe técnico)
      const sourceRef = `Exp. ${exp.numero} — ${slot.tipo}${slot.index > 0 ? ` ${slot.index}` : ''}`;
      for (let ci = 0; ci < chunks.length; ci++) {
        chunkRowsBatch.push({
          session_id: null,
          source_type: sourceType,
          source_ref: sourceRef,
          chunk_index: chunks[ci].index,
          content: chunks[ci].text,
          embedding: embeddings[ci] as unknown as string,
          metadata: {
            sil_expediente_numero: exp.numero,
            sil_expediente_id: exp.id,
            sil_doc_kind: slot.tipo,
            sil_doc_index: slot.index,
            sil_doc_filename: filename,
            sil_doc_gcs_path: `gs://${GCS_BUCKET}/${gcsPath}`,
            comision: exp.comision,
            estado: exp.estado,
            fecha_presentacion: exp.fecha_presentacion,
          },
        });
      }
      stats.docs_embedded += 1;
    }

    if (docRows.length > 0) {
      const { error } = await supa.from('sil_documentos').insert(docRows);
      if (error) {
        console.warn(`[exp ${exp.numero}] sil_documentos insert failed: ${error.message}`);
        stats.errors += docRows.length;
      }
    }
    if (chunkRowsBatch.length > 0) {
      // Insert in slices of 30 — 3072d vectors are big.
      for (let i = 0; i < chunkRowsBatch.length; i += 30) {
        const slice = chunkRowsBatch.slice(i, i + 30);
        const { error } = await supa.from('legislative_chunks').insert(slice);
        if (error) {
          console.warn(`[exp ${exp.numero}] chunks insert failed: ${error.message}`);
          stats.errors += slice.length;
        }
      }
    }

    stats.expedientes_processed += 1;
    if (stats.expedientes_processed % 10 === 0) {
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[bulk] ${stats.expedientes_processed} exp · ${stats.docs_downloaded} docs · ${stats.total_chunks} chunks · ${Math.round(stats.bytes_in / 1024 / 1024)}MB io · heap=${heapMB}MB · ${stats.errors} errs · skipped=${stats.skipped}`);
    }
    // Forzar GC cada N expedientes para combatir leaks de pdfjs/buffers
    // retenidos en cierres. Sin esto el heap crece linealmente hasta OOM.
    if (stats.expedientes_processed % 10 === 0) forceGc();
  } catch (err) {
    stats.errors += 1;
    console.warn(`[exp ${exp.numero}] fatal: ${(err as Error).message}`);
  }
}

// ─── Driver ───────────────────────────────────────────────────────────

async function main() {
  console.log(`[bulk] start. concurrency=${CONCURRENCY} delay=${PER_WORKER_DELAY_MS}ms limit=${LIMIT === Number.POSITIVE_INFINITY ? '∞' : LIMIT} start_from=${START_FROM} force=${FORCE} embed=${EMBED_MODEL}/${EMBED_DIM}d bucket=${GCS_BUCKET}`);
  const targets = await fetchTargets();
  console.log(`[bulk] targets: ${targets.length} expedientes`);
  if (targets.length === 0) { console.log('[bulk] nothing to do'); return; }

  const { data: crawlRow } = await supa
    .from('sil_crawl_runs')
    .insert({
      source: 'webforms_consultassil3',
      list_or_target: `download-bulk:${targets.length} ids`,
    })
    .select('id')
    .single();
  const crawlId = crawlRow?.id ?? null;

  const stats: Stats = {
    expedientes_processed: 0,
    docs_downloaded: 0,
    docs_embedded: 0,
    bytes_in: 0,
    total_chunks: 0,
    errors: 0,
    skipped: 0,
    ocr_used: 0,
  };

  const queue = [...targets];
  const startTs = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const exp = queue.shift();
        if (!exp) return;
        await processExpediente(exp, stats);
        await new Promise((r) => setTimeout(r, PER_WORKER_DELAY_MS));
      }
    }),
  );
  const minutes = Math.round((Date.now() - startTs) / 60_000);

  if (crawlId) {
    await supa
      .from('sil_crawl_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in: targets.length,
        rows_out: stats.docs_embedded,
        errors: stats.errors,
        status: stats.errors === 0 ? 'success' : 'partial',
        detail: stats,
      })
      .eq('id', crawlId);
  }

  console.log(`\n[bulk] DONE in ${minutes} min — exp=${stats.expedientes_processed} docs=${stats.docs_downloaded} embedded=${stats.docs_embedded} chunks=${stats.total_chunks} bytes=${Math.round(stats.bytes_in / 1024 / 1024)}MB errors=${stats.errors} skipped=${stats.skipped}`);
}

main().catch((err) => { console.error('[bulk] fatal', err); process.exit(1); });
