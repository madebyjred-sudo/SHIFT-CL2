/**
 * silDownloadDocs — descarga documentos PDF del SIL para expedientes que
 *   aún no tienen docs en `sil_documentos`.
 *
 * Diseñado para correr como Cloud Scheduler job (vía endpoint en centinela.ts).
 * Procesa SOLO expedientes sin docs existentes (no FORCE).
 *
 * Pipeline:
 *   1. Listar expedientes sin docs en sil_documentos (más recientes primero).
 *   2. Por cada uno: buscar en SIL WebForms → descargar PDF → upload GCS.
 *   3. Extraer texto (pdfjs nativo; OCR fallback opcional).
 *   4. Insertar fila en sil_documentos con gcs_path y text_extracted.
 *
 * Parámetros (vía body del endpoint):
 *   limit        número máximo de expedientes a procesar (default 30).
 *   maxDocBytes  tamaño máximo de PDF en bytes (default 15MB).
 *   enableOcr    boolean (default true).
 *   concurrency  paralelismo (default 2).
 *   delayMs      delay entre expedientes (default 1500ms).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  downloadTextoBasePDF,
  type SilDownload,
  type WebFormsSession,
} from '../services/silWebFormsClient.js';
import { pdfToText } from '../services/pdfExtractor.js';
import { pdfToTextOCR } from '../services/ocrExtractor.js';
import { logger } from '../services/logger.js';

export interface SilDownloadResult {
  started_at: string;
  finished_at: string;
  targets_found: number;
  expedientes_attempted: number;
  pdfs_downloaded: number;
  text_extracted: number;
  ocr_used: number;
  errors: number;
  skipped: number;
  oversized: number;
}

interface ExpRow {
  id: number;
  numero: string;
  titulo: string | null;
}

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('silDownloadDocs: missing Supabase creds');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getBucket() {
  const bucketName = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';
  return new Storage().bucket(bucketName);
}

async function alreadyHasDocs(s: SupabaseClient, id: number): Promise<boolean> {
  const { count } = await s
    .from('sil_documentos')
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', id);
  return (count ?? 0) > 0;
}

async function fetchTargetsWithoutDocs(s: SupabaseClient, limit: number): Promise<ExpRow[]> {
  const out: ExpRow[] = [];
  let offset = 0;
  const PAGE = 200;
  while (out.length < limit) {
    const { data, error } = await s
      .from('sil_expedientes')
      .select('id, numero, titulo')
      .order('id', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetchTargets: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as ExpRow[]) {
      if (out.length >= limit) break;
      out.push(row);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

async function uploadToGcs(
  bucket: ReturnType<typeof getBucket>,
  bytes: Buffer,
  expedienteNum: number,
): Promise<{ gcsPath: string; sha256: string }> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const path = `sil/texto_base/${expedienteNum}_${sha.slice(0, 12)}.pdf`;
  await bucket.file(path).save(bytes, {
    resumable: false,
    metadata: {
      contentType: 'application/pdf',
      metadata: { expediente: String(expedienteNum), source: 'silDownloadDocs' },
    },
  });
  const gcsPath = `gs://${bucket.name}/${path}`;
  return { gcsPath, sha256: sha };
}

async function extractText(
  bytes: Buffer,
  num: number,
  enableOcr: boolean,
): Promise<{ text: string; ocrUsed: boolean }> {
  let text = '';
  try {
    text = await pdfToText(bytes);
  } catch {
    /* fall through */
  }
  if (text.length >= 200) return { text, ocrUsed: false };
  if (!enableOcr) return { text, ocrUsed: false };
  try {
    const ocrText = await pdfToTextOCR(bytes, { sourceLabel: `silDownloadDocs:${num}` });
    return { text: ocrText, ocrUsed: true };
  } catch (e) {
    logger.warn('sil_download_ocr_failed', { expediente: num, error: (e as Error).message });
    return { text, ocrUsed: false };
  }
}

