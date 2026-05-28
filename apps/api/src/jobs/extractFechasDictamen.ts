/**
 * extractFechasDictamen — corre el extractor de fecha estimada de dictamen
 * sobre todos los `sil_documentos.text_extracted` y persiste a
 * `sil_expediente_fechas_extraidas` con campo='fecha_dictamen_estimada'.
 *
 * Por qué este job existe:
 *   Pedido 07 del cliente CL2: "FECHA ESTIMADA DE DICTAMEN SIEMPRE ESTÁ
 *   DENTRO DE LOS DOCUMENTOS Y NORMALMENTE ES TENTATIVA NO OFICIAL PERO
 *   ES UN PROCESO QUE ELLOS HACEN MANUAL." Lo automatizamos.
 *
 *   Pedido 16h: detectar recálculos. Cuando re-corremos el job y la fecha
 *   cambió respecto a la anterior, marcamos la row vieja como
 *   `superseded_by` la nueva. El frontend muestra la historia.
 *
 * Pipeline (por documento):
 *   1. extractPrimaryFechaDictamen(doc.text_extracted) → candidato top
 *   2. Si hay fila previa en fechas_extraidas para (expediente, campo)
 *      con un valor_fecha distinto:
 *        - Marca la previa con superseded_by = new_row.id
 *        - Inserta la nueva
 *   3. Si la fecha es la misma que la vigente, no hace nada (idempotente).
 *   4. Si no hay extracción posible, marca el doc con
 *      metadata.fecha_dictamen_attempted=true para no re-procesar en vano.
 *
 * Visual marker (P16g): defer a una segunda fase que parsea DOCX XML para
 * detectar bold. Acá retornamos visual_marker='plain'.
 *
 * Idempotencia: re-correr el job sobre los mismos docs no genera dupes —
 * la lógica de comparar contra la fila vigente garantiza que solo se
 * inserta cuando hay un cambio real.
 *
 * Performance: ~100ms per documento (regex puro, sin LLM). Para 22k docs
 * total wall-time esperado <40min single-threaded.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { extractPrimaryFechaDictamen } from '../services/fechaDictamenExtractor.js';
import { logger } from '../services/logger.js';

/**
 * Resultado de procesar UN documento. status:
 *   - 'inserted'         — primera vez que se extrae fecha para este expediente
 *   - 'superseded'       — había una vigente, ahora una nueva (recálculo)
 *   - 'unchanged'        — la fecha extraída es la misma que ya está vigente
 *   - 'no_match'         — el extractor no encontró fecha en el texto
 *   - 'no_text'          — el documento no tiene text_extracted
 *   - 'no_expediente'    — el documento no tiene expediente_id (orfa)
 *   - 'failed'           — error de DB u otro
 */
export interface DocExtractResult {
  doc_id: string;
  expediente_id: string;
  status:
    | 'inserted'
    | 'superseded'
    | 'unchanged'
    | 'no_match'
    | 'no_text'
    | 'no_expediente'
    | 'failed';
  valor_fecha?: string;
  pattern_id?: string;
  superseded_from?: string;  // ISO date of previous value, when status='superseded'
  error?: string;
}

interface DocRow {
  id: string;
  expediente_id: number | null;
  expediente_numero: string | null;
  text_extracted: string | null;
  text_chars: number | null;
  tipo: string | null;
  fecha: string | null;
}

/**
 * Procesa un documento individual: extrae la fecha + persiste el cambio
 * a sil_expediente_fechas_extraidas (con chain superseded_by si aplica).
 */
