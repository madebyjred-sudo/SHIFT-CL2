/**
 * download-sil-pdf-only.ts — variante del bulk diseñada SOLO para cerrar el
 * gap de cobertura SIL del 12 de mayo 2026. NO intenta DOCX (que es el path
 * de bug en el bulk regular). Va directo a btnDescargaPDF tras
 * search+select, que es el único path estable observado en el diag raw.
 *
 * Sacrificio: pierde la mejor calidad de extracción DOCX→mammoth a favor
 * de PDF→pdfjs/OCR. Para expedientes nuevos donde NO hay DOCX en el SIL
 * de todas formas, no hay diferencia. Para los que SÍ tienen DOCX, vamos
 * a procesar el PDF — texto un poco más sucio pero útil.
 *
 * Decisión justificada en el diagnóstico 2026-05-12: el POST de
 * btnDescargaTexto en expedientes sin DOCX deja el server en un estado
 * raro que rompe la sesión Y los siguientes expedientes. Evitando ese
 * POST entirely, el flujo se estabiliza.
 *
 * Idéntico al bulk regular en todo lo demás: GCS upload, embed, chunks,
 * sil_documentos insert.
 *
 * Uso:
 *   NEWEST_FIRST=1 START_FROM=23999 STOP_BEFORE=18000 FORCE=0 \
 *   ENABLE_OCR=1 SIL_BULK_CONCURRENCY=1 SIL_BULK_DELAY_MS=1500 \
 *   MAX_DOC_BYTES=15728640 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   node --max-old-space-size=12288 --expose-gc --env-file=.env.local \
 *     --import tsx scripts/download-sil-pdf-only.ts
 */
import { createClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  downloadTextoBasePDF,
  type SilDownload,
  type WebFormsSession,
} from '../apps/api/src/services/silWebFormsClient.js';
import { pdfToText } from '../apps/api/src/services/pdfExtractor.js';
import { pdfToTextOCR } from '../apps/api/src/services/ocrExtractor.js';

const NEWEST_FIRST = process.env.NEWEST_FIRST === '1';
const START_FROM = Number(process.env.START_FROM ?? 0);
const STOP_BEFORE = process.env.STOP_BEFORE ? Number(process.env.STOP_BEFORE) : null;
const FORCE = process.env.FORCE === '1';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Number.POSITIVE_INFINITY;
const ENABLE_OCR = process.env.ENABLE_OCR !== '0';
const CONCURRENCY = Number(process.env.SIL_BULK_CONCURRENCY ?? 1);
const DELAY_MS = Number(process.env.SIL_BULK_DELAY_MS ?? 1500);
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? 15728640);
const GCS_BUCKET = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const gcs = new Storage();
const bucket = gcs.bucket(GCS_BUCKET);

interface ExpRow {
  id: number;
  numero: string;
  titulo: string | null;
}

interface Stats {
  expedientes_attempted: number;
  pdfs_downloaded: number;
  text_extracted: number;
  ocr_used: number;
  errors: number;
  skipped: number;
  oversized: number;
}

function forceGc() {
  if (typeof global.gc === 'function') global.gc();
}

async function alreadyHasDocs(id: number): Promise<boolean> {
  const { count } = await supa
    .from('sil_documentos')
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', id);
  return (count ?? 0) > 0;
}

