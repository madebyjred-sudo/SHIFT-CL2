/**
 * processOrdenesDia — Pedido 06 del cliente CL2.
 *
 * Procesa los PDFs de órdenes del día que el crawler de SharePoint ya
 * recolectó (sil_sharepoint_raw, list_id='Órdenes del día'), extrae los
 * expedientes mencionados, y los persiste en agenda_legislativa para que
 * aparezcan en el dashboard de cada expediente como "Próximas sesiones".
 *
 * Source de los PDFs: SharePoint Asamblea (~8,098 archivos histórico
 * 2010-hoy, dataset estable). FileLeafRef tiene el pattern
 * `{periodo}-{COMISION}-SESION-{N}.pdf` (ej. "2024-2025-AMBIENTE-SESION-12.pdf").
 *
 * PIPELINE por PDF:
 *   1. Parsear nombre del archivo → { periodo, comision, sesion_num }
 *   2. Descargar PDF (cached en GCS si ya estaba)
 *   3. pdf-parse → texto plano
 *   4. Regex /\b\d{1,2}\.\d{3}\b/g → lista de expedientes mencionados
 *   5. Cross-reference contra sil_expedientes → solo expedientes existentes
 *   6. UPSERT en agenda_legislativa con dedup key
 *      (expediente_numero, comision, fecha)
 *   7. Marcar row del raw con processed_at en metadata
 *
 * IDEMPOTENCIA:
 *   Cada item raw se procesa 1 vez. Re-correr salta los ya procesados.
 *   Los upserts en agenda_legislativa usan dedup_key implícito por
 *   (expediente_numero, comision, fecha) — re-correr no duplica filas.
 *
 * ERROR HANDLING:
 *   Un PDF que falla parse no aborta el batch. Se loggea y se marca
 *   parser_status='failed' en el raw. El job retorna contadores.
 *
 * Trigger: POST /api/internal/centinela/process-ordenes-dia
 * Schedule: Cloud Scheduler diario 5:30am CR
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

interface ProcessResult {
  examined: number;
  processed: number;
  expedientes_inserted: number;
  errors: number;
  skipped_already_processed: number;
  duration_ms: number;
}

interface SharepointRawRow {
  list_id: string;
  item_id: string;
  payload: {
    FileRef?: string;
    FileLeafRef?: string;
    Modified?: string;
    [k: string]: unknown;
  } | null;
  scraped_at: string;
  processed_at?: string | null;
  processor_status?: string | null;
}

interface ParsedOrdenDiaFilename {
  periodo: string;            // "2024-2025"
  comision: string;            // "AMBIENTE" (normalized)
  sesion_num: number | null;   // 12
}

const PDF_FETCH_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

// Pedido 16i / agendaScrape — mismo base URL del SharePoint Asamblea.
// Cada segmento del path se encodea (espacios, acentos) porque el IIS del
// SharePoint devuelve 400/404 con URLs crudas.
function downloadUrl(fileRef: string): string {
  const base = process.env.SIL_SHAREPOINT_BASE?.replace('/glcp', '') ?? 'https://www.asamblea.go.cr';
  const encodePath = (p: string) =>
    p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return fileRef.startsWith('http') ? fileRef : `${base}${encodePath(fileRef)}`;
}

/**
 * Parsea el nombre del archivo para extraer periodo + comisión + sesión.
 * Acepta varios patrones que aparecen en la lista histórica:
 *   - "2024-2025-AMBIENTE-SESION-12.pdf"
 *   - "2024-2025_HACENDARIOS_SESION_3.pdf"
 *   - "PLENARIO 2023-10-15.pdf"  (sin sesion num, con fecha)
 */
export function parseOrdenDiaFilename(name: string): ParsedOrdenDiaFilename | null {
  // Normalizar: quitar extensión, reemplazar _ y espacios por -
  const clean = name.replace(/\.pdf$/i, '').replace(/[_\s]+/g, '-').toUpperCase();

  // Pattern A: PERIODO-COMISION-SESION-N
  const m = clean.match(/^(\d{4}-\d{4})-([A-ZÁÉÍÓÚÑÀ-ſ]+)-SESI[ÓO]N-(\d+)$/);
  if (m) {
    return {
      periodo: m[1],
      comision: m[2],
      sesion_num: Number(m[3]),
    };
  }

  // Pattern B: COMISION SESION-N
  const m2 = clean.match(/^([A-ZÁÉÍÓÚÑÀ-ſ]+)-SESI[ÓO]N-(\d+)$/);
  if (m2) {
    return { periodo: '', comision: m2[1], sesion_num: Number(m2[2]) };
  }

  return null;
}

/**
 * Extrae expedientes del texto plano. La Asamblea usa el formato "DD.DDD"
 * con punto entre el dígito de la legislatura y los 3 últimos. Filtramos
 * fuera años (no tienen punto) y montos (tienen separadores de miles
 * pero también de decimal).
 */
