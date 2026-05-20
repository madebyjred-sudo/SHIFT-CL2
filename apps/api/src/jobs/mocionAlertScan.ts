/**
 * mocionAlertScan — cron que cruza nuevas mociones del SIL contra
 * watchlist de usuarios y emite eventos a `centinela_eventos`.
 *
 * Pedidos 11 / 11bis del cliente CL2:
 *   "Cuando se presente una moción de fondo en un expediente que
 *    estamos siguiendo, queremos enterarnos en menos de 24h."
 *
 * Reglas de prioridad (consistentes con centinelaMatchEngine.ts):
 *   - mocion_fondo_presentada (segundo día) → critical
 *   - mocion_fondo_presentada (primer día) → high
 *   - moción 137 → high
 *   - moción 138 (reiteración) → high
 *   - moción 177 (dispensa trámite) → high
 *   - otras mociones → medium
 *
 * Por qué cron, no detect-on-write:
 *   El SIL bulk ingestor no sabe quién está watching qué — solo persiste
 *   sil_mociones. Acoplar el ingestor al match engine crearía una
 *   dependencia circular (ingestor → watchlist → users → ...) y
 *   complicaría re-runs.
 *
 * Idempotencia:
 *   UNIQUE (user_id, dedup_key) con dedup_key = mocion:<expediente>:<mocion_id>.
 *   Re-correr el job no genera duplicados.
 *
 * Performance:
 *   Para 100 mociones nuevas × 50 watches activos = ~5k pares. Cada par
 *   es un upsert simple. Esperamos <5s wall-time.
 *
 * Trigger:
 *   POST /api/internal/centinela/scan-mociones
 *   Cloud Scheduler: cada 30 min durante horario hábil CR.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

export interface MocionAlertScanResult {
  mociones_examined: number;
  users_examined: number;
  events_inserted: number;
  events_skipped_dup: number;
  errors: number;
  duration_ms: number;
}

interface MocionRow {
  id: string;
  expediente_numero: string | null;
  titulo: string | null;
  proponente: string | null;
  fecha: string | null;
  tipo_mocion: string | null;
  resultado: string | null;
  scraped_at: string | null;
}

interface WatchRow {
  user_id: string;
  entity_id: string;
}

/**
 * Mapea tipo_mocion del SIL a la priority. Si el SIL no clasifica
 * (tipo_mocion=null), default a medium.
 *
 * Esta clasificación es ortogonal a la del match engine: acá miramos
 * el tipo de la moción crudo desde sil_mociones. El engine después
 * puede subir prioridad según otros factores (e.g. el watch del user
 * tiene `priority=urgent`).
 */
function priorityFromTipoMocion(tipo: string | null): 'critical' | 'high' | 'medium' {
  if (!tipo) return 'medium';
  const t = tipo.toLowerCase();
  if (/137.*(segundo|2do).*d[íi]a/.test(t)) return 'critical';
  if (/137/.test(t)) return 'high';
  if (/138/.test(t)) return 'high'; // reiteración
  if (/177/.test(t)) return 'high'; // dispensa de trámite
  if (/fondo/.test(t)) return 'high';
  return 'medium';
}

/**
 * Construye el dedup_key. Formato: `mocion:<expediente>:<mocion_id>`.
 * El UUID de sil_mociones.id es estable cross-rerun → seguro como sufijo.
 */
function buildDedupKey(numero: string, mocionId: string): string {
  return `mocion:${numero}:${mocionId}`;
}

/**
 * Resumen breve del moción para el frontend (campo `descripcion` del
 * payload del evento).
 */
function buildDescripcion(m: MocionRow): string {
  const partes: string[] = [];
  if (m.tipo_mocion) partes.push(m.tipo_mocion);
  if (m.proponente) partes.push(`Proponente: ${m.proponente}`);
  if (m.fecha) partes.push(`Fecha: ${m.fecha}`);
  if (m.resultado) partes.push(`Resultado: ${m.resultado}`);
  return partes.join(' · ') || (m.titulo ?? 'Moción detectada');
}

export interface MocionAlertScanOptions {
  /** Solo mociones scraped después de esta fecha. Default: hace 24h. */
  since?: string;
  /** Cap de mociones a procesar (default 500). */
  limit?: number;
}

/**
 * Escanea mociones recientes y emite eventos para usuarios que watchean.
 *
 * Pipeline:
 *   1. SELECT sil_mociones WHERE scraped_at >= since AND expediente_numero IS NOT NULL
 *   2. SELECT centinela_watchlist WHERE entity_type='expediente'
 *   3. Cruzar en memoria por expediente_numero
 *   4. UPSERT centinela_eventos con dedup_key (idempotente)
 */
