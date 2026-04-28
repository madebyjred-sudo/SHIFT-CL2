/**
 * Centinela SIL sync job — watchlist-driven expediente state monitoring.
 *
 * DESIGN: Watchlist-driven sync (not corpus crawl).
 *
 * The spec originally described a SharePoint incremental crawl with `modifiedSince`.
 * We pivoted for three reasons:
 *   1. No SharePoint OData client exists — only the WebForms scraper at
 *      silWebFormsClient.ts. Building a new client would take days.
 *   2. Re-scraping 21k expedientes every 30 min is infeasible.
 *   3. We only need to watch what users care about — watchlist size is O(10s)
 *      not O(21k), and cost scales with watchers, not the full corpus.
 *
 * PIPELINE (per cron run):
 *   1. Load distinct expediente entity_ids from centinela_watchlist
 *   2. For each: fetch current estado via WebForms (searchByNumber + selectExpedienteDetail)
 *   3. Diff against sil_expedientes.estado
 *   4. On change: update sil_expedientes + insert centinela_alerts (one per watcher)
 *   5. Recalculate expediente_plazos for changed expedientes
 *   6. For each plazo: check deadline_thresholds per user → emit deadline alerts
 *
 * CONCURRENCY: Sequential per expediente. WebForms is the bottleneck (5-30s per
 * expediente during SIL post-outage recovery). For a watchlist of 100 entities at
 * ~10s avg per expediente = ~17 min. At 30 min cron cadence this is tight but
 * acceptable for MVP. If watchlist grows, introduce p-limit concurrency=3 here.
 *
 * MODULE CONTRACT:
 *   - Pure async function, no Express coupling.
 *   - Uses service_role Supabase client (no user context — this is a job).
 *   - Idempotent: re-running the job at the same state produces 0 net inserts.
 */

import * as cheerio from 'cheerio';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  type WebFormsSession,
} from '../services/silWebFormsClient.js';
import { logger } from '../services/logger.js';

// ── Supabase client (lazy, service role) ─────────────────────────────────────

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      'supabase env missing for centinelaSilSync (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface CentinelaSilSyncResult {
  watchlist_size: number;
  expedientes_checked: number;
  state_changes: Array<{
    expediente_id: number;
    expediente_numero: string;
    from_estado: string;
    to_estado: string;
    affected_users: number;
  }>;
  plazos_recalculated: number;
  alerts_inserted: number;
  errors: Array<{ expediente_id: number; error: string }>;
  duration_ms: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface WatchlistEntry {
  entity_id: string;   // e.g. "24429" (numeric expediente id as text)
  user_id: string;
}

interface SilExpedienteRow {
  id: number;
  numero: string;
  estado: string | null;
}

interface ReglamentoPlazoRow {
  tipo_plazo: string;
  articulo_ref: string;
  estado_disparador: string;
  dias_habiles: number;
}

interface ExpedientePlazoRow {
  tipo_plazo: string;
  dias_restantes: number | null;
  fecha_vencimiento: string;
}

interface UserAlertPrefs {
  user_id: string;
  deadline_thresholds: number[];
}

// ── Business days helper ──────────────────────────────────────────────────────

/**
 * Add N business days to a date, skipping Saturdays (6) and Sundays (0).
 * No Costa Rica public holiday calendar for MVP — weekday-only approximation
 * is sufficient for surfacing alerts at the right order-of-magnitude window.
 *
 * Exported for unit testing.
 */
export function addBusinessDays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

// ── Dedup key helpers ─────────────────────────────────────────────────────────

function stateChangeDedupKey(
  expedienteNumero: string,
  fromEstado: string,
  toEstado: string,
): string {
  return `state_change:${expedienteNumero}:${fromEstado}->${toEstado}`;
}

