/**
 * noveltyScan.ts — Sprint 2 Track I.
 *
 * Cron que itera por todos los expedientes en watchlist activa y persiste
 * novedades a `centinela_eventos`. Reemplaza el detect-on-read que hoy corre
 * dentro de /api/expedientes/:numero/full.
 *
 * Por qué cron, no detect-on-read:
 *   - Si nadie visita el expediente, las novedades no se generan.
 *   - No hay historial — el algoritmo no sabe si ya alertó antes.
 *   - Cada /full request paga ~200ms de cross-check.
 *
 * Flujo:
 *   1. List user_ids con al menos una watch tipo 'expediente' (DISTINCT).
 *   2. Para cada user_id, traer todas sus watches expediente.
 *   3. Para cada watch, llamar detectNovedades(numero).
 *   4. Para cada novedad detectada:
 *        dedup_key = <tipo>:<expediente_numero>:<fuente_item_id ?? 'nokey'>
 *        upsert a centinela_eventos con onConflict='user_id,dedup_key'.
 *   5. Log estructurado al cerrar con contadores.
 *
 * Idempotencia:
 *   El UNIQUE parcial (user_id, dedup_key) WHERE dedup_key IS NOT NULL del
 *   índice 0039 garantiza que correr el job 2x sobre el mismo input
 *   no inserta duplicados. Las novedades "fantasma" (mismo evento del SP
 *   sin item_id estable) usan 'nokey' como sufijo, lo que puede causar
 *   colisiones cruzadas entre tipos distintos de novedad del mismo expediente;
 *   eso se considera mejor que spammear el feed (las novedades sin item_id
 *   son raras: ~2% del corpus actual según logs del detector).
 *
 * NO ES LLM: cero llamadas a OpenAI/Anthropic. El detector usa cruce SQL puro.
 *
 * Cómo se dispara: HTTP POST /api/admin/novelty/run-now (manual) o Cloud
 * Scheduler cada 30 min (cuando se wire en Sprint 2).
 *
 * Autor: Jred / Claude Code — 2026-05-16.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';
import { detectNovedades } from '../services/noveltyDetector.js';

// ── Supabase client (lazy, service role) ─────────────────────────────────────
let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'supabase env missing for noveltyScan (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface NoveltyScanResult {
  /** Número de usuarios distintos con al menos una watch expediente. */
  users: number;
  /** Número total de pares (user, expediente) procesados. */
  expedientes: number;
  /** Filas insertadas nuevas en centinela_eventos. */
  novedades_new: number;
  /** Filas que ya existían (dedup hit) y por eso no se insertaron. */
  novedades_skipped_dup: number;
  /** Total de errores parciales (no fatales). */
  errors: number;
  /** Duración total del job. */
  duration_ms: number;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface WatchRow {
  user_id: string;
  entity_id: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lista todos los user_ids distintos con al menos una watch tipo 'expediente'.
 *
 * PostgREST no soporta SELECT DISTINCT, así que traemos todas las rows y
 * deduplicamos en memoria. La watchlist actual tiene ~50 rows; el trade-off
 * está OK. Si crece a >5k, mover a una RPC o vista.
 */
async function listUsersWithExpedienteWatches(
  sb: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await sb
    .from('centinela_watchlist')
    .select('user_id')
    .eq('entity_type', 'expediente');
  if (error) throw new Error(`noveltyScan:listUsers: ${error.message}`);
  const rows = (data ?? []) as Array<{ user_id: string }>;
  const set = new Set<string>();
  for (const r of rows) set.add(r.user_id);
  return [...set];
}

/**
 * Traer las watches tipo 'expediente' de un usuario. Devuelve array de
 * { user_id, entity_id }. entity_id es el número de expediente (text).
 */
async function listExpedienteWatchesForUser(
  sb: SupabaseClient,
  userId: string,
): Promise<WatchRow[]> {
  const { data, error } = await sb
    .from('centinela_watchlist')
    .select('user_id, entity_id')
    .eq('entity_type', 'expediente')
    .eq('user_id', userId);
  if (error) throw new Error(`noveltyScan:listWatches(${userId}): ${error.message}`);
  return (data ?? []) as WatchRow[];
}

/**
 * Construye la dedup_key compuesta para una novedad. El sufijo 'nokey' se
 * usa cuando el item del SharePoint no expone item_id estable — los casos
 * raros (~2%) en los que el detector se basa solo en list_title+payload.
 */
function buildDedupKey(
  tipo: string,
  expedienteNumero: string,
  itemId: string | undefined,
): string {
  return `${tipo}:${expedienteNumero}:${itemId ?? 'nokey'}`;
}

/**
 * Mapea confidence (0..1) → priority del evento (Track C levels).
 *   confidence >= 0.85 → 'high'
 *   resto              → 'medium'
 *
 * Las novedades 'critical' (audiencias confirmadas, etc.) no las genera
 * este detector — vienen de otros ingestors. Si en el futuro el detector
 * incluye criterios críticos, agregar un mapeo explícito acá.
 */
function priorityFromConfidence(confidence: number): 'high' | 'medium' {
  return confidence >= 0.85 ? 'high' : 'medium';
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Ejecuta una pasada completa del scan de novedades.
 *
 * Errores:
 *   - Errores fatales (no se pudo listar watchlist) → throw.
 *   - Errores per-watch o per-novedad → log + continue + result.errors++.
 *     El job sigue procesando las watches restantes.
 */
export async function runNoveltyScan(): Promise<NoveltyScanResult> {
  const startMs = Date.now();
  const result: NoveltyScanResult = {
    users: 0,
    expedientes: 0,
    novedades_new: 0,
    novedades_skipped_dup: 0,
    errors: 0,
    duration_ms: 0,
  };

  logger.info('novelty_scan_start', {});

  const sb = supa();

  // ── 1. Lista de usuarios con watches expediente ─────────────────────────
  let userIds: string[] = [];
  try {
    userIds = await listUsersWithExpedienteWatches(sb);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.error('novelty_scan_list_users_failed', { error: message });
    throw err; // fatal — sin watchlist no hay trabajo que hacer
  }
  result.users = userIds.length;

  if (userIds.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.info('novelty_scan_complete_empty', { duration_ms: result.duration_ms });
    return result;
  }

  // ── 2. Iterar por user → sus watches → detectNovedades por exp ──────────
  for (const userId of userIds) {
    let watches: WatchRow[] = [];
    try {
      watches = await listExpedienteWatchesForUser(sb, userId);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.warn('novelty_scan_watches_load_failed', { user_id: userId, error: message });
      result.errors++;
      continue;
    }

    for (const watch of watches) {
      const numero = watch.entity_id.trim();
      result.expedientes++;

      let novedades: Awaited<ReturnType<typeof detectNovedades>> = [];
      try {
        novedades = await detectNovedades(numero);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        logger.warn('novelty_scan_detect_failed', {
          user_id: userId,
          numero,
          error: message,
        });
        result.errors++;
        continue;
      }

      if (novedades.length === 0) continue;

      // ── 3. Persistir cada novedad ───────────────────────────────────────
      for (const novedad of novedades) {
        const dedupKey = buildDedupKey(
          novedad.tipo,
          novedad.expediente_numero,
          novedad.fuentes?.aparece_en?.item_id,
        );

        const priority = priorityFromConfidence(novedad.confidence);

        // upsert con ignoreDuplicates=true. Si el (user_id, dedup_key) ya
        // existe, no inserta y data devuelve []. Contamos el outcome
        // chequeando filas devueltas.
        const { data: inserted, error: insertError } = await sb
          .from('centinela_eventos')
          .upsert(
            {
              user_id: userId,
              event_type: novedad.tipo,
              expediente_id: novedad.expediente_numero,
              priority,
              dedup_key: dedupKey,
              detected_at: new Date().toISOString(),
              source_url: novedad.fuentes?.aparece_en?.payload_url ?? null,
              payload: {
                descripcion: novedad.descripcion,
                algoritmo: novedad.algoritmo,
                confidence: novedad.confidence,
                fuentes: novedad.fuentes,
                fecha_deteccion: novedad.fecha_deteccion,
              },
            },
            { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
          )
          .select('id');

        if (insertError) {
          // Postgres unique violation cuando ignoreDuplicates no la suprimió
          // (caso borde con array partial unique). La tratamos como dup,
          // no como error fatal.
          if (
            (insertError.code === '23505') ||
            /duplicate key/i.test(insertError.message)
          ) {
            result.novedades_skipped_dup++;
            continue;
          }
          logger.warn('novelty_scan_persist_failed', {
            user_id: userId,
            numero,
            tipo: novedad.tipo,
            dedup_key: dedupKey,
            error: insertError.message,
          });
          result.errors++;
          continue;
        }

        // inserted.length === 0 → la fila ya existía (ignoreDuplicates lo
        // saltó). inserted.length === 1 → nueva fila persistida.
        if ((inserted ?? []).length > 0) {
          result.novedades_new++;
        } else {
          result.novedades_skipped_dup++;
        }
      }
    }
  }

  result.duration_ms = Date.now() - startMs;
  logger.info('novelty_scan_complete', {
    users: result.users,
    expedientes: result.expedientes,
    novedades_new: result.novedades_new,
    novedades_skipped_dup: result.novedades_skipped_dup,
    errors: result.errors,
    duration_ms: result.duration_ms,
  });
  return result;
}

// ── Test helpers ─────────────────────────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}