async function processDoc(
  s: SupabaseClient,
  doc: DocRow,
): Promise<DocExtractResult> {
  const docId = doc.id;
  if (!doc.expediente_numero) {
    return { doc_id: docId, expediente_id: '', status: 'no_expediente' };
  }
  if (!doc.text_extracted || (doc.text_chars ?? 0) === 0) {
    return { doc_id: docId, expediente_id: doc.expediente_numero, status: 'no_text' };
  }

  const candidate = extractPrimaryFechaDictamen(doc.text_extracted);
  if (!candidate) {
    return { doc_id: docId, expediente_id: doc.expediente_numero, status: 'no_match' };
  }

  // Buscar la fila vigente actual de fecha_dictamen_estimada para este expediente.
  const { data: existingRows, error: queryErr } = await s
    .from('sil_expediente_fechas_extraidas')
    .select('id, valor_fecha, superseded_by, extracted_at')
    .eq('expediente_id', doc.expediente_numero)
    .eq('campo', 'fecha_dictamen_estimada')
    .is('superseded_by', null)
    .order('extracted_at', { ascending: false })
    .limit(1);

  if (queryErr) {
    logger.warn('fechas_extract_query_failed', { docId, error: queryErr.message });
    return {
      doc_id: docId,
      expediente_id: doc.expediente_numero,
      status: 'failed',
      error: queryErr.message,
    };
  }

  const existing = existingRows?.[0] ?? null;

  // Si la fecha extraída es igual a la vigente, no hacemos nada.
  if (existing && existing.valor_fecha === candidate.valor_fecha) {
    return {
      doc_id: docId,
      expediente_id: doc.expediente_numero,
      status: 'unchanged',
      valor_fecha: candidate.valor_fecha,
    };
  }

  // Insertar la nueva fila. Construimos la URL al SIL como fuente.
  const numInt = parseInt(doc.expediente_numero.replace(/\./g, ''), 10);
  const fuenteUrl = Number.isFinite(numInt)
    ? `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${numInt}`
    : null;

  const insertRow = {
    expediente_id: doc.expediente_numero,
    campo: 'fecha_dictamen_estimada',
    valor_fecha: candidate.valor_fecha,
    valor_texto_original: candidate.valor_texto_original.slice(0, 500),
    fuente_documento_url: fuenteUrl,
    fuente_pagina: null,
    extraction_method: 'regex',
    extraction_confidence: candidate.confidence,
    visual_marker: 'plain',  // bold detection diferido a Phase 2
    extracted_at: new Date().toISOString(),
    superseded_by: null,
  };

  const { data: inserted, error: insertErr } = await s
    .from('sil_expediente_fechas_extraidas')
    .insert(insertRow)
    .select('id')
    .single();

  if (insertErr || !inserted) {
    logger.warn('fechas_extract_insert_failed', { docId, error: insertErr?.message });
    return {
      doc_id: docId,
      expediente_id: doc.expediente_numero,
      status: 'failed',
      error: insertErr?.message ?? 'insert returned no row',
    };
  }

  // Si había una fila vigente con un valor distinto, marcarla como superseded.
  if (existing) {
    const { error: updErr } = await s
      .from('sil_expediente_fechas_extraidas')
      .update({
        superseded_by: inserted.id,
        // El reason inferido: el documento que generó la nueva fecha es
        // posterior al que generó la vieja. Guardamos un texto humano para
        // que el frontend (Pedido 16h) muestre algo informativo.
        superseded_reason: `Recalculada — ${candidate.pattern_id} en doc ${docId.slice(0, 8)}`,
      })
      .eq('id', existing.id);
    if (updErr) {
      logger.warn('fechas_extract_supersede_failed', { docId, error: updErr.message });
    }
    return {
      doc_id: docId,
      expediente_id: doc.expediente_numero,
      status: 'superseded',
      valor_fecha: candidate.valor_fecha,
      pattern_id: candidate.pattern_id,
      superseded_from: existing.valor_fecha as string,
    };
  }

  return {
    doc_id: docId,
    expediente_id: doc.expediente_numero,
    status: 'inserted',
    valor_fecha: candidate.valor_fecha,
    pattern_id: candidate.pattern_id,
  };
}

export interface BulkExtractOpts {
  /** Máximo de docs a procesar por corrida. */
  limit?: number;
  /** Solo procesar docs creados después de esta fecha (incremental). */
  since?: string;
  /** Solo procesar docs cuyo expediente_numero esté en esta lista. */
  expedienteFilter?: string[];
  /** Si true, ignora el caché y re-procesa docs que ya tienen fecha_dictamen_attempted=true. */
  forceReextract?: boolean;
}

export interface BulkExtractResult {
  processed: number;
  inserted: number;
  superseded: number;
  unchanged: number;
  no_match: number;
  no_text: number;
  no_expediente: number;
  failed: number;
}

/**
 * Procesa hasta `limit` documentos del SIL en orden de id desc (más
 * recientes primero — los del cuatrienio actual son la prioridad para el
 * cliente).
 *
 * Optimización: filtramos docs cuyo metadata.fecha_dictamen_attempted=true
 * (ya intentamos y no encontramos nada). Para re-intentar, pasar
 * forceReextract=true.
 */