function deadlineDedupKey(
  expedienteNumero: string,
  tipoPlazo: string,
  thresholdDays: number,
): string {
  return `deadline:${expedienteNumero}:${tipoPlazo}:${thresholdDays}d`;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

/**
 * Load all distinct expediente entity_ids from centinela_watchlist, along with
 * the user_ids watching them. Returns a map from entity_id to list of user_ids.
 */
async function loadWatchlistEntries(
  limit?: number,
): Promise<Map<string, string[]>> {
  let query = supa()
    .from('centinela_watchlist')
    .select('entity_id, user_id')
    .eq('entity_type', 'expediente');

  // If a limit is set, we still need all user_ids per entity. We apply the
  // limit by capping on distinct entity_ids after loading, not via SQL LIMIT
  // (which would cut users arbitrarily).
  const { data, error } = await query;

  if (error) {
    throw new Error(`loadWatchlistEntries: ${error.message}`);
  }

  const rows = (data ?? []) as WatchlistEntry[];
  const map = new Map<string, string[]>();

  for (const row of rows) {
    const existing = map.get(row.entity_id) ?? [];
    existing.push(row.user_id);
    map.set(row.entity_id, existing);
  }

  // Apply limit on distinct entity_ids
  if (limit !== undefined && map.size > limit) {
    const keys = [...map.keys()].slice(0, limit);
    const limited = new Map<string, string[]>();
    for (const k of keys) limited.set(k, map.get(k)!);
    return limited;
  }

  return map;
}

/**
 * Fetch the current stored estado for an expediente from sil_expedientes.
 * Returns null if the row doesn't exist yet (first-time watch).
 */
async function fetchStoredEstado(expedienteId: number): Promise<{ estado: string | null; numero: string } | null> {
  const { data, error } = await supa()
    .from('sil_expedientes')
    .select('id, numero, estado')
    .eq('id', expedienteId)
    .maybeSingle();

  if (error) throw new Error(`fetchStoredEstado(${expedienteId}): ${error.message}`);
  if (!data) return null;

  const row = data as SilExpedienteRow;
  return { estado: row.estado, numero: row.numero };
}

/**
 * Update the sil_expedientes row with a new estado and scraped_at timestamp.
 */
async function updateExpedienteEstado(
  expedienteId: number,
  newEstado: string,
  scraped_at: string,
): Promise<void> {
  const { error } = await supa()
    .from('sil_expedientes')
    .update({ estado: newEstado, scraped_at })
    .eq('id', expedienteId);

  if (error) throw new Error(`updateExpedienteEstado(${expedienteId}): ${error.message}`);
}

/**
 * Insert a state_change alert for a single user. Uses ON CONFLICT DO NOTHING
 * to make this idempotent — re-running the job on the same state change
 * produces 0 net inserts.
 */
async function insertStateChangeAlert(
  userId: string,
  expedienteId: number,
  expedienteNumero: string,
  fromEstado: string,
  toEstado: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  const dedupKey = stateChangeDedupKey(expedienteNumero, fromEstado, toEstado);

  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: 'expediente',
        entity_id: String(expedienteId),
        alert_type: 'state_change',
        severity: 'info',
        dedup_key: dedupKey,
        payload: {
          from: fromEstado,
          to: toEstado,
          expediente_numero: expedienteNumero,
          expediente_id: expedienteId,
          fecha: new Date().toISOString().slice(0, 10),
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );

  if (error) throw new Error(`insertStateChangeAlert(${expedienteId}, ${userId}): ${error.message}`);
  return true;
}

/**
 * Insert a deadline alert for a single user. Idempotent via ON CONFLICT DO NOTHING.
 */
async function insertDeadlineAlert(
  userId: string,
  expedienteId: number,
  expedienteNumero: string,
  tipoPlazo: string,
  articuloRef: string,
  diasRestantes: number,
  fechaVencimiento: string,
  thresholdCrossed: number,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  const dedupKey = deadlineDedupKey(expedienteNumero, tipoPlazo, thresholdCrossed);
  const severity = thresholdCrossed <= 1 ? 'critical' : thresholdCrossed <= 3 ? 'warning' : 'info';

  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: 'expediente',
        entity_id: String(expedienteId),
        alert_type: 'deadline',
        severity,
        dedup_key: dedupKey,
        payload: {
          tipo_plazo: tipoPlazo,
          articulo_ref: articuloRef,
          dias_restantes: diasRestantes,
          fecha_vencimiento: fechaVencimiento,
          expediente_numero: expedienteNumero,
          expediente_id: expedienteId,
          threshold_crossed: thresholdCrossed,
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );

  if (error)
    throw new Error(
      `insertDeadlineAlert(${expedienteId}, ${userId}, ${tipoPlazo}): ${error.message}`,
    );
  return true;
}

/**
 * Load matching reglamento_plazos rules for a given new estado.
 */
async function loadPlazosRules(newEstado: string): Promise<ReglamentoPlazoRow[]> {
  const { data, error } = await supa()
    .from('reglamento_plazos')
    .select('tipo_plazo, articulo_ref, estado_disparador, dias_habiles')
    .eq('estado_disparador', newEstado)
    .eq('activo', true);

  if (error) throw new Error(`loadPlazosRules(${newEstado}): ${error.message}`);
  return (data ?? []) as ReglamentoPlazoRow[];
}

/**
 * Fetch current expediente_plazos rows so we can compare dias_restantes
 * before and after recalculation to detect threshold crossings.
 */
async function fetchCurrentPlazos(expedienteId: number): Promise<Map<string, ExpedientePlazoRow>> {
  const { data, error } = await supa()
    .from('expediente_plazos')
    .select('tipo_plazo, dias_restantes, fecha_vencimiento')
    .eq('expediente_id', expedienteId);

  if (error) throw new Error(`fetchCurrentPlazos(${expedienteId}): ${error.message}`);
  const map = new Map<string, ExpedientePlazoRow>();
  for (const row of (data ?? []) as ExpedientePlazoRow[]) {
    map.set(row.tipo_plazo, row);
  }
  return map;
}

/**
 * Upsert a single expediente_plazos row.
 */
async function upsertPlazo(
  expedienteId: number,
  tipoPlazo: string,
  articuloRef: string,
  fechaInicio: string,
  fechaVencimiento: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;

  const { error } = await supa()
    .from('expediente_plazos')
    .upsert(
      {
        expediente_id: expedienteId,
        tipo_plazo: tipoPlazo,
        articulo_ref: articuloRef,
        fecha_inicio: fechaInicio,
        fecha_vencimiento: fechaVencimiento,
        calculado_en: new Date().toISOString(),
      },
      { onConflict: 'expediente_id,tipo_plazo' },
    );

  if (error) throw new Error(`upsertPlazo(${expedienteId}, ${tipoPlazo}): ${error.message}`);
}

/**
 * Fetch alert prefs for all users watching a given expediente.
 * Users without a prefs row get the default thresholds [1, 3, 7].
 */
async function fetchAlertPrefsForUsers(userIds: string[]): Promise<Map<string, number[]>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await supa()
    .from('centinela_alert_prefs')
    .select('user_id, deadline_thresholds')
    .in('user_id', userIds);

  if (error) throw new Error(`fetchAlertPrefsForUsers: ${error.message}`);

  const map = new Map<string, number[]>();
  // Seed defaults for all users
  for (const uid of userIds) map.set(uid, [1, 3, 7]);
  // Override with stored prefs
  for (const row of (data ?? []) as UserAlertPrefs[]) {
    if (row.deadline_thresholds?.length) {
      map.set(row.user_id, row.deadline_thresholds);
    }
  }
  return map;
}

