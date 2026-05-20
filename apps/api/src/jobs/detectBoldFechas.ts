/**
 * detectBoldFechas — itera sobre `sil_expediente_fechas_extraidas` con
 * visual_marker='plain' y campo='fecha_dictamen_estimada', y actualiza
 * el marker a 'bold' cuando la fecha aparece en negrita en el DOCX
 * original. Pedido 16g del cliente CL2.
 *
 * Cómo encuentra el DOCX:
 *   - El row de fechas_extraidas no apunta directamente al doc; tiene
 *     `fuente_documento_url` (URL al SIL) pero NO al GCS path.
 *   - Estrategia: buscar el doc en sil_documentos por expediente_id +
 *     tipo IN ('dictamen_mayoria', 'dictamen_minoria', 'otro') donde
 *     text_extracted CONTAINS el `valor_texto_original`. Si match: usar
 *     ese gcs_path.
 *
 * Idempotente: solo actualiza visual_marker='plain' → 'bold' cuando
 * detecta bold positivo. Si no detecta bold (o falla la verificación),
 * deja el row tal como está.
 *
 * Performance:
 *   - Network I/O dominante: ~1-3 MB por DOCX × N rows.
 *   - Para 1000 fechas extracted, esperamos ~10-30 min.
 *   - Procesamos en paralelo limitado (concurrency=3) para no saturar
 *     ni GCS ni mammoth.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { detectBoldFecha } from '../services/fechaDictamenBoldDetector.js';
import { logger } from '../services/logger.js';

export interface BoldDetectBulkResult {
  examined: number;
  bold_marked: number;
  no_bold: number;
  no_doc_found: number;
  failed: number;
  duration_ms: number;
}

export interface BoldDetectBulkOptions {
  limit?: number;
  /** Si true, re-procesa rows que ya están 'bold' (sirve para QA). */
  forceRecheck?: boolean;
}

interface FechaRow {
  id: string;
  expediente_id: string;
  valor_fecha: string;
  valor_texto_original: string | null;
  visual_marker: string | null;
}

/**
 * Para una fila de fecha extraída, intenta encontrar el doc en
 * sil_documentos del que probablemente vino. Match por:
 *  - mismo expediente_id (via sil_expedientes.numero → .id)
 *  - tipo en (dictamen_*, otro)
 *  - text_extracted contains el valor_texto_original
 *
 * Si encuentra varios, prefiere el más reciente. Retorna el gcs_path
 * o null si no hay match.
 */
async function findSourceDocGcsPath(
  s: SupabaseClient,
  fechaRow: FechaRow,
): Promise<string | null> {
  if (!fechaRow.valor_texto_original) return null;

  // Resolver expediente.numero → expediente.id (integer)
  const { data: expRow } = await s
    .from('sil_expedientes')
    .select('id')
    .eq('numero', fechaRow.expediente_id)
    .maybeSingle();
  if (!expRow) return null;
  const expedienteId = expRow.id as number;

  // Buscar docs con text_extracted que contenga el valor_texto_original.
  // ilike es case-insensitive substring match.
  const needle = fechaRow.valor_texto_original.slice(0, 120); // cap defensive
  const { data: docs } = await s
    .from('sil_documentos')
    .select('id, gcs_path, mime_type, created_at')
    .eq('expediente_id', expedienteId)
    .in('tipo', ['dictamen_mayoria', 'dictamen_minoria', 'otro', 'texto_base'])
    .ilike('text_extracted', `%${needle}%`)
    .not('gcs_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!docs || docs.length === 0) return null;
  const doc = docs[0];
  // Filtrar PDFs — no podemos detectar bold ahí.
  if (doc.mime_type && doc.mime_type.startsWith('application/pdf')) return null;
  return (doc.gcs_path as string) ?? null;
}

/**
 * Procesa hasta `limit` rows de fechas_extraidas. Concurrency limitada
 * a 3 para no saturar GCS.
 */
export async function detectBoldFechasBulk(
  s: SupabaseClient,
  opts: BoldDetectBulkOptions = {},
): Promise<BoldDetectBulkResult> {
  const startTs = Date.now();
  const limit = opts.limit ?? 200;

  let query = s
    .from('sil_expediente_fechas_extraidas')
    .select('id, expediente_id, valor_fecha, valor_texto_original, visual_marker')
    .eq('campo', 'fecha_dictamen_estimada')
    .is('superseded_by', null)
    .order('extracted_at', { ascending: false })
    .limit(limit);

  if (!opts.forceRecheck) {
    query = query.eq('visual_marker', 'plain');
  }

  const { data: rows, error } = await query;
  if (error) {
    logger.error('detect_bold_query_failed', { error: error.message });
    return {
      examined: 0,
      bold_marked: 0,
      no_bold: 0,
      no_doc_found: 0,
      failed: 1,
      duration_ms: Date.now() - startTs,
    };
  }
  if (!rows || rows.length === 0) {
    return {
      examined: 0,
      bold_marked: 0,
      no_bold: 0,
      no_doc_found: 0,
      failed: 0,
      duration_ms: Date.now() - startTs,
    };
  }

  const result = {
    examined: 0,
    bold_marked: 0,
    no_bold: 0,
    no_doc_found: 0,
    failed: 0,
    duration_ms: 0,
  };

  // Procesar SECUENCIAL — un DOCX a la vez. Concurrency 3 saturaba
  // memory (2-15MB por DOCX × 3 + mammoth runtime = ~100MB peak) y
  // crasheaba la instancia de Cloud Run con 503. El orchestrator
  // Python distribuye en muchas llamadas chicas en lugar de pocas
  // concurrentes.
  const CONCURRENCY = 1;
  const queue = [...rows] as FechaRow[];
  const workers: Promise<void>[] = [];

  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        result.examined++;

        if (!row.valor_texto_original) {
          result.no_doc_found++;
          continue;
        }

        const gcsPath = await findSourceDocGcsPath(s, row);
        if (!gcsPath) {
          result.no_doc_found++;
          continue;
        }

        const detect = await detectBoldFecha(gcsPath, row.valor_texto_original, row.valor_fecha);
        if (detect.bold) {
          const { error: updErr } = await s
            .from('sil_expediente_fechas_extraidas')
            .update({ visual_marker: 'bold' })
            .eq('id', row.id);
          if (updErr) {
            logger.warn('detect_bold_update_failed', { rowId: row.id, error: updErr.message });
            result.failed++;
          } else {
            result.bold_marked++;
          }
        } else {
          result.no_bold++;
        }
      }
    })());
  }

  await Promise.all(workers);
  result.duration_ms = Date.now() - startTs;
  return result;
}
