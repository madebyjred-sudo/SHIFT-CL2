/**
 * listaDespachoMatcher.ts — Sprint 3 Track R.
 *
 * Responsabilidades:
 *   1. Parsear un row crudo de SharePoint (lista de despacho) a un shape
 *      tipado para `lista_despacho_items`.
 *   2. Upsert idempotente a la tabla.
 *   3. Detectar transición de estado (entrada/salida) y emitir el evento
 *      Centinela correspondiente vía `insertAndDispatch`.
 *
 * Diseño:
 *   * Una fila en SharePoint = un evento "item en estado X". Cuando el
 *     crawler ve la fila por primera vez con status='a_despacho' emite
 *     `entro_lista_despacho`. Cuando ve la fila con otro status (devuelto,
 *     remitido, archivado, caducó), emite `salio_lista_despacho`.
 *   * La detección de transición se hace contra la fila previa que tiene
 *     `fecha_salida is null` para ese expediente. Si existía → cerramos
 *     esa fila con `fecha_salida` y status corregido + emitimos
 *     `salio_lista_despacho`.
 *   * Idempotencia: re-correr el crawler con el mismo payload NO produce
 *     duplicados (UNIQUE expediente_id, fecha_entrada) ni alertas dup
 *     (Centinela dedupes por (user_id, event_id), 0033).
 *
 * Source: AGENTS/CL2/sprints/2026-05-16-sprint-2-3-design-doc.md Track R.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { insertAndDispatch } from './centinelaNotifier.js';
import type { CentinelaEventType, Priority } from './centinelaMatchEngine.js';
import { logger } from './logger.js';

// ─── Tipos públicos ────────────────────────────────────────────────────────

export type DespachoStatus =
  | 'a_despacho'
  | 'devuelto_a_comision'
  | 'remitido_plenario'
  | 'archivado'
  | 'caduca_cuatrienal';

/**
 * Resultado del intento de ingestar un item del SharePoint.
 *   'new'        → row insertada por primera vez (también puede haber
 *                  cerrado un row previo + emitido `salio_lista_despacho`).
 *   'duplicate'  → ya existía la misma (expediente_id, fecha_entrada).
 *   'skipped'    → no se pudo parsear (faltan campos esenciales).
 */
export type IngestOutcome = 'new' | 'duplicate' | 'skipped';

/**
 * Shape mínimo del payload de SharePoint que necesitamos. El item real trae
 * muchos más campos pero solo estos son requeridos para construir la fila.
 *
 * El SharePoint de la Asamblea CR no tiene un schema documentado para esta
 * lista — los nombres de campo se infieren de los patterns de listas
 * similares. Si el title no matchea, podemos pivotar al nombre real cuando
 * se vea el primer payload real.
 */
export interface RawDespachoRow {
  Id: number | string;
  Title?: string | null;
  Modified?: string;
  Created?: string;
  // Posibles campos de fecha de entrada. El parser intenta varios.
  FechaEntrada?: string;
  Fecha_x0020_Entrada?: string;
  FechaIngreso?: string;
  // Posibles campos de fecha de salida.
  FechaSalida?: string;
  Fecha_x0020_Salida?: string;
  // Status puede venir como string libre o un campo enum.
  Status?: string;
  Estado?: string;
  // Expediente_x0020_Numero, ExpedienteNumero, Expediente, NumExpediente.
  Expediente?: string;
  ExpedienteNumero?: string;
  NumExpediente?: string;
  Expediente_x0020_Numero?: string;
  // PDF de la decisión cuando aplica.
  DecisionUrl?: string;
  PdfUrl?: string;
  FileRef?: string;
  // Comentario.
  Comentario?: string;
  ComentarioDiputado?: string;
  [k: string]: unknown;
}

