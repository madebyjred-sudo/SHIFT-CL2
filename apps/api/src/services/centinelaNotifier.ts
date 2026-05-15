/**
 * centinelaNotifier.ts
 *
 * Persiste matches como alertas en `centinela_alerts_v2` y (en el futuro)
 * dispara notificaciones al canal correspondiente del usuario.
 *
 * Diseño:
 *  - UPSERT por (user_id, event_id) → idempotente incluso si el engine
 *    corre varias veces antes de que el estado cambie.
 *  - El email channel queda como STUB en este sprint (TODO comentado).
 *  - Log estructurado para auditoría (qué matches, cuántos).
 *
 * Author: Jred / Claude Code — 2026-05-14
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  evaluateMatches,
  type CentinelaEvento,
  type Match,
} from './centinelaMatchEngine.js';
import { logger } from './logger.js';

// ─── Persistencia ────────────────────────────────────────────────────────────

/**
 * Persiste una lista de matches como rows en `centinela_alerts_v2`.
 * Usa ON CONFLICT DO NOTHING para la constraint (user_id, event_id) —
 * si la alerta ya existe, simplemente no se duplica.
 */
export async function notifyMatches(
  matches: Match[],
  evento: CentinelaEvento,
  supabase: SupabaseClient,
): Promise<{ persisted: number; skipped: number }> {
  if (matches.length === 0) {
    return { persisted: 0, skipped: 0 };
  }

  const rows = matches.map((m) => ({
    user_id: m.user_id,
    event_id: evento.id,
    watch_id: m.watch_id,
    priority: m.priority,
    title: m.title,
    body: m.body,
    delivered_at: new Date().toISOString(),
    channel: 'in_app',
  }));

  // Usamos upsert con ignoreDuplicates=true para que ON CONFLICT (user_id,event_id)
  // sea silencioso. Supabase traduce esto a INSERT ... ON CONFLICT DO NOTHING.
  const { data, error } = await supabase
    .from('centinela_alerts_v2')
    .upsert(rows, {
      onConflict: 'user_id,event_id',
      ignoreDuplicates: true,
    })
    .select('id');

  if (error) {
    logger.error('centinela_notifier_persist_failed', {
      event_id: evento.id,
      event_type: evento.event_type,
      matches_attempted: matches.length,
      error: error.message,
    });
    throw new Error(`notifyMatches: DB error — ${error.message}`);
  }

  const persisted = (data ?? []).length;
  const skipped = matches.length - persisted;

  logger.info('centinela_notifier_persisted', {
    event_id: evento.id,
    event_type: evento.event_type,
    priority: evento.priority,
    expediente_id: evento.expediente_id ?? null,
    matches: matches.length,
    persisted,
    skipped,
  });

  // TODO (Sprint 2): Disparar email para usuarios con channel='email' o 'both'.
  // Paso previo: consultar centinela_alert_prefs para saber canal preferido.
  // Usar un queue (Cloud Tasks / simple HTTP) para no bloquear el cron.
  // Ejemplo de lo que va acá:
  //
  //   const emailUsers = matches.filter(m => shouldSendEmail(m.user_id, prefs));
  //   if (emailUsers.length > 0) {
  //     await enqueueEmailBatch(emailUsers, evento);
  //   }

  return { persisted, skipped };
}

// ─── Función principal de dispatch ─────────────────────────────────────────

/**
 * Pipeline completo para un evento:
 *  1. Evalúa matches contra watchlist.
 *  2. Persiste alertas en centinela_alerts_v2.
 *  3. Retorna estadísticas.
 *
 * Esta función es el entry point del crawler/cron cuando detecta un evento nuevo.
 *
 * Uso típico:
 *   const stats = await dispatchEvent(evento, supabaseServiceClient);
 *   console.log(`${stats.matches} matches, ${stats.persisted} alertas nuevas`);
 */
export async function dispatchEvent(
  evento: CentinelaEvento,
  supabase: SupabaseClient,
): Promise<{ matches: number; persisted: number; skipped: number }> {
  logger.info('centinela_dispatch_start', {
    event_id: evento.id,
    event_type: evento.event_type,
    priority: evento.priority,
    expediente_id: evento.expediente_id ?? null,
  });

  const matches = await evaluateMatches(evento, supabase);

  if (matches.length === 0) {
    logger.info('centinela_dispatch_no_matches', {
      event_id: evento.id,
      event_type: evento.event_type,
    });
    return { matches: 0, persisted: 0, skipped: 0 };
  }

  const { persisted, skipped } = await notifyMatches(matches, evento, supabase);

  return { matches: matches.length, persisted, skipped };
}

// ─── Helper: insertar evento + despachar en una llamada ────────────────────

/**
 * Inserta un evento nuevo en `centinela_eventos` y luego lo despacha.
 * Conveniente para el crawler cuando detecta un item nuevo del SharePoint.
 *
 * El evento se inserta con service_role (bypass RLS).
 * Se usa upsert para que el crawler sea idempotente si re-procesa un item.
 *
 * Retorna el evento tal como quedó en la BD (con el UUID asignado).
 */
export async function insertAndDispatch(
  eventData: Omit<CentinelaEvento, 'id'>,
  supabase: SupabaseClient,
): Promise<{ evento: CentinelaEvento; matches: number; persisted: number }> {
  const { data, error } = await supabase
    .from('centinela_eventos')
    .insert({
      event_type: eventData.event_type,
      priority: eventData.priority,
      expediente_id: eventData.expediente_id ?? null,
      payload: eventData.payload,
      source_url: eventData.source_url ?? null,
      comision: eventData.comision ?? null,
      diputado: eventData.diputado ?? null,
      materia: eventData.materia ?? null,
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`insertAndDispatch: insert failed — ${error?.message ?? 'no data returned'}`);
  }

  const evento = data as unknown as CentinelaEvento;
  const stats = await dispatchEvent(evento, supabase);

  return {
    evento,
    matches: stats.matches,
    persisted: stats.persisted,
  };
}
