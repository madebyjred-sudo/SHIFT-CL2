/**
 * centinelaMatchEngine.ts
 *
 * Match engine para Centinela con prioridades estructuradas (Track C).
 *
 * Por cada evento nuevo en `centinela_eventos`, este engine:
 *  1. Consulta todos los watches activos en `centinela_watchlist`.
 *  2. Evalúa qué watches hacen match con el evento (por expediente_id,
 *     diputado, materia o comisión).
 *  3. Construye el título y body de la alerta según la prioridad del evento.
 *  4. Devuelve la lista de Match para que el notifier los persista.
 *
 * Regla de prioridad (pedido 16d del cliente Carlos Villalobos):
 *   audiencia_confirmada → critical
 *   mocion_fondo_presentada (segundo día o posteriores) → critical
 *   mocion_fondo_presentada (primer día) → high
 *   decreto_convocatoria → high
 *   resolucion_sala_constitucional → high
 *   ley_publicada → high
 *   orden_dia_publicada → medium
 *   cambio_estado → medium
 *   fecha_dictamen_proxima → medium
 *   plazo_cuatrienal_proximo → high (<30 días) | medium (>30 días)
 *   desviacion_procedimental → variable según payload.severidad
 *   default → info
 *
 * Author: Jred / Claude Code — 2026-05-14
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Tipos públicos ────────────────────────────────────────────────────────

export type CentinelaEventType =
  | 'orden_dia_publicada'
  | 'cambio_estado'
  | 'mocion_fondo_presentada'
  | 'audiencia_confirmada'
  | 'resolucion_sala_constitucional'
  | 'ley_publicada'
  | 'decreto_convocatoria'
  | 'fecha_dictamen_proxima'
  | 'plazo_cuatrienal_proximo'
  | 'desviacion_procedimental';

export type Priority = 'critical' | 'high' | 'medium' | 'info';

export interface CentinelaEvento {
  id: string;
  event_type: CentinelaEventType;
  priority: Priority;
  expediente_id?: string | null;
  payload: Record<string, unknown>;
  source_url?: string | null;
  comision?: string | null;
  diputado?: string | null;
  materia?: string | null;
  detected_at?: string;
}

export interface WatchRow {
  id: string;
  user_id: string;
  entity_type: string;   // 'expediente' | 'diputado' | 'tema' | 'comision'
  entity_id: string;
  metadata: Record<string, unknown>;
}

export interface Match {
  user_id: string;
  watch_id: string;
  title: string;
  body: string;
  priority: Priority;
}

// ─── Emoji por prioridad ────────────────────────────────────────────────────

const PRIORITY_EMOJI: Record<Priority, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  info: '⚪',
};

// ─── Inferencia de prioridad ────────────────────────────────────────────────

/**
 * Determina la prioridad de un evento según su tipo y payload.
 * Implementa la regla explícita del cliente (pedido 16d).
 */
export function inferPriority(
  event_type: CentinelaEventType,
  payload: Record<string, unknown>,
): Priority {
  switch (event_type) {
    case 'audiencia_confirmada':
      return 'critical';

    case 'mocion_fondo_presentada': {
      // Pedido 11.bis: primer día vs segundo día es crítico políticamente.
      // Segundo día o posteriores = votación inminente = critical.
      // Primer día = hay tiempo de incidir = high.
      const dia = payload.dia_sesion as string | null | undefined;
      if (!dia || dia === 'primer') return 'high';
      // 'segundo', 'tercer', 'cuarto', etc. → critical
      return 'critical';
    }

    case 'decreto_convocatoria':
      return 'high';

    case 'resolucion_sala_constitucional':
      return 'high';

    case 'ley_publicada':
      return 'high';

    case 'orden_dia_publicada':
      return 'medium';

    case 'cambio_estado':
      return 'medium';

    case 'fecha_dictamen_proxima':
      return 'medium';

    case 'plazo_cuatrienal_proximo': {
      // High si quedan menos de 30 días; medium si más.
      const dias = payload.dias_restantes as number | undefined;
      if (typeof dias === 'number' && dias < 30) return 'high';
      return 'medium';
    }

    case 'desviacion_procedimental': {
      // La severidad viene en el payload del crawler.
      const sev = payload.severidad as string | undefined;
      if (sev === 'alta') return 'high';
      if (sev === 'media') return 'medium';
      return 'info';
    }

    default:
      return 'info';
  }
}