// ── WebForms fetch for a single expediente ────────────────────────────────────

/**
 * Extract the "Estado" field from the SIL detail panel HTML.
 *
 * `ExpedienteEnriched` (returned by selectExpedienteDetail) does not include
 * `estado` in its type signature — it was scoped to structural fields. We
 * recover it here from the session's `lastHtml` using the same label→value
 * table-scan that buildFieldMap() uses internally in the WebForms client.
 *
 * The field appears as a two-column table row with "Estado" in the first cell.
 * Common values observed on the SIL: "En Comisión", "Archivado", "Convertido en
 * Ley", "En Plenario", "En Secretaría". We lowercase+normalize to snake_case
 * for safe diffing in the DB.
 */
function extractEstadoFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  let estado: string | null = null;
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const label = ($(cells[0]).text() ?? '').trim();
    if (/^estado/i.test(label)) {
      const val = ($(cells[1]).text() ?? '').replace(/\s+/g, ' ').trim();
      if (val) {
        estado = val;
        return false; // break
      }
    }
  });
  return estado;
}

/**
 * Fetch the current estado for a single expediente from the SIL WebForms site.
 *
 * COST: 2 HTTP round-trips (searchByNumber + selectExpedienteDetail).
 * WHY 2: searchByNumber returns only número + título (estado is always null in
 * that path — see parseExpedienteDetail() in silWebFormsClient.ts). The full
 * detail panel (including estado) requires the Select$0 postback via
 * selectExpedienteDetail(). We then extract estado directly from the session
 * lastHtml because ExpedienteEnriched does not expose that field.
 *
 * LATENCY: 5-30s observed (SIL upstream is intermittently slow). With
 * sequential processing, a 100-entity watchlist takes ~17 min at 10s avg.
 * Acceptable for a 30 min cron.
 *
 * Returns null when the expediente is not found on SIL (deleted / merged).
 */
async function fetchCurrentEstadoFromWebForms(
  expedienteNum: number,
): Promise<{ estado: string | null; numero: string } | null> {
  let session: WebFormsSession = await createSession();

  const { session: session2, detail } = await searchByNumber(session, expedienteNum);
  if (!detail) {
    logger.warn('centinela_sil_sync_expediente_not_found', { expedienteNum });
    return null;
  }

  session = session2;

  const { session: session3 } = await selectExpedienteDetail(session, expedienteNum);
  // Extract estado from the rendered detail panel HTML.
  const estado = extractEstadoFromHtml(session3.lastHtml);

  if (!estado) {
    logger.warn('centinela_sil_sync_estado_not_found', { expedienteNum });
  }

  return { estado, numero: detail.numero };
}

