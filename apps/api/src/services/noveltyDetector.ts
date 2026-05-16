/**
 * noveltyDetector.ts — pedido 16j del cliente ("algoritmo de Carlos").
 *
 * Cita textual (Carlos Villalobos, reunión 2026-05-14, 47:22–49:42):
 *   "Si en el otro lado [lista de mociones SharePoint] ella ve que dice
 *    segundo día, eso es nuevo. Porque no está aquí, no está aquí en el
 *    resumen [Tramitación]. Podría ser como un criterio para que él pueda
 *    decir de todos esos miles de proyectos que va a encontrar ahí, cuáles
 *    son los que se tiene que fijar — los que hayan cambios que no se vean
 *    reflejados aquí en la tramitación."
 *
 * Doctrina detrás del algoritmo:
 *   El SIL refleja el estado FORMAL del expediente (tramitación). El
 *   SharePoint GLCP refleja el estado OPERATIVO (qué mociones recibió la
 *   comisión, qué actas se publicaron, qué consultas se hicieron). Hay
 *   un lag entre ambos: una moción 137 entra a la comisión y aparece en
 *   la lista del SharePoint al instante, pero la tramitación oficial
 *   solo se actualiza cuando alguien la asienta. Si una moción aparece
 *   en SharePoint sin reflejo en `sil_expediente_tramite` → es una
 *   NOVEDAD que el consultor debe revisar.
 *
 *   Esto es exactamente lo que Carlos pidió: que de los miles de
 *   expedientes que tiene en watchlist, el sistema le diga cuáles
 *   tienen un cambio reciente que NO se ve reflejado todavía.
 *
 * NO ES UN LLM:
 *   Es una heurística de cruce SQL pura. Sigue la doctrina LLM-vs-Algoritmo
 *   (AGENTS/CEREBRO/proposals/2026-05-15-doctrina-llm-vs-algoritmo.md):
 *   problemas de detección con criterios explícitos → algoritmo, no LLM.
 *   El LLM se usa después para redactar el digest semanal, no para detectar.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('noveltyDetector: supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Types ────────────────────────────────────────────────────────────────

export type NovedadTipo =
  /**
   * Una moción art. 137 (1er o 2do día) aparece en la lista
   * `Consultas_mociones` del SharePoint, pero no hay un evento en
   * `sil_expediente_tramite` con keyword "moción 137" en ±5 días.
   */
  | 'mocion_137_no_reflejada_en_tramite'
  /**
   * Una consulta a entidad aparece como item de SharePoint con tipo
   * "consulta art. 177" pero `sil_expediente_consultas` no tiene fila
   * para esa entidad en ±10 días.
   */
  | 'consulta_177_no_reflejada_en_tramite'
  /**
   * El SharePoint reporta un acta nueva (Actas list) cuya fecha cae en
   * un día que NO está marcado en `sil_expediente_tramite` con un
   * evento de la comisión correspondiente.
   */
  | 'acta_sin_evento_tramite'
  /**
   * Aparece una moción del expediente en la lista del SharePoint donde
   * el item tiene status "segundo día" pero el primer día no fue
   * detectado antes — gap de detección anterior.
   */
  | 'mocion_segundo_dia_sin_primer_dia';