// ─── Construcción del título ────────────────────────────────────────────────

/**
 * Genera el título legible de la alerta según el evento y el watch.
 * Formato: "<emoji> <tipo legible> — exp <número>"
 */
export function buildAlertTitle(evento: CentinelaEvento, _watch: WatchRow): string {
  const emoji = PRIORITY_EMOJI[evento.priority];
  const expSuffix = evento.expediente_id ? ` — exp ${evento.expediente_id}` : '';

  const typeLabels: Record<CentinelaEventType, string> = {
    orden_dia_publicada: 'En orden del día',
    cambio_estado: 'Cambio de estado',
    mocion_fondo_presentada: _buildMocionTitle(evento),
    audiencia_confirmada: 'Audiencia confirmada',
    resolucion_sala_constitucional: 'Resolución Sala Constitucional',
    ley_publicada: 'Publicado como ley',
    decreto_convocatoria: 'Decreto de convocatoria',
    fecha_dictamen_proxima: 'Fecha estimada de dictamen próxima',
    plazo_cuatrienal_proximo: 'Plazo cuatrienal próximo',
    desviacion_procedimental: 'Desviación procedimental detectada',
  };

  const label = typeLabels[evento.event_type] ?? evento.event_type;
  return `${emoji} ${label}${expSuffix}`;
}

/** Subtítulo específico para mociones (captura dia_sesion del payload). */
function _buildMocionTitle(evento: CentinelaEvento): string {
  const art = evento.payload.articulo as number | undefined;
  const dia = evento.payload.dia_sesion as string | undefined;

  const artLabel = art ? ` (art. ${art})` : '';
  const diaLabel = dia ? ` — ${dia} día` : '';
  return `Moción de fondo${artLabel}${diaLabel}`;
}

// ─── Body de la alerta ──────────────────────────────────────────────────────

function buildAlertBody(evento: CentinelaEvento): string {
  const exp = evento.expediente_id ? `expediente ${evento.expediente_id}` : 'varios expedientes';

  switch (evento.event_type) {
    case 'orden_dia_publicada': {
      const organo = evento.payload.organo as string ?? evento.comision ?? 'órgano legislativo';
      const fecha = evento.payload.fecha_sesion as string ?? '';
      return `El ${exp} fue incluido en el orden del día de ${organo}${fecha ? ` para el ${fecha}` : ''}.`;
    }

    case 'mocion_fondo_presentada': {
      const art = evento.payload.articulo as number ?? '137';
      const dia = evento.payload.dia_sesion as string;
      const fecha = evento.payload.fecha_sesion as string ?? '';
      const urgencia = dia && dia !== 'primer'
        ? `VOTACIÓN inminente — hoy se deciden las mociones del ${exp}.`
        : `Se presentaron nuevas mociones (art. ${art}) sobre el ${exp}. Aún hay margen para incidir.`;
      return `${urgencia}${fecha ? ` Sesión: ${fecha}.` : ''}`;
    }

    case 'audiencia_confirmada': {
      const entidad = evento.payload.entidad as string ?? 'entidad no especificada';
      const fecha = evento.payload.fecha as string ?? '';
      return `Se confirmó audiencia técnica de ${entidad} para el ${exp}${fecha ? ` el ${fecha}` : ''}.`;
    }

    case 'cambio_estado': {
      const de = evento.payload.estado_anterior as string ?? '?';
      const a = evento.payload.estado_nuevo as string ?? '?';
      return `El ${exp} cambió de estado: ${de} → ${a}.`;
    }

    case 'resolucion_sala_constitucional': {
      const decision = evento.payload.decision as string ?? 'pendiente de análisis';
      return `Nueva resolución de la Sala Constitucional sobre el ${exp}. Decisión: ${decision}.`;
    }

    case 'ley_publicada': {
      const gaceta = evento.payload.numero_gaceta as string | number ?? '';
      return `El ${exp} fue publicado como ley en La Gaceta${gaceta ? ` N° ${gaceta}` : ''}.`;
    }

    case 'decreto_convocatoria': {
      const accion = evento.payload.accion as string ?? 'acción';
      return `Decreto ejecutivo de ${accion} afecta el ${exp}.`;
    }

    case 'fecha_dictamen_proxima': {
      const dias = evento.payload.dias_restantes as number ?? '?';
      return `El ${exp} tiene fecha estimada de dictamen en ${dias} días.`;
    }

    case 'plazo_cuatrienal_proximo': {
      const dias = evento.payload.dias_restantes as number ?? '?';
      return `El ${exp} vence su plazo cuatrienal en ${dias} días.`;
    }

    case 'desviacion_procedimental': {
      const desc = evento.payload.descripcion as string ?? 'incumplimiento de regla RAL';
      return `Desviación procedimental detectada en el ${exp}: ${desc}.`;
    }

    default:
      return `Nuevo evento detectado para el ${exp}.`;
  }
}