export async function scanMocionesParaAlertas(
  s: SupabaseClient,
  options: MocionAlertScanOptions = {},
): Promise<MocionAlertScanResult> {
  const startTs = Date.now();
  const result: MocionAlertScanResult = {
    mociones_examined: 0,
    users_examined: 0,
    events_inserted: 0,
    events_skipped_dup: 0,
    errors: 0,
    duration_ms: 0,
  };

  const since = options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const limit = options.limit ?? 500;

  // ── 1. Mociones recientes con expediente_numero ────────────────────────
  const { data: mociones, error: mocErr } = await s
    .from('sil_mociones')
    .select('id, expediente_numero, titulo, proponente, fecha, tipo_mocion, resultado, scraped_at')
    .gte('scraped_at', since)
    .not('expediente_numero', 'is', null)
    .order('scraped_at', { ascending: false })
    .limit(limit);

  if (mocErr) {
    logger.error('mocion_alert_scan_query_failed', { error: mocErr.message });
    result.errors++;
    result.duration_ms = Date.now() - startTs;
    return result;
  }
  if (!mociones || mociones.length === 0) {
    result.duration_ms = Date.now() - startTs;
    return result;
  }
  result.mociones_examined = mociones.length;

  // ── 2. Watches tipo 'expediente' ────────────────────────────────────────
  // No filtramos por `active` — la tabla actual no tiene esa columna; la
  // existencia de la row en la watchlist implica que el user quiere alertas.
  const { data: watches, error: wErr } = await s
    .from('centinela_watchlist')
    .select('user_id, entity_id')
    .eq('entity_type', 'expediente');

  if (wErr) {
    logger.error('mocion_alert_scan_watch_query_failed', { error: wErr.message });
    result.errors++;
    result.duration_ms = Date.now() - startTs;
    return result;
  }

  return runCross(s, mociones as MocionRow[], (watches ?? []) as WatchRow[], result, startTs);
}

async function runCross(
  s: SupabaseClient,
  mociones: MocionRow[],
  watches: WatchRow[],
  result: MocionAlertScanResult,
  startTs: number,
): Promise<MocionAlertScanResult> {
  // Index de watches: expediente_numero → [user_ids]
  const watchByExp = new Map<string, string[]>();
  for (const w of watches) {
    const key = w.entity_id.trim();
    if (!key) continue;
    const arr = watchByExp.get(key) ?? [];
    arr.push(w.user_id);
    watchByExp.set(key, arr);
  }

  const distinctUsers = new Set<string>();
  watches.forEach((w) => distinctUsers.add(w.user_id));
  result.users_examined = distinctUsers.size;

  // ── 3. Cruzar mociones × watches ────────────────────────────────────────
  for (const m of mociones) {
    if (!m.expediente_numero) continue;
    const users = watchByExp.get(m.expediente_numero.trim());
    if (!users || users.length === 0) continue;

    const priority = priorityFromTipoMocion(m.tipo_mocion);
    const descripcion = buildDescripcion(m);

    for (const userId of users) {
      const dedupKey = buildDedupKey(m.expediente_numero, m.id);
      const payload = {
        descripcion,
        mocion_id: m.id,
        mocion_titulo: m.titulo,
        mocion_proponente: m.proponente,
        mocion_fecha: m.fecha,
        mocion_tipo: m.tipo_mocion,
        mocion_resultado: m.resultado,
        algoritmo: 'mocionAlertScan',
        fecha_deteccion: new Date().toISOString(),
      };

      const { data: inserted, error: insErr } = await s
        .from('centinela_eventos')
        .upsert(
          {
            user_id: userId,
            event_type: 'mocion_fondo_presentada',
            expediente_id: m.expediente_numero,
            priority,
            dedup_key: dedupKey,
            detected_at: new Date().toISOString(),
            source_url: `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${m.expediente_numero.replace(/\./g, '')}`,
            payload,
          },
          { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
        )
        .select('id');

      if (insErr) {
        // Manejar dup como skip (similar a noveltyScan)
        if (insErr.code === '23505' || /duplicate key/i.test(insErr.message)) {
          result.events_skipped_dup++;
          continue;
        }
        logger.warn('mocion_alert_persist_failed', {
          user_id: userId,
          expediente: m.expediente_numero,
          mocion_id: m.id,
          error: insErr.message,
        });
        result.errors++;
        continue;
      }

      if (inserted && inserted.length > 0) {
        result.events_inserted++;
      } else {
        // ignoreDuplicates=true → data=[] cuando ya existía. Tally como dup.
        result.events_skipped_dup++;
      }
    }
  }

  result.duration_ms = Date.now() - startTs;
  return result;
}