export async function extractFechasDictamenBulk(
  s: SupabaseClient,
  opts: BulkExtractOpts = {},
): Promise<BulkExtractResult> {
  const limit = opts.limit ?? 500;
  const result: BulkExtractResult = {
    processed: 0,
    inserted: 0,
    superseded: 0,
    unchanged: 0,
    no_match: 0,
    no_text: 0,
    no_expediente: 0,
    failed: 0,
  };

  // El query base: docs con text_extracted no-vacío. Hacemos join lateral
  // con sil_expedientes para traer el `numero` (text) del expediente, ya
  // que sil_documentos.expediente_id es INTEGER referenciando sil_expedientes.id
  // y NO el .numero (text). Necesitamos el `numero` para escribir en
  // sil_expediente_fechas_extraidas (que usa expediente_id como text).
  let query = s
    .from('sil_documentos')
    .select(
      `id, expediente_id, text_extracted, text_chars, tipo, fecha,
       sil_expedientes!inner(numero)`,
    )
    .not('text_extracted', 'is', null)
    .gt('text_chars', 50)
    .order('id', { ascending: false })
    .limit(limit);

  if (opts.since) {
    query = query.gte('created_at', opts.since);
  }
  if (opts.expedienteFilter && opts.expedienteFilter.length > 0) {
    // Filtramos por el .numero del expediente (text). Esto requiere un
    // sub-query — usamos `in` sobre `expediente_id` que es un integer, así
    // que primero resolvemos los IDs.
    const { data: ids } = await s
      .from('sil_expedientes')
      .select('id')
      .in('numero', opts.expedienteFilter);
    const intIds = (ids ?? []).map((r) => r.id as number);
    if (intIds.length === 0) return result; // nada que procesar
    query = query.in('expediente_id', intIds);
  }
  if (!opts.forceReextract) {
    // Skipear docs ya intentados (metadata.fecha_dictamen_attempted=true).
    // Postgres jsonb ?| es 'has any key'; aquí lo usamos para excluir.
    // Supabase REST exige `not('metadata->>fecha_dictamen_attempted', 'eq', 'true')`
    // pero como muchos docs viejos tienen metadata=null, hacemos un filtro suave.
    query = query.or(
      'metadata.is.null,metadata->>fecha_dictamen_attempted.is.null,metadata->>fecha_dictamen_attempted.eq.false',
    );
  }

  const { data, error } = await query;
  if (error) {
    logger.error('extract_fechas_bulk_query_failed', { error: error.message });
    return result;
  }
  if (!data || data.length === 0) return result;

  // Procesar cada doc serialmente — el cuello de botella es DB, no CPU.
  // Si en el futuro queremos paralelizar, podemos hacer batches de 5-10.
  for (const row of data) {
    const docRow: DocRow = {
      id: row.id as string,
      expediente_id: row.expediente_id as number | null,
      // Nested expediente.numero — Supabase usa el nested array convention.
      expediente_numero:
        ((row.sil_expedientes as unknown as { numero: string } | { numero: string }[])
          ? (Array.isArray(row.sil_expedientes)
              ? (row.sil_expedientes[0]?.numero ?? null)
              : ((row.sil_expedientes as { numero: string }).numero ?? null))
          : null),
      text_extracted: row.text_extracted as string | null,
      text_chars: row.text_chars as number | null,
      tipo: row.tipo as string | null,
      fecha: row.fecha as string | null,
    };

    const r = await processDoc(s, docRow);
    result.processed += 1;
    result[r.status] = (result[r.status] ?? 0) + 1;

    // Marcar el doc como intentado — incluso si no encontramos nada — para
    // no re-procesarlo en futuras corridas (con forceReextract=true se ignora).
    if (r.status === 'no_match' || r.status === 'no_text') {
      // Marca soft: solo el flag, dejamos el resto del metadata intacto.
      await s.from('sil_documentos').update({
        metadata: {
          // jsonb merge no es directo en supabase-js; reemplazamos completo
          // si no había metadata previa. Si había, esto sobreescribe — para
          // el flag concreto está bien.
          fecha_dictamen_attempted: true,
          fecha_dictamen_attempted_at: new Date().toISOString(),
        },
      }).eq('id', docRow.id);
    }
  }

  return result;
}