// ─── Match engine principal ─────────────────────────────────────────────────

/**
 * Evalúa un evento contra TODOS los watches activos y devuelve los matches.
 *
 * Reglas de match (entity_type del watch):
 *   'expediente' → watch.entity_id === evento.expediente_id
 *   'diputado'   → watch.entity_id (apellidos) en evento.diputado (fuzzy: includes)
 *   'tema'       → watch.entity_id (slug/keyword) en evento.materia (fuzzy: includes)
 *   'comision'   → watch.entity_id en evento.comision (fuzzy: includes)
 *
 * No hay matches cruzados por ahora (e.g. no se evalúa "todos los proyectos
 * de un diputado" contra expediente_id sin la tabla de proponentes).
 * Se expande en Sprint 2 cuando `sil_expediente_proponentes` esté disponible.
 */
export async function evaluateMatches(
  evento: CentinelaEvento,
  supabase: SupabaseClient,
): Promise<Match[]> {
  // 1. Traer todos los watches activos
  const { data: watches, error } = await supabase
    .from('centinela_watchlist')
    .select('id, user_id, entity_type, entity_id, metadata');

  if (error) {
    throw new Error(`evaluateMatches: failed to query watchlist — ${error.message}`);
  }

  const rows = (watches ?? []) as WatchRow[];
  const matches: Match[] = [];

  for (const watch of rows) {
    if (!_matchesWatch(evento, watch)) continue;

    const title = buildAlertTitle(evento, watch);
    const body = buildAlertBody(evento);

    matches.push({
      user_id: watch.user_id,
      watch_id: watch.id,
      title,
      body,
      priority: evento.priority,
    });
  }

  return matches;
}

/** Evalúa si un watch específico hace match con el evento. */
function _matchesWatch(evento: CentinelaEvento, watch: WatchRow): boolean {
  const watchId = (watch.entity_id ?? '').toLowerCase().trim();

  switch (watch.entity_type) {
    case 'expediente':
      // Match exacto por número de expediente.
      return !!evento.expediente_id &&
        watchId === (evento.expediente_id ?? '').toLowerCase().trim();

    case 'diputado':
      // Match fuzzy: el nombre del diputado del watch está contenido en
      // el campo diputado del evento. Maneja apellidos compuestos y variaciones.
      if (!evento.diputado) return false;
      return evento.diputado.toLowerCase().includes(watchId);

    case 'tema':
      // Match fuzzy: la materia del evento contiene el tema del watch.
      if (!evento.materia) return false;
      return evento.materia.toLowerCase().includes(watchId);

    case 'comision':
      // Match fuzzy: la comisión del evento contiene el watch (puede ser
      // nombre corto: "JURÍDICOS" matchea "COMISIÓN DE ASUNTOS JURÍDICOS").
      if (!evento.comision) return false;
      return evento.comision.toLowerCase().includes(watchId);

    default:
      return false;
  }
}