async function processOne(
  s: SupabaseClient,
  bucket: ReturnType<typeof getBucket>,
  exp: ExpRow,
  opts: { enableOcr: boolean; maxDocBytes: number },
  stats: { pdfs_downloaded: number; text_extracted: number; ocr_used: number; errors: number; skipped: number; oversized: number },
): Promise<void> {
  if (await alreadyHasDocs(s, exp.id)) {
    stats.skipped += 1;
    return;
  }

  let session: WebFormsSession;
  try {
    session = await createSession();
  } catch (err) {
    stats.errors += 1;
    logger.warn('sil_download_session_failed', { expediente: exp.numero, error: (err as Error).message });
    return;
  }

  let download: SilDownload | null = null;
  try {
    const r1 = await searchByNumber(session, exp.id);
    if (!r1.detail) {
      stats.skipped += 1;
      return;
    }
    session = r1.session;
    const r2 = await selectExpedienteDetail(session, exp.id);
    session = r2.session;
    const r3 = await downloadTextoBasePDF(session, exp.id);
    if (r3.download) download = r3.download;
  } catch (err) {
    stats.errors += 1;
    logger.warn('sil_download_fetch_failed', { expediente: exp.numero, error: (err as Error).message });
    return;
  }

  if (!download) {
    stats.skipped += 1;
    return;
  }
  if (download.format !== 'pdf') {
    logger.warn('sil_download_unexpected_format', { expediente: exp.numero, format: download.format });
    stats.skipped += 1;
    return;
  }

  const bytes = download.bytes;
  const oversized = bytes.length > opts.maxDocBytes;

  let gcsPath: string;
  let sha256: string;
  try {
    const up = await uploadToGcs(bucket, bytes, exp.id);
    gcsPath = up.gcsPath;
    sha256 = up.sha256;
  } catch (err) {
    stats.errors += 1;
    logger.warn('sil_download_gcs_failed', { expediente: exp.numero, error: (err as Error).message });
    return;
  }

  stats.pdfs_downloaded += 1;

  let text = '';
  let ocrUsed = false;
  if (!oversized) {
    const r = await extractText(bytes, exp.id, opts.enableOcr);
    text = r.text;
    ocrUsed = r.ocrUsed;
    if (text.length >= 200) stats.text_extracted += 1;
    if (ocrUsed) stats.ocr_used += 1;
  } else {
    stats.oversized += 1;
    logger.info('sil_download_oversized', {
      expediente: exp.numero,
      mb: (bytes.length / 1024 / 1024).toFixed(1),
    });
  }

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
    status: 'parsed',
    metadata: {
      sil_download_docs: true,
      downloaded_at: new Date().toISOString(),
      sha256,
      bytes_total: bytes.length,
      ocr: ocrUsed ? 'cloud_vision_documents' : null,
      oversized: oversized || null,
    },
  };

  const { error: insErr } = await s.from('sil_documentos').insert(docRow);
  if (insErr) {
    stats.errors += 1;
    logger.warn('sil_download_insert_failed', { expediente: exp.numero, error: insErr.message });
    return;
  }
}

export async function runSilDownloadDocs(opts: {
  limit?: number;
  maxDocBytes?: number;
  enableOcr?: boolean;
  concurrency?: number;
  delayMs?: number;
} = {}): Promise<SilDownloadResult> {
  const startedAt = new Date().toISOString();
  const s = supa();
  const bucket = getBucket();

  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const maxDocBytes = opts.maxDocBytes ?? 15_728_640;
  const enableOcr = opts.enableOcr !== false;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 4);
  const delayMs = Math.max(opts.delayMs ?? 1500, 500);

  logger.info('sil_download_start', { limit, maxDocBytes, enableOcr, concurrency, delayMs });

  // First, get targets; then filter those without docs
  const candidates = await fetchTargetsWithoutDocs(s, limit * 3);
  const targets: ExpRow[] = [];
  for (const c of candidates) {
    if (targets.length >= limit) break;
    if (!(await alreadyHasDocs(s, c.id))) {
      targets.push(c);
    }
  }

  logger.info('sil_download_targets', { found: targets.length, candidates: candidates.length });

  const stats = {
    pdfs_downloaded: 0,
    text_extracted: 0,
    ocr_used: 0,
    errors: 0,
    skipped: 0,
    oversized: 0,
  };

  const queue = [...targets];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const exp = queue.shift();
        if (!exp) return;
        await processOne(s, bucket, exp, { enableOcr, maxDocBytes }, stats);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }),
  );

  const result: SilDownloadResult = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    targets_found: targets.length,
    expedientes_attempted: targets.length - stats.skipped,
    pdfs_downloaded: stats.pdfs_downloaded,
    text_extracted: stats.text_extracted,
    ocr_used: stats.ocr_used,
    errors: stats.errors,
    skipped: stats.skipped,
    oversized: stats.oversized,
  };

  logger.info('sil_download_complete', { ...result, duration_ms: Date.now() - t0 });
  return result;
}