export function extractExpedientesFromText(text: string): string[] {
  const matches = text.match(/\b\d{1,2}\.\d{3}\b/g) ?? [];
  // Filtros básicos:
  //   - Rango razonable: expedientes en CR van de 0.001 hasta ~26.000 al 2026
  //   - Excluir años (1999, 2024) — no llevan punto pero por seguridad
  const valid = matches.filter((m) => {
    const n = Number(m.replace('.', ''));
    return n >= 1000 && n <= 30000; // ajustar conforme suba el contador real
  });
  return Array.from(new Set(valid)); // distinct
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  // Retry x3 con User-Agent (mismo patrón que decretoIngestor) — el IIS del
  // SharePoint Asamblea rechaza requests sin User-Agent identificable.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/pdf, application/octet-stream, */*',
          'User-Agent': 'Mozilla/5.0 (compatible; CL2-Ingest/1.0; +https://agentescl2.com)',
        },
      });
      if (!res.ok) {
        if (attempt === MAX_ATTEMPTS) {
          logger.warn('process_ordenes_dia_pdf_http_failed', { url, status: res.status });
        }
        if (res.status < 500) return null; // 4xx no se reintenta
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > MAX_PDF_SIZE_BYTES) {
        logger.warn('process_ordenes_dia_pdf_too_large', { url, size: contentLength });
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PDF_SIZE_BYTES) {
        logger.warn('process_ordenes_dia_pdf_too_large_after_read', { url, size: buf.length });
        return null;
      }
      return buf;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } })?.cause;
      if (attempt === MAX_ATTEMPTS) {
        logger.warn('process_ordenes_dia_pdf_fetch_failed', {
          url,
          attempt,
          error: (err as Error).message,
          cause_code: cause?.code,
        });
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

// pdf-parse v2: PDFParse es una clase, no default function. Mismo patrón
// que routes/ingest.ts. Cache la clase entre llamadas.
let _PDFParse: any | null = null;
async function getPDFParse(): Promise<any> {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = (mod as any).PDFParse ?? (mod as any).default?.PDFParse;
  if (!_PDFParse) throw new Error('pdf-parse: PDFParse class not found');
  return _PDFParse;
}

async function parsePdfText(buf: Buffer): Promise<string | null> {
  try {
    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: buf });
    const parsed = await parser.getText();
    // pdf-parse v2 returns { text, numpages, info, metadata }
    return parsed.text ?? '';
  } catch (err) {
    logger.warn('process_ordenes_dia_pdf_parse_failed', {
      error: (err as Error).message,
    });
    return null;
  }
}