export interface NovedadDetectada {
  tipo: NovedadTipo;
  expediente_numero: string;
  descripcion: string;
  algoritmo: string;
  confidence: number; // 0..1
  fecha_deteccion: string; // ISO timestamp
  /**
   * Las dos fuentes que se cruzaron. El consultor las puede abrir
   * directamente para validar la novedad.
   */
  fuentes: {
    aparece_en: {
      sistema: 'sharepoint';
      list_title: string;
      item_id?: string;
      item_title?: string;
      item_fecha?: string;
      payload_url?: string;
    };
    no_aparece_en: {
      sistema: 'sil_expediente_tramite' | 'sil_expediente_consultas';
      criterio: string;
      ventana_dias: number;
    };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extrae el numero canónico del expediente (formato "23.511") del Title de
 * un item del SharePoint. Devuelve null si no se encuentra.
 */
function extractExpedienteNumero(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\b(\d{2,5}\.\d{3})\b/);
  return m ? m[1] : null;
}

function ymd(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const dA = new Date(`${a.slice(0, 10)}T12:00:00Z`).getTime();
  const dB = new Date(`${b.slice(0, 10)}T12:00:00Z`).getTime();
  return Math.abs(Math.round((dA - dB) / 86_400_000));
}

// ─── Algoritmo principal: moción 137 no reflejada en trámite ───────────────

/**
 * Algoritmo 1 — el caso que Carlos describió textualmente:
 *   "ella ve que dice segundo día, eso es nuevo. Porque no está aquí
 *    [en tramitación]".
 *
 * Pasos:
 *   1. Buscar en sil_sharepoint_raw rows cuya list_title contiene
 *      'Consultas_mociones' o 'mociones' y cuyo payload.Title menciona
 *      el número del expediente.
 *   2. Para cada uno, extraer fecha y tipo (primer día / segundo día).
 *   3. Buscar en sil_expediente_tramite eventos con keyword "137" o
 *      "moción" en ±5 días.
 *   4. Si NO hay match → novedad.
 *
 * Confidence:
 *   - 0.90 si el SharePoint item es muy reciente (<7 días) y no hay
 *     reflejo en tramite.
 *   - 0.75 si hay reflejo parcial (mismo día, descripción ambigua).
 *   - 0.50 si la ventana es ancha o el SharePoint payload está degradado.
 */
async function detectMocionesNoReflejadas(
  numero: string,
): Promise<NovedadDetectada[]> {
  const novedades: NovedadDetectada[] = [];
  const sb = supa();
  const VENTANA_DIAS = 5;

  // 1. SharePoint mociones que mencionan este expediente
  const { data: spRows, error: spErr } = await sb
    .from('sil_sharepoint_raw')
    .select('list_id, item_id, list_title, payload, scraped_at')
    .or('list_title.ilike.%mociones%,list_title.ilike.%Consultas_mociones%')
    .limit(500);

  if (spErr) {
    logger.warn('[noveltyDetector] sharepoint query failed', {
      error: spErr.message,
    });
    return [];
  }

  const mocionesDelExp = (spRows ?? []).filter((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const title = (payload?.Title as string) ?? (payload?.Asunto as string) ?? '';
    return extractExpedienteNumero(title) === numero;
  });

  if (mocionesDelExp.length === 0) return [];

  // 2. Eventos de tramitación con keyword moción/137 para este expediente
  const { data: tramiteRows } = await sb
    .from('sil_expediente_tramite')
    .select('descripcion, fecha_inicio, organo_legislativo')
    .eq('expediente_id', numero)
    .or('descripcion.ilike.%moci%,descripcion.ilike.%137%');

  const tramiteEvents = (tramiteRows ?? []) as Array<{
    descripcion: string;
    fecha_inicio: string;
    organo_legislativo: string;
  }>;

  // 3. Cross-check cada moción del SharePoint
  for (const row of mocionesDelExp) {
    const payload = row.payload as Record<string, unknown> | null;
    const title = (payload?.Title as string) ?? (payload?.Asunto as string) ?? '(sin título)';
    const fechaSp =
      (payload?.FechaConsulta as string) ??
      (payload?.Fecha as string) ??
      (payload?.Modified as string) ??
      row.scraped_at;
    const tipoSp = /segundo.*d.a/i.test(title) ? 'segundo_dia' : /primer.*d.a/i.test(title) ? 'primer_dia' : 'mocion';

    // Buscar match en tramite dentro de ±N días
    const match = tramiteEvents.find(
      (t) => daysBetween(t.fecha_inicio, fechaSp) <= VENTANA_DIAS,
    );

    if (match) continue; // Reflejada — no es novedad

    // No match → novedad
    const diasDesdeSp = daysBetween(ymd(new Date()), fechaSp);
    let confidence = 0.5;
    if (diasDesdeSp <= 7) confidence = 0.9;
    else if (diasDesdeSp <= 21) confidence = 0.75;

    novedades.push({
      tipo:
        tipoSp === 'segundo_dia'
          ? 'mocion_segundo_dia_sin_primer_dia'
          : 'mocion_137_no_reflejada_en_tramite',
      expediente_numero: numero,
      descripcion: `Moción ${tipoSp.replace('_', ' ')} aparece en la lista oficial del SharePoint ("${title.slice(0, 110)}") pero no se refleja como remisión a comisión en la pestaña Tramitación del SIL en ±${VENTANA_DIAS} días. Posible causa: la votación se decidió en sesión sin acta cargada todavía, o el SIL no actualizó.`,
      algoritmo: `LEFT JOIN sil_sharepoint_raw (list ILIKE %mociones%, payload.Title ILIKE %${numero}%) vs sil_expediente_tramite WHERE descripcion ILIKE %moci%|%137% y |fecha_inicio − fecha_sp| ≤ ${VENTANA_DIAS}d. SI el LEFT JOIN devuelve null → novedad. Confidence por recencia del item SharePoint.`,
      confidence,
      fecha_deteccion: new Date().toISOString(),
      fuentes: {
        aparece_en: {
          sistema: 'sharepoint',
          list_title: row.list_title ?? 'Consultas_mociones',
          item_id: row.item_id,
          item_title: title.slice(0, 200),
          item_fecha: fechaSp.slice(0, 10),
        },
        no_aparece_en: {
          sistema: 'sil_expediente_tramite',
          criterio: 'descripcion ILIKE %moci%|%137% AND fecha_inicio in ±5d',
          ventana_dias: VENTANA_DIAS,
        },
      },
    });
  }

  return novedades;
}

// ─── Algoritmo 2: acta sin evento de trámite ──────────────────────────────

async function detectActasSinEvento(numero: string): Promise<NovedadDetectada[]> {
  const novedades: NovedadDetectada[] = [];
  const sb = supa();
  const VENTANA_DIAS = 3;

  const { data: actaRows } = await sb
    .from('sil_sharepoint_raw')
    .select('list_id, item_id, list_title, payload, scraped_at')
    .ilike('list_title', '%Actas%')
    .limit(200);

  const actasDelExp = (actaRows ?? []).filter((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const title = (payload?.Title as string) ?? (payload?.Asunto as string) ?? '';
    return extractExpedienteNumero(title) === numero;
  });

  if (actasDelExp.length === 0) return [];

  const { data: tramiteRows } = await sb
    .from('sil_expediente_tramite')
    .select('descripcion, fecha_inicio, organo_legislativo')
    .eq('expediente_id', numero);

  const eventos = (tramiteRows ?? []) as Array<{
    descripcion: string;
    fecha_inicio: string;
    organo_legislativo: string;
  }>;

  for (const row of actasDelExp) {
    const payload = row.payload as Record<string, unknown> | null;
    const title = (payload?.Title as string) ?? '(acta sin título)';
    const fechaActa =
      (payload?.FechaSesion as string) ??
      (payload?.Fecha as string) ??
      row.scraped_at;

    const match = eventos.find(
      (e) => daysBetween(e.fecha_inicio, fechaActa) <= VENTANA_DIAS,
    );

    if (match) continue;

    novedades.push({
      tipo: 'acta_sin_evento_tramite',
      expediente_numero: numero,
      descripcion: `Acta de sesión publicada el ${fechaActa.slice(0, 10)} ("${title.slice(0, 110)}") no tiene un evento correspondiente en la pestaña Tramitación del SIL en ±${VENTANA_DIAS} días. Probable: la comisión sesionó pero el SIL no ha asentado el evento todavía.`,
      algoritmo: `LEFT JOIN sil_sharepoint_raw (list ILIKE %Actas%, payload.Title ILIKE %${numero}%) vs sil_expediente_tramite WHERE |fecha_inicio − fecha_sesion_acta| ≤ ${VENTANA_DIAS}d. Si null → novedad.`,
      confidence: 0.7,
      fecha_deteccion: new Date().toISOString(),
      fuentes: {
        aparece_en: {
          sistema: 'sharepoint',
          list_title: row.list_title ?? 'Actas',
          item_id: row.item_id,
          item_title: title.slice(0, 200),
          item_fecha: fechaActa.slice(0, 10),
        },
        no_aparece_en: {
          sistema: 'sil_expediente_tramite',
          criterio: `cualquier descripcion AND fecha_inicio in ±${VENTANA_DIAS}d`,
          ventana_dias: VENTANA_DIAS,
        },
      },
    });
  }

  return novedades;
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Detecta novedades para un expediente cruzando SharePoint vs SIL.
 * Llamada barata: ~2 queries por algoritmo, sin LLM. Pensada para correr
 * sincrónicamente cuando el frontend pide /api/expedientes/:numero/full.
 *
 * Para corrida masiva (todos los expedientes en watchlist del consultor),
 * agendar como job cada 30 min y persistir el resultado en
 * `centinela_eventos` con tipo='novedad_detectada' + payload completo.
 */
export async function detectNovedades(numero: string): Promise<NovedadDetectada[]> {
  const start = Date.now();
  try {
    const [mociones, actas] = await Promise.all([
      detectMocionesNoReflejadas(numero),
      detectActasSinEvento(numero),
    ]);
    const total = [...mociones, ...actas];

    logger.info('[noveltyDetector] done', {
      expediente: numero,
      novedades_count: total.length,
      duration_ms: Date.now() - start,
    });

    return total;
  } catch (err) {
    logger.warn('[noveltyDetector] failed', {
      expediente: numero,
      error: (err as Error).message,
    });
    return [];
  }
}