// ── Plazo recalculation ───────────────────────────────────────────────────────

/**
 * Recalculate expediente_plazos for a given expediente that just changed to
 * newEstado. Returns the number of plazos upserted and the number of deadline
 * alerts inserted.
 */
async function recalcPlazos(
  expedienteId: number,
  expedienteNumero: string,
  newEstado: string,
  watcherUserIds: string[],
  dryRun: boolean,
): Promise<{ plazosRecalculated: number; alertsInserted: number }> {
  const rules = await loadPlazosRules(newEstado);
  if (rules.length === 0) return { plazosRecalculated: 0, alertsInserted: 0 };

  const fechaInicio = new Date().toISOString().slice(0, 10); // today as ISO date
  const prevPlazos = await fetchCurrentPlazos(expedienteId);
  const userPrefsMap = await fetchAlertPrefsForUsers(watcherUserIds);

  let plazosRecalculated = 0;
  let alertsInserted = 0;

  for (const rule of rules) {
    const fechaVencimientoDate = addBusinessDays(new Date(fechaInicio), rule.dias_habiles);
    const fechaVencimiento = fechaVencimientoDate.toISOString().slice(0, 10);

    // Compute dias_restantes locally (mirrors the DB generated column logic).
    // We use UTC dates to avoid local-timezone drift.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const vencDate = new Date(fechaVencimiento + 'T00:00:00Z');
    const diasRestantes = Math.round((vencDate.getTime() - today.getTime()) / 86_400_000);

    await upsertPlazo(
      expedienteId,
      rule.tipo_plazo,
      rule.articulo_ref,
      fechaInicio,
      fechaVencimiento,
      dryRun,
    );
    plazosRecalculated++;

    // Check if any threshold is crossed for each watcher.
    // A threshold is "crossed" when dias_restantes <= threshold AND either:
    //   a) there was no previous plazo row (new plazo), OR
    //   b) the previous dias_restantes was > threshold (meaning we just entered
    //      the threshold window with this recalculation).
    const prevRow = prevPlazos.get(rule.tipo_plazo);

    for (const userId of watcherUserIds) {
      const thresholds = userPrefsMap.get(userId) ?? [1, 3, 7];

      for (const threshold of thresholds) {
        // Only emit a deadline alert if dias_restantes is AT or BELOW threshold
        // (already in the danger zone) AND the PREVIOUS calculation was ABOVE the
        // threshold (or didn't exist). This prevents re-alerting on every cron run
        // once the window is entered.
        const nowInWindow = diasRestantes >= 0 && diasRestantes <= threshold;
        if (!nowInWindow) continue;

        const prevDiasRestantes = prevRow?.dias_restantes ?? null;
        const wasAboveThreshold =
          prevDiasRestantes === null || prevDiasRestantes > threshold;

        if (wasAboveThreshold) {
          const inserted = await insertDeadlineAlert(
            userId,
            expedienteId,
            expedienteNumero,
            rule.tipo_plazo,
            rule.articulo_ref,
            diasRestantes,
            fechaVencimiento,
            threshold,
            dryRun,
          );
          if (inserted) alertsInserted++;
        }
      }
    }
  }

  return { plazosRecalculated, alertsInserted };
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Run a full watchlist-driven SIL sync cycle.
 *
 * For each distinct expediente in centinela_watchlist:
 *   1. Fetch current estado from SIL WebForms
 *   2. Diff against sil_expedientes.estado
 *   3. On change: update DB + emit state_change alerts (one per watcher)
 *   4. Recalculate plazos + emit deadline alerts for crossed thresholds
 *
 * @param opts.limit   Cap on distinct expedientes to process (for testing/dry runs)
 * @param opts.dryRun  If true, no DB writes are performed; result shows what would change
 */
export async function syncCentinelaWatchlist(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<CentinelaSilSyncResult> {
  const dryRun = opts?.dryRun ?? false;
  const startMs = Date.now();

  logger.info('centinela_sil_sync_start', { dryRun, limit: opts?.limit });

  // ── 1. Load watchlist ───────────────────────────────────────────────────────
  const watchlistMap = await loadWatchlistEntries(opts?.limit);
  const watchlistSize = watchlistMap.size;

  const result: CentinelaSilSyncResult = {
    watchlist_size: watchlistSize,
    expedientes_checked: 0,
    state_changes: [],
    plazos_recalculated: 0,
    alerts_inserted: 0,
    errors: [],
    duration_ms: 0,
  };

  if (watchlistSize === 0) {
    logger.info('centinela_sil_sync_empty_watchlist');
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // ── 2. Process each expediente sequentially ─────────────────────────────────
  for (const [entityId, userIds] of watchlistMap) {
    const expedienteId = Number(entityId);

    if (!Number.isFinite(expedienteId) || expedienteId <= 0) {
      logger.warn('centinela_sil_sync_invalid_entity_id', { entityId });
      result.errors.push({
        expediente_id: expedienteId,
        error: `Invalid entity_id: ${entityId}`,
      });
      continue;
    }

    let liveData: { estado: string | null; numero: string } | null = null;

    // ── 2a. Fetch current estado from WebForms ────────────────────────────────
    try {
      liveData = await fetchCurrentEstadoFromWebForms(expedienteId);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.error('centinela_sil_sync_webforms_error', { expedienteId, error: message });
      result.errors.push({ expediente_id: expedienteId, error: message });
      continue; // per-spec: per-expediente WebForms failure → continue
    }

    if (!liveData) {
      // Expediente not found on SIL (may have been deleted/merged). Skip.
      logger.warn('centinela_sil_sync_not_found_on_sil', { expedienteId });
      continue;
    }

    result.expedientes_checked++;
    const { estado: liveEstado, numero: expedienteNumero } = liveData;

    // ── 2b. Compare with stored estado ────────────────────────────────────────
    let storedRow: { estado: string | null; numero: string } | null = null;
    try {
      storedRow = await fetchStoredEstado(expedienteId);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.error('centinela_sil_sync_db_read_error', { expedienteId, error: message });
      throw err; // DB read failure → throw (cron will retry)
    }

    const storedEstado = storedRow?.estado ?? null;

    // Determine if a state change occurred. We need both a live estado AND a
    // stored estado that differ. If liveEstado is null (SIL didn't return it),
    // skip the diff — we can't assert a change with unknown current state.
    const stateChanged =
      liveEstado !== null &&
      storedEstado !== null &&
      liveEstado !== storedEstado;

    // First-time observation (no stored row yet): store without emitting alerts.
    // We emit alerts only on TRANSITIONS, not on initial ingestion.
    const isFirstSeen = storedRow === null;

    if (isFirstSeen || stateChanged) {
      const now = new Date().toISOString();

      if (!dryRun && liveEstado !== null) {
        try {
          await updateExpedienteEstado(expedienteId, liveEstado, now);
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          logger.error('centinela_sil_sync_update_error', { expedienteId, error: message });
          throw err; // DB write failure → throw
        }
      }
    }

    if (stateChanged && liveEstado !== null && storedEstado !== null) {
      logger.info('centinela_sil_sync_state_change', {
        expedienteId,
        expedienteNumero,
        from: storedEstado,
        to: liveEstado,
        watchers: userIds.length,
      });

      // ── 3. Emit state_change alerts (one per watcher) ──────────────────────
      let alertsForChange = 0;
      try {
        for (const userId of userIds) {
          const inserted = await insertStateChangeAlert(
            userId,
            expedienteId,
            expedienteNumero,
            storedEstado,
            liveEstado,
            dryRun,
          );
          if (inserted) alertsForChange++;
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        logger.error('centinela_sil_sync_alert_insert_error', { expedienteId, error: message });
        throw err; // DB write failure → throw
      }

      result.state_changes.push({
        expediente_id: expedienteId,
        expediente_numero: expedienteNumero,
        from_estado: storedEstado,
        to_estado: liveEstado,
        affected_users: userIds.length,
      });
      result.alerts_inserted += alertsForChange;

      // ── 4. Recalculate plazos ──────────────────────────────────────────────
      try {
        const { plazosRecalculated, alertsInserted: deadlineAlerts } =
          await recalcPlazos(
            expedienteId,
            expedienteNumero,
            liveEstado,
            userIds,
            dryRun,
          );
        result.plazos_recalculated += plazosRecalculated;
        result.alerts_inserted += deadlineAlerts;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        logger.error('centinela_sil_sync_plazo_error', { expedienteId, error: message });
        throw err; // DB write failure → throw
      }
    }
  }

  result.duration_ms = Date.now() - startMs;

  logger.info('centinela_sil_sync_complete', {
    watchlist_size: result.watchlist_size,
    expedientes_checked: result.expedientes_checked,
    state_changes: result.state_changes.length,
    plazos_recalculated: result.plazos_recalculated,
    alerts_inserted: result.alerts_inserted,
    errors: result.errors.length,
    duration_ms: result.duration_ms,
    dryRun,
  });

  return result;
}