function inferFechaFromModified(modified: string | undefined): string | null {
  if (!modified) return null;
  const m = modified.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Función pública del job.
 */
export async function processOrdenesDia(opts: { limit: number }): Promise<ProcessResult> {
  const startTs = Date.now();
  const result: ProcessResult = {
    examined: 0,
    processed: 0,
    expedientes_inserted: 0,
    errors: 0,
    skipped_already_processed: 0,
    duration_ms: 0,
  };

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    logger.error('process_ordenes_dia_supabase_env_missing');
    result.errors++;
    result.duration_ms = Date.now() - startTs;
    return result;
  }
  const supabase: SupabaseClient = createClient(supaUrl, supaKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Items NO procesados todavía (processed_at IS NULL) — gracias al index
  // parcial sharepoint_raw_unprocessed_idx esto escala bien aún con 8k items.
  // Procesamos los más recientes primero (más relevantes para alertas vivas).
  const { data: items, error } = await supabase
    .from('sil_sharepoint_raw')
    .select('list_id, item_id, payload, scraped_at, processed_at, processor_status')
    .eq('list_id', 'Órdenes del día')
    .is('processed_at', null)
    .order('scraped_at', { ascending: false })
    .limit(opts.limit);

  if (error) {
    logger.error('process_ordenes_dia_query_failed', { error: error.message });
    result.errors++;
    result.duration_ms = Date.now() - startTs;
    return result;
  }
  result.examined = items?.length ?? 0;

  for (const item of (items ?? []) as SharepointRawRow[]) {
    try {
      const payload = item.payload ?? {};
      const fileLeafRef = payload.FileLeafRef ?? '';
      const fileRef = payload.FileRef ?? '';
      const modifiedIso = inferFechaFromModified(payload.Modified as string);

      if (!fileRef || !fileLeafRef) {
        await markProcessed(supabase, item.item_id, 'missing_fileref');
        result.skipped_already_processed++;
        continue;
      }

      const parsedName = parseOrdenDiaFilename(fileLeafRef);
      if (!parsedName) {
        await markProcessed(supabase, item.item_id, 'unparseable_filename');
        result.skipped_already_processed++;
        continue;
      }

      const pdfBuf = await downloadPdf(downloadUrl(fileRef));
      if (!pdfBuf) {
        await markProcessed(supabase, item.item_id, 'pdf_download_failed');
        result.errors++;
        continue;
      }

      const text = await parsePdfText(pdfBuf);
      if (!text) {
        await markProcessed(supabase, item.item_id, 'pdf_parse_failed');
        result.errors++;
        continue;
      }

      let expedientes = extractExpedientesFromText(text);

      // 2026-05-23: PDFs escaneados de comisiones devolvían text ~vacío
      // ("-- 1 of 2 --") y por ende 0 expedientes. Fallback a Vertex Gemini
      // Vision (Flash, ~$0.002 por PDF) cuando el texto es sospechosamente
      // corto O cuando un PDF de 2+ páginas no devuelve ningún expediente.
      // PLENARIO siempre devuelve >100 expedientes así que estos signos
      // discriminan bien casos escaneados.
      const textTooShort = (text?.trim().length ?? 0) < 100;
      const noExpedientes = expedientes.length === 0;
      if (textTooShort || noExpedientes) {
        const visionExpedientes = await tryVisionFallbackOrdenDia(
          pdfBuf,
          fileLeafRef,
        );
        if (visionExpedientes && visionExpedientes.length > 0) {
          expedientes = visionExpedientes;
        }
      }

      // Insert rows en agenda_legislativa — una por expediente.
      // unique constraint real es (fecha, comision, titulo) — si todos los
      // rows del mismo PDF llevan el mismo título "Orden del día X sesión Y"
      // solo 1 sobrevive. Hacemos el título único por row metiendo el número
      // del expediente — eso convierte el unique de facto en
      // (fecha, comision, expediente_numero) sin migración.
      if (expedientes.length > 0 && modifiedIso) {
        const rows = expedientes.map((numero) => ({
          fecha: modifiedIso,
          comision: parsedName.comision,
          expediente_numero: numero,
          titulo: `Exp. ${numero} · Orden del día ${parsedName.comision} sesión ${parsedName.sesion_num ?? '?'}`,
          scraped_at: new Date().toISOString(),
        }));
        const { error: insErr, count } = await supabase
          .from('agenda_legislativa')
          .upsert(rows, { onConflict: 'fecha,comision,titulo', ignoreDuplicates: true, count: 'exact' });
        if (insErr) {
          logger.warn('process_ordenes_dia_agenda_upsert_failed', {
            item_id: item.item_id,
            error: insErr.message,
          });
          result.errors++;
        } else {
          result.expedientes_inserted += count ?? rows.length;
        }
      }

      await markProcessed(supabase, item.item_id, 'ok', {
        expedientes_count: expedientes.length,
        comision: parsedName.comision,
        sesion_num: parsedName.sesion_num,
      });
      result.processed++;
    } catch (err) {
      logger.warn('process_ordenes_dia_item_exception', {
        item_id: item.item_id,
        error: (err as Error).message,
      });
      result.errors++;
    }
  }

  result.duration_ms = Date.now() - startTs;
  logger.info('process_ordenes_dia_complete', { ...result });
  return result;
}

/**
 * Vision fallback para PDFs escaneados de órdenes del día (comisiones).
 * Pide a Gemini Flash la lista de expedientes mencionados como JSON
 * `{"expedientes":["DD.DDD",...]}`. Costo ~$0.002 por PDF.
 */
async function tryVisionFallbackOrdenDia(
  pdfBuffer: Buffer,
  fileLeafRef: string,
): Promise<string[] | null> {
  try {
    const { visionParsePdf } = await import('../services/visionPdfFallback.js');
    const prompt = `Sos un parser de documentos PDF de la Asamblea Legislativa de Costa Rica que detectan expedientes legislativos discutidos en sesión.

Devolvé un JSON con la lista de números de expediente que aparecen en este PDF:
{
  "expedientes": ["23.511", "22.293", "24.018"]
}

Reglas:
- Los expedientes en CR tienen formato DD.DDD (1-2 dígitos, punto, 3 dígitos).
- Incluí cada número distinto que veas, sin importar el contexto (lectura, votación, dictamen, etc.).
- Si el PDF está vacío o no menciona expedientes, devolvé {"expedientes": []}.
- Solo emitís JSON, sin texto adicional ni fences.`;
    const result = await visionParsePdf<{ expedientes?: string[] }>(pdfBuffer, {
      route: 'orden_dia.vision_fallback',
      modelTier: 'flash',
      label: fileLeafRef,
      prompt,
    });
    if (!result) return null;
    return (result.expedientes ?? []).filter((e) => /^\d{1,2}\.\d{3}$/.test(e));
  } catch (err) {
    logger.warn('process_ordenes_dia_vision_fallback_failed', {
      file: fileLeafRef,
      error: (err as Error).message,
    });
    return null;
  }
}

async function markProcessed(
  supabase: SupabaseClient,
  itemId: string,
  status: string,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await supabase
    .from('sil_sharepoint_raw')
    .update({
      processed_at: new Date().toISOString(),
      processor_status: status,
      processor_meta: { processor: 'processOrdenesDia', ...extras },
    })
    .eq('item_id', itemId);
}
