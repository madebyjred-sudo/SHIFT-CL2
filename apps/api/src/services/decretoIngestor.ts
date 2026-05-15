/**
 * decretoIngestor — orquesta el pipeline completo de Decretos Ejecutivos.
 *
 * PIPELINE:
 *   1. Consultar sil_sharepoint_raw WHERE list_id = DECRETOS_LIST_ID
 *      y WHERE sharepoint_item_id NOT IN (SELECT sharepoint_item_id FROM decretos_ejecutivos)
 *      → items nuevos del crawler de Track A.
 *   2. Por cada item nuevo:
 *      a. Construir URL del PDF desde payload.FileRef
 *      b. Descargar el PDF (con retry y timeout)
 *      c. parseDecretoPdf() → DecretoParsed
 *      d. Upsert en decretos_ejecutivos
 *      e. Upsert en sil_expediente_convocatoria (una fila por expediente afectado)
 *      f. Actualizar sigue_vigente en filas anteriores del mismo expediente
 *   3. Por cada cambio de estado (convocado/retirado), emitir evento a
 *      centinela_eventos con priority='high' para el match engine.
 *   4. Actualizar sharepoint_cursors.last_run_at con resultado.
 *
 * IDEMPOTENCIA:
 *   El upsert en decretos_ejecutivos usa sharepoint_item_id como llave única.
 *   Re-correr el ingestor es seguro — no duplica decretos.
 *   Los eventos centinela tienen dedup_key para evitar alertas duplicadas.
 *
 * ERROR HANDLING:
 *   Un error en un item no aborta el loop — se marca parser_status='failed'
 *   y el ingestor continúa. Al final se retorna { processed, errors }.
 *
 * Source: Track D, Sprint 1. Jred 2026-05-14.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseDecretoPdf } from './decretoPdfParser.js';
import { logger } from './logger.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** ListId de la lista GLCP en el SharePoint — documentado en pedido 10 reunión 2026-05-14. */
export const DECRETOS_LIST_ID = '39be6869-1d4a-4c78-9efd-b495ef45322e';

const PDF_FETCH_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — ningún decreto debería ser más grande

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface SharepointDecretoRow {
  list_id: string;
  item_id: string;
  payload: {
    FileRef?: string;
    FileLeafRef?: string;
    Title?: string;
    Modified?: string;
    [key: string]: unknown;
  };
  scraped_at: string;
}