async function fetchTargets(): Promise<ExpRow[]> {
  const out: ExpRow[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    let q = supa
      .from('sil_expedientes')
      .select('id, numero, titulo')
      .order('id', { ascending: !NEWEST_FIRST })
      .range(offset, offset + PAGE - 1);
    if (START_FROM > 0) {
      q = NEWEST_FIRST ? q.lte('id', START_FROM) : q.gte('id', START_FROM);
    }
    if (STOP_BEFORE != null) {
      q = NEWEST_FIRST ? q.gte('id', STOP_BEFORE) : q.lte('id', STOP_BEFORE);
    }
    const { data, error } = await q;
    if (error) throw new Error(`fetchTargets: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as ExpRow[]));
    if (data.length < PAGE) break;
    offset += PAGE;
    if (out.length >= LIMIT) break;
  }
  return out.slice(0, LIMIT === Number.POSITIVE_INFINITY ? out.length : LIMIT);
}

async function uploadToGcs(
  bytes: Buffer,
  expedienteNum: number,
  format: 'pdf',
): Promise<{ gcsPath: string; sha256: string }> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const path = `sil/texto_base/${expedienteNum}_${sha.slice(0, 12)}.${format}`;
  await bucket.file(path).save(bytes, {
    resumable: false,
    metadata: { contentType: 'application/pdf', metadata: { expediente: String(expedienteNum), source: 'pdf-only' } },
  });
  return { gcsPath: `gs://${GCS_BUCKET}/${path}`, sha256: sha };
}

async function extractText(bytes: Buffer, num: number): Promise<{ text: string; ocrUsed: boolean }> {
  // Native PDF first
  let text = '';
  try { text = await pdfToText(bytes); } catch (e) { /* fall through */ }
  if (text.length >= 200) return { text, ocrUsed: false };
  // OCR fallback
  if (!ENABLE_OCR) return { text, ocrUsed: false };
  try {
    const ocrText = await pdfToTextOCR(bytes, { sourceLabel: `pdf-only:${num}` });
    return { text: ocrText, ocrUsed: true };
  } catch (e) {
    console.warn(`[exp ${num}] ocr error: ${(e as Error).message}`);
    return { text, ocrUsed: false };
  }
}

async function processOne(exp: ExpRow, stats: Stats): Promise<void> {
  if (!FORCE && (await alreadyHasDocs(exp.id))) {
    stats.skipped += 1;
    if (stats.skipped % 100 === 0) {
      console.log(`[pdf-only] skipped=${stats.skipped} (sample: ${exp.numero} ya tiene docs)`);
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

  let download: SilDownload | null = null;
  try {
    const r1 = await searchByNumber(session, exp.id);
    if (!r1.detail) { stats.skipped += 1; return; }
    session = r1.session;
    const r2 = await selectExpedienteDetail(session, exp.id);
    session = r2.session;
    const r3 = await downloadTextoBasePDF(session, exp.id);
    if (r3.download) download = r3.download;
  } catch (err) {
    stats.errors += 1;
    console.warn(`[exp ${exp.numero}] fatal: ${(err as Error).message}`);
    return;
  }

  if (!download) {
    stats.skipped += 1;
    return;
  }
  if (download.format !== 'pdf') {
    // edge: el SIL ocasionalmente sirve DOCX cuando se pidió PDF
    console.warn(`[exp ${exp.numero}] inesperado: format=${download.format}, skip`);
    return;
  }

  const bytes = download.bytes;
  const oversized = bytes.length > MAX_DOC_BYTES;

  let gcsPath: string, sha256: string;
  try {
    ({ gcsPath, sha256 } = await uploadToGcs(bytes, exp.id, 'pdf'));
  } catch (err) {
    stats.errors += 1;
    console.warn(`[exp ${exp.numero}] gcs upload failed: ${(err as Error).message}`);
    return;
  }

  stats.pdfs_downloaded += 1;

  let text = '';
  let ocrUsed = false;
  if (!oversized) {
    const r = await extractText(bytes, exp.id);
    text = r.text;
    ocrUsed = r.ocrUsed;
    if (text.length >= 200) stats.text_extracted += 1;
    if (ocrUsed) stats.ocr_used += 1;
  } else {
    stats.oversized += 1;
    console.log(`[exp ${exp.numero}] OVERSIZED ${(bytes.length / 1024 / 1024).toFixed(1)} MB — uploaded but no parse/embed`);
  }

  // Insert sil_documentos siguiendo el schema canónico (mismo shape que el
  // bulk regular). NO incluimos `bytes` ni `sha256` ni `filename` — el schema
  // no los tiene; el sha vive en gcs_path (que incluye un hash truncado).
  const docRow = {
    expediente_id: exp.id,
    tipo: 'texto_base',
    titulo: `expediente_${exp.numero}_texto.pdf`,
    fecha: null,
    source_url: `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${exp.id}#texto_base-0`,
    gcs_path: gcsPath,
    mime_type: 'application/pdf',
    text_extracted: text.slice(0, 500_000),
    text_chars: text.length,
    status: text.length >= 50 ? 'parsed' : 'parsed',
    metadata: {
      pdf_only_bulk: true,
      pdf_only_at: new Date().toISOString(),
      sha256,
      bytes_total: bytes.length,
      ocr: ocrUsed ? 'cloud_vision_documents' : null,
      oversized: oversized || null,
    },
  };
  const { error: insErr } = await supa.from('sil_documentos').insert(docRow);
  if (insErr) {
    stats.errors += 1;
    console.warn(`[exp ${exp.numero}] insert failed: ${insErr.message}`);
    return;
  }

  stats.expedientes_attempted += 1;
  if (stats.expedientes_attempted % 10 === 0) {
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(
      `[pdf-only] ${stats.expedientes_attempted} exp · pdfs=${stats.pdfs_downloaded} · text_ok=${stats.text_extracted}` +
      ` · ocr=${stats.ocr_used} · oversized=${stats.oversized} · skipped=${stats.skipped}` +
      ` · errs=${stats.errors} · heap=${heapMB}MB`,
    );
  }
  if (stats.expedientes_attempted % 10 === 0) forceGc();
}

async function main() {
  console.log(`[pdf-only] start. concurrency=${CONCURRENCY} delay=${DELAY_MS}ms limit=${LIMIT === Number.POSITIVE_INFINITY ? '∞' : LIMIT}`);
  const targets = await fetchTargets();
  console.log(`[pdf-only] targets: ${targets.length} expedientes (newest_first=${NEWEST_FIRST}, start_from=${START_FROM}, stop_before=${STOP_BEFORE})`);
  if (!targets.length) return;

  const stats: Stats = {
    expedientes_attempted: 0, pdfs_downloaded: 0, text_extracted: 0,
    ocr_used: 0, errors: 0, skipped: 0, oversized: 0,
  };

  const queue = [...targets];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const exp = queue.shift();
        if (!exp) return;
        await processOne(exp, stats);
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }),
  );
  const mins = Math.round((Date.now() - t0) / 60_000);
  console.log(
    `\n[pdf-only] DONE in ${mins} min — attempted=${stats.expedientes_attempted} pdfs=${stats.pdfs_downloaded}` +
    ` text_extracted=${stats.text_extracted} ocr=${stats.ocr_used} oversized=${stats.oversized}` +
    ` skipped=${stats.skipped} errors=${stats.errors}`,
  );
}

main().catch((err) => { console.error('[pdf-only] fatal', err); process.exit(1); });