interface ParsedRow {
  expediente_id: string;
  fecha_entrada: string;   // YYYY-MM-DD
  fecha_salida: string | null;
  status: DespachoStatus;
  fuente_pdf_url: string | null;
  comentario_diputado: string | null;
  raw: Record<string, unknown>;
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Extrae el número de expediente del payload. Acepta varias columnas
 * posibles y también busca el patrón `\d{2}\.\d{3,4}` en el Title como
 * fallback.
 */
export function extractExpedienteNumero(row: RawDespachoRow): string | null {
  const direct =
    row.ExpedienteNumero ??
    row.NumExpediente ??
    row.Expediente ??
    row.Expediente_x0020_Numero;

  if (direct && typeof direct === 'string' && direct.trim().length > 0) {
    return normalizeExpediente(direct.trim());
  }

  // Fallback: parse del Title. Patrón típico "Expediente N° 23.511 ..." o
  // "Exp 23.511" o "23.511 — Ley X" — buscamos el primer match \d{2,3}.\d{3,4}.
  const title = row.Title ?? '';
  const m = title.match(/(\d{2,3}\.\d{3,4})/);
  if (m) return m[1];

  return null;
}

/**
 * Normaliza el formato canónico ("23.511" o "23511" → "23.511"). El SIL
 * usa "23.511" con punto como separador de miles + grupos.
 */
function normalizeExpediente(raw: string): string {
  const trimmed = raw.trim().replace(/[^\d.]/g, '');
  if (/^\d{4,5}$/.test(trimmed)) {
    // "23511" → "23.511"
    return `${trimmed.slice(0, 2)}.${trimmed.slice(2)}`;
  }
  return trimmed;
}

/**
 * Convierte un string de fecha (ISO o "DD/MM/YYYY" o similar) a "YYYY-MM-DD".
 * Devuelve null si no parsea.
 */
export function parseDate(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO ya bien formado "2026-05-12T..." o "2026-05-12"
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Último intento: Date.parse
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Normaliza el status a uno de los 5 valores canónicos del CHECK.
 * SharePoint puede usar "A despacho", "En despacho", "Despacho", "Devuelto",
 * "Plenario", "Archivado", "Caducó", etc.
 */
export function normalizeStatus(raw: string | undefined | null): DespachoStatus {
  if (!raw) return 'a_despacho';
  const lower = raw.toLowerCase().trim();

  if (/^a[\s_-]?despacho|^en[\s_-]?despacho|^despacho$|^pendiente/.test(lower))
    return 'a_despacho';
  if (/devuelt|regres|retorn/.test(lower)) return 'devuelto_a_comision';
  if (/plenari|remitid|elev/.test(lower)) return 'remitido_plenario';
  if (/archiv/.test(lower)) return 'archivado';
  if (/caduc|venci|cuatrien/.test(lower)) return 'caduca_cuatrienal';

  // Default: si el item está vivo en la lista, asumimos a_despacho.
  return 'a_despacho';
}

/**
 * Parsea un row del SharePoint a la forma que se inserta en la BD.
 * Returns null si faltan campos esenciales (expediente_id o fecha_entrada).
 */
export function parseRow(row: RawDespachoRow): ParsedRow | null {
  const expediente_id = extractExpedienteNumero(row);
  if (!expediente_id) return null;

  const fecha_entrada =
    parseDate(row.FechaEntrada) ??
    parseDate(row.Fecha_x0020_Entrada) ??
    parseDate(row.FechaIngreso) ??
    parseDate(row.Created) ??
    parseDate(row.Modified);
  if (!fecha_entrada) return null;

  const fecha_salida =
    parseDate(row.FechaSalida) ??
    parseDate(row.Fecha_x0020_Salida);

  const status = normalizeStatus(row.Status ?? row.Estado ?? null);

  const fuente_pdf_url =
    (typeof row.DecisionUrl === 'string' && row.DecisionUrl) ||
    (typeof row.PdfUrl === 'string' && row.PdfUrl) ||
    (typeof row.FileRef === 'string' && row.FileRef) ||
    null;

  const comentario_diputado =
    (typeof row.ComentarioDiputado === 'string' && row.ComentarioDiputado) ||
    (typeof row.Comentario === 'string' && row.Comentario) ||
    null;

  return {
    expediente_id,
    fecha_entrada,
    fecha_salida,
    status,
    fuente_pdf_url,
    comentario_diputado,
    raw: row as Record<string, unknown>,
  };
}

// ─── Centinela: emisión de eventos ───────────────────────────────────────────

/**
 * Mapea (status, transición) al `event_type` + priority del evento Centinela.
 *
 * Entrada de un expediente a despacho → `entro_lista_despacho` high.
 * Salida (cualquier status ≠ a_despacho) → `salio_lista_despacho` medium.
 */
function buildCentinelaEvent(
  parsed: ParsedRow,
  transition: 'enter' | 'exit',
): {
  event_type: CentinelaEventType;
  priority: Priority;
  payload: Record<string, unknown>;
} {
  if (transition === 'enter') {
    return {
      event_type: 'entro_lista_despacho',
      priority: 'high',
      payload: {
        expediente_id: parsed.expediente_id,
        fecha_entrada: parsed.fecha_entrada,
        status: parsed.status,
        comentario_diputado: parsed.comentario_diputado,
      },
    };
  }
  return {
    event_type: 'salio_lista_despacho',
    priority: 'medium',
    payload: {
      expediente_id: parsed.expediente_id,
      fecha_entrada: parsed.fecha_entrada,
      fecha_salida: parsed.fecha_salida ?? new Date().toISOString().slice(0, 10),
      status: parsed.status,
      fuente_pdf_url: parsed.fuente_pdf_url,
    },
  };
}

// ─── Ingest principal ──────────────────────────────────────────────────────

/**
 * Idempotente. Upsertea el item en `lista_despacho_items` y, si corresponde,
 * cierra el item previo (set fecha_salida + status) + emite evento Centinela.
 */
export async function ingestListaDespachoItem(
  row: RawDespachoRow,
  supabase: SupabaseClient,
): Promise<IngestOutcome> {
  const parsed = parseRow(row);
  if (!parsed) {
    logger.info('lista_despacho_ingest_skipped', {
      reason: 'cannot_parse',
      item_id: (row as Record<string, unknown>).Id,
      title: row.Title ?? null,
    });
    return 'skipped';
  }

  // 1. ¿Ya existe un item activo (fecha_salida is null) para este expediente?
  const { data: openRow } = await supabase
    .from('lista_despacho_items')
    .select('id, fecha_entrada, status')
    .eq('expediente_id', parsed.expediente_id)
    .is('fecha_salida', null)
    .order('fecha_entrada', { ascending: false })
    .limit(1)
    .maybeSingle();

  const openItem = openRow as { id: string; fecha_entrada: string; status: DespachoStatus } | null;

  // 2. Caso "salida" — el item nuevo tiene status ≠ a_despacho y hay un
  //    activo. Cerramos el activo + emitimos evento de salida.
  if (parsed.status !== 'a_despacho' && openItem && openItem.fecha_entrada !== parsed.fecha_entrada) {
    await supabase
      .from('lista_despacho_items')
      .update({
        fecha_salida: parsed.fecha_salida ?? new Date().toISOString().slice(0, 10),
        status: parsed.status,
        fuente_pdf_url: parsed.fuente_pdf_url,
        comentario_diputado: parsed.comentario_diputado,
      })
      .eq('id', openItem.id);

    const exit = buildCentinelaEvent(parsed, 'exit');
    await safeDispatch(supabase, {
      event_type: exit.event_type,
      priority: exit.priority,
      expediente_id: parsed.expediente_id,
      payload: exit.payload,
    });

    // El "evento" estructural fue cerrar el activo + emitir salida. No
    // insertamos una fila nueva (el item de SharePoint refleja un cambio
    // sobre el mismo expediente, no una entrada nueva). Pero si el cliente
    // SÍ está usando la lista como historial de cambios (una fila por
    // transición), seguimos abajo en la sección 3 que igual upsertea.
  }

  // 3. Upsert del item actual.
  const upsertRow = {
    expediente_id: parsed.expediente_id,
    fecha_entrada: parsed.fecha_entrada,
    fecha_salida: parsed.fecha_salida,
    status: parsed.status,
    fuente_pdf_url: parsed.fuente_pdf_url,
    comentario_diputado: parsed.comentario_diputado,
    raw: parsed.raw,
  };

  const { data: inserted, error: upsertErr } = await supabase
    .from('lista_despacho_items')
    .upsert(upsertRow, {
      onConflict: 'expediente_id,fecha_entrada',
      ignoreDuplicates: true,
    })
    .select('id');

  if (upsertErr) {
    // 23505 = duplicate; lo tratamos como dup, no como error.
    if (upsertErr.code === '23505' || /duplicate/i.test(upsertErr.message)) {
      return 'duplicate';
    }
    throw new Error(`ingestListaDespachoItem: upsert failed — ${upsertErr.message}`);
  }

  const isNew = (inserted ?? []).length > 0;

  // 4. Caso "entrada" — el item nuevo tiene status='a_despacho' y NO había
  //    un activo previo (o estamos viendo una entrada nueva tras una salida
  //    anterior). Emitimos evento de entrada.
  if (isNew && parsed.status === 'a_despacho') {
    const enter = buildCentinelaEvent(parsed, 'enter');
    await safeDispatch(supabase, {
      event_type: enter.event_type,
      priority: enter.priority,
      expediente_id: parsed.expediente_id,
      payload: enter.payload,
    });
  }

  return isNew ? 'new' : 'duplicate';
}

/**
 * Wrapper de insertAndDispatch que swallow errores y los loguea. NO queremos
 * que un fallo del fan-out de alertas trabe el crawler completo — el row
 * ya quedó persistido en `lista_despacho_items`, lo cual es la fuente de
 * verdad. Si el alert engine falla, se puede re-disparar after-the-fact.
 */
async function safeDispatch(
  supabase: SupabaseClient,
  evt: {
    event_type: CentinelaEventType;
    priority: Priority;
    expediente_id: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await insertAndDispatch(
      {
        event_type: evt.event_type,
        priority: evt.priority,
        expediente_id: evt.expediente_id,
        payload: evt.payload,
      },
      supabase,
    );
  } catch (err) {
    logger.warn('lista_despacho_dispatch_failed', {
      event_type: evt.event_type,
      expediente_id: evt.expediente_id,
      error: (err as Error).message,
    });
  }
}