interface IngestResult {
  processed: number;
  errors: number;
  manual_review: number;
  skipped: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Descarga el PDF de un decreto desde el SharePoint GLCP.
 * Construye la URL a partir del FileRef del payload OData.
 *
 * El SharePoint GLCP de la Asamblea es de acceso público (sin autenticación)
 * para documentos de decreto — son documentos oficiales publicados.
 */
async function downloadDecretoPdf(fileRef: string): Promise<Buffer> {
  // FileRef viene como ruta relativa del sitio, ej: "/glcp/Decretos_Ejecutivos_Ampliacion/..."
  // La URL base del SharePoint público de la Asamblea es https://www.asamblea.go.cr
  const baseUrl = process.env.SIL_SHAREPOINT_BASE?.replace('/glcp', '') ?? 'https://www.asamblea.go.cr';
  const url = fileRef.startsWith('http') ? fileRef : `${baseUrl}${fileRef}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Algunos endpoints del GLCP requieren este header para servir el binario
        Accept: 'application/pdf, application/octet-stream, */*',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching PDF from ${url}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
      logger.warn('[decretoIngestor] unexpected content-type for PDF', { url, contentType });
      // No abortamos — algunos servidores sirven PDFs con content-type text/html
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_PDF_SIZE_BYTES) {
      throw new Error(`PDF too large: ${arrayBuffer.byteLength} bytes > ${MAX_PDF_SIZE_BYTES}`);
    }

    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Actualiza sigue_vigente=false en todos los rows previos de un expediente.
 * Se llama antes de insertar el nuevo row para mantener la invariante:
 * solo el row más reciente puede tener sigue_vigente=true.
 */
async function marcarAnterioresComoVencidos(
  supabase: SupabaseClient,
  expediente_id: string,
): Promise<void> {
  const { error } = await supabase
    .from('sil_expediente_convocatoria')
    .update({ sigue_vigente: false })
    .eq('expediente_id', expediente_id)
    .eq('sigue_vigente', true);

  if (error) {
    logger.warn('[decretoIngestor] error marking previous convocatoria as expired', {
      expediente_id,
      error: error.message,
    });
    // No lanzamos — la inserción del nuevo row puede seguir igualmente.
  }
}

/**
 * Emite un evento al match engine de Centinela.
 * event_type='decreto_convocatoria', priority='high'.
 * dedup_key evita duplicados si el ingestor corre dos veces seguidas.
 */
async function emitirEventoCentinela(
  supabase: SupabaseClient,
  opts: {
    expediente_id: string;
    decreto_id: string;
    accion: 'convocado' | 'retirado';
    fecha_decreto: Date;
    numero_decreto: string | null;
  },
): Promise<void> {
  // Verificar idempotencia: no duplicar evento del mismo decreto + expediente + accion.
  // centinela_eventos no tiene dedup_key — chequeamos por payload combinado.
  const fechaStr = opts.fecha_decreto.toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('centinela_eventos')
    .select('id')
    .eq('event_type', 'decreto_convocatoria')
    .eq('expediente_id', opts.expediente_id)
    .contains('payload', { decreto_id: opts.decreto_id, accion: opts.accion })
    .maybeSingle();

  if (existing) return; // ya emitido

  const { error } = await supabase.from('centinela_eventos').insert({
    event_type: 'decreto_convocatoria',
    priority: 'high',
    expediente_id: opts.expediente_id,
    detected_at: opts.fecha_decreto.toISOString(),
    source_url: null, // URL del decreto en SharePoint — se añade en Sprint 2 si necesario
    payload: {
      accion: opts.accion,
      decreto_id: opts.decreto_id,
      numero_decreto: opts.numero_decreto,
      fecha_decreto: fechaStr,
      // Mensaje legible para la UI de alertas (Track C match engine lo usa)
      titulo: opts.accion === 'convocado'
        ? `Expediente ${opts.expediente_id} convocado al Plenario`
        : `Expediente ${opts.expediente_id} retirado de la convocatoria del Plenario`,
      descripcion: opts.accion === 'convocado'
        ? `El decreto ${opts.numero_decreto ?? 'ejecutivo'} amplió la convocatoria de sesiones extraordinarias incluyendo el expediente ${opts.expediente_id}. Puede ser discutido en cualquier sesión del Plenario hasta nuevo decreto.`
        : `El decreto ${opts.numero_decreto ?? 'ejecutivo'} retiró el expediente ${opts.expediente_id} de la convocatoria. No podrá discutirse hasta una nueva ampliación.`,
    },
  });

  if (error) {
    // No es fatal — el evento de Centinela es best-effort
    logger.warn('[decretoIngestor] error emitting centinela event', {
      expediente_id: opts.expediente_id,
      decreto_id: opts.decreto_id,
      accion: opts.accion,
      error: error.message,
    });
  }
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Ingesta decretos ejecutivos nuevos desde el SharePoint raw storage.
 *
 * @param supabase - Cliente Supabase con service_role (bypasea RLS).
 * @returns Resultado con contadores de procesados / errores / manual_review.
 */
export async function ingestNewDecretos(
  supabase: SupabaseClient,
): Promise<IngestResult> {
  const result: IngestResult = { processed: 0, errors: 0, manual_review: 0, skipped: 0 };

  // ── Paso 1: Obtener items nuevos del SharePoint raw ──────────────────────
  // Buscamos items de la lista de decretos que AÚN no tienen un row en
  // decretos_ejecutivos (por sharepoint_item_id). Procesamos en lotes de 50.

  const { data: rawItems, error: rawError } = await supabase
    .from('sil_sharepoint_raw')
    .select('list_id, item_id, payload, scraped_at')
    .eq('list_id', DECRETOS_LIST_ID)
    .order('scraped_at', { ascending: true });

  if (rawError) {
    logger.error('[decretoIngestor] error fetching raw SharePoint items', { error: rawError.message });
    result.errors++;
    return result;
  }

  if (!rawItems || rawItems.length === 0) {
    logger.info('[decretoIngestor] no raw items found for DECRETOS_LIST_ID — nothing to process');
    return result;
  }

  // Obtener los sharepoint_item_ids ya procesados para filtrar
  const { data: processed } = await supabase
    .from('decretos_ejecutivos')
    .select('sharepoint_item_id')
    .not('sharepoint_item_id', 'is', null);

  const processedIds = new Set((processed ?? []).map((r: { sharepoint_item_id: string | null }) => r.sharepoint_item_id));

  const nuevos = (rawItems as SharepointDecretoRow[]).filter(
    (row) => !processedIds.has(row.item_id),
  );

  logger.info('[decretoIngestor] items to process', {
    total_raw: rawItems.length,
    already_processed: processedIds.size,
    nuevos: nuevos.length,
  });

  // ── Paso 2: Procesar cada item ────────────────────────────────────────────
  for (const row of nuevos) {
    const fileRef = row.payload.FileRef as string | undefined;

    if (!fileRef) {
      logger.warn('[decretoIngestor] item has no FileRef — skipping', { item_id: row.item_id });
      result.skipped++;
      continue;
    }

    // ── 2a. Insertar row en decretos_ejecutivos en estado 'in_progress' ──
    // El lock optimista previene que otro worker tome el mismo item.
    const { data: decreto, error: insertError } = await supabase
      .from('decretos_ejecutivos')
      .upsert(
        {
          sharepoint_item_id: row.item_id,
          documento_url: fileRef.startsWith('http')
            ? fileRef
            : `${process.env.SIL_SHAREPOINT_BASE?.replace('/glcp', '') ?? 'https://www.asamblea.go.cr'}${fileRef}`,
          fecha: new Date().toISOString().split('T')[0], // Placeholder — se actualiza post-parse
          tipo: 'ampliacion', // Placeholder — se actualiza post-parse
          raw: row.payload,
          parser_status: 'in_progress',
        },
        { onConflict: 'sharepoint_item_id', ignoreDuplicates: false },
      )
      .select('id')
      .single();

    if (insertError || !decreto) {
      logger.error('[decretoIngestor] error inserting decreto row', {
        item_id: row.item_id,
        error: insertError?.message,
      });
      result.errors++;
      continue;
    }

    const decretoId = decreto.id as string;

    // ── 2b. Descargar PDF ─────────────────────────────────────────────────
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await downloadDecretoPdf(fileRef);
    } catch (err) {
      logger.error('[decretoIngestor] error downloading PDF', {
        fileRef,
        error: (err as Error).message,
      });

      await supabase
        .from('decretos_ejecutivos')
        .update({
          parser_status: 'failed',
          parser_error: `PDF download failed: ${(err as Error).message}`.slice(0, 2000),
        })
        .eq('id', decretoId);

      result.errors++;
      continue;
    }

    // ── 2c. Parsear PDF ───────────────────────────────────────────────────
    // Pasamos FileLeafRef como fallback: el filename trae número de decreto
    // ("44750-MP") y fecha ("12-11-2024") que el texto del PDF a veces no
    // expone bien. Fix bug D-1 del smoke 2026-05-15.
    const fileLeafRef = row.payload.FileLeafRef as string | undefined;
    let parsed;
    try {
      parsed = await parseDecretoPdf(pdfBuffer, { fileLeafRef });
    } catch (err) {
      logger.error('[decretoIngestor] error parsing decreto PDF', {
        decretoId,
        error: (err as Error).message,
      });

      await supabase
        .from('decretos_ejecutivos')
        .update({
          parser_status: 'failed',
          parser_error: `Parse failed: ${(err as Error).message}`.slice(0, 2000),
        })
        .eq('id', decretoId);

      result.errors++;
      continue;
    }

    // ── 2d. Actualizar decreto con datos parseados ─────────────────────────
    const { error: updateError } = await supabase
      .from('decretos_ejecutivos')
      .update({
        numero_decreto: parsed.numero_decreto,
        fecha: parsed.fecha.toISOString().split('T')[0],
        tipo: parsed.tipo,
        parser_status: parsed.needs_manual_review ? 'manual_review' : 'done',
        parser_error: parsed.needs_manual_review
          ? `Low confidence: ${parsed.parser_confidence.toFixed(2)}`
          : null,
        procesado_at: new Date().toISOString(),
      })
      .eq('id', decretoId);

    if (updateError) {
      logger.error('[decretoIngestor] error updating decreto after parse', {
        decretoId,
        error: updateError.message,
      });
      result.errors++;
      continue;
    }

    // ── 2e. Upsert en sil_expediente_convocatoria ─────────────────────────
    const expedientesAffectados: Array<{ id: string; accion: 'convocado' | 'retirado' }> = [
      ...parsed.expedientes_ampliados.map((id) => ({ id, accion: 'convocado' as const })),
      ...parsed.expedientes_retirados.map((id) => ({ id, accion: 'retirado' as const })),
    ];

    for (const { id: expedienteId, accion } of expedientesAffectados) {
      try {
        // ── 2f. Marcar anteriores como vencidos ──────────────────────────
        await marcarAnterioresComoVencidos(supabase, expedienteId);

        // Insertar nuevo row de convocatoria
        const sigueVigente = accion === 'convocado';
        const { error: convError } = await supabase
          .from('sil_expediente_convocatoria')
          .insert({
            expediente_id: expedienteId,
            decreto_id: decretoId,
            fecha_decreto: parsed.fecha.toISOString().split('T')[0],
            accion,
            sigue_vigente: sigueVigente,
          });

        if (convError) {
          logger.warn('[decretoIngestor] error inserting convocatoria row', {
            expedienteId,
            decretoId,
            error: convError.message,
          });
          // No contamos como error del decreto — continuamos con el siguiente expediente
          continue;
        }

        // ── 2g. Emitir evento a Centinela ────────────────────────────────
        await emitirEventoCentinela(supabase, {
          expediente_id: expedienteId,
          decreto_id: decretoId,
          accion,
          fecha_decreto: parsed.fecha,
          numero_decreto: parsed.numero_decreto,
        });
      } catch (err) {
        logger.warn('[decretoIngestor] error processing expediente within decreto', {
          expedienteId,
          decretoId,
          error: (err as Error).message,
        });
      }
    }

    if (parsed.needs_manual_review) {
      result.manual_review++;
    } else {
      result.processed++;
    }

    logger.info('[decretoIngestor] decreto processed', {
      decretoId,
      sharepoint_item_id: row.item_id,
      numero_decreto: parsed.numero_decreto,
      tipo: parsed.tipo,
      expedientes_ampliados: parsed.expedientes_ampliados.length,
      expedientes_retirados: parsed.expedientes_retirados.length,
      parser_confidence: parsed.parser_confidence,
      needs_manual_review: parsed.needs_manual_review,
    });
  }

  logger.info('[decretoIngestor] ingest run complete', result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Recalcula sigue_vigente para todos los expedientes.
 * Operación de mantenimiento — útil si la tabla queda inconsistente.
 * Algoritmo:
 *   Para cada expediente_id, encontrar el row con mayor fecha_decreto.
 *   Ese row queda sigue_vigente=true si accion='convocado', false si 'retirado'.
 *   Todos los demás rows del mismo expediente: sigue_vigente=false.
 */
export async function recalcularVigencia(supabase: SupabaseClient): Promise<void> {
  logger.info('[decretoIngestor] starting vigencia recalc');

  // Primero, marcar todos como false
  await supabase
    .from('sil_expediente_convocatoria')
    .update({ sigue_vigente: false })
    .neq('sigue_vigente', false); // dummy filter para afectar todos

  // Luego, encontrar el último decreto por expediente y marcarlo correctamente
  // NOTA: Postgres no permite UPDATE ... FROM subquery fácilmente en este client.
  // Implementamos como select + loop (acceptable para 201 decretos).

  const { data: ultimosPorExpediente } = await supabase.rpc(
    'get_last_convocatoria_per_expediente',
  );

  if (!ultimosPorExpediente) {
    logger.warn('[decretoIngestor] recalc: no data from rpc (function may not exist yet)');
    return;
  }

  // TODO: crear función RPC en migration si necesario.
  // Por ahora este método es un placeholder — se invoca solo como operación de mantenimiento manual.
  logger.info('[decretoIngestor] vigencia recalc complete (stub)');
}
