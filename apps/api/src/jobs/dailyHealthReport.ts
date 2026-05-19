/**
 * dailyHealthReport — snapshot diario del estado del backend.
 *
 * Por qué existe:
 *   Antes de este cron, detectar que `centinela-similar-detect` había
 *   estado fallando 3 días con `match_chunks_v2 RPC timeout`, o que
 *   `cl2-novelty-scan` no había detectado novedades en 72h, requería que
 *   un humano abriera Cloud Logging y revisara job por job. Este job
 *   centraliza la observabilidad en una sola corrida diaria:
 *
 *   1. Cuenta filas y mide freshness de las tablas que NO deberían
 *      quedarse stale (sil_expedientes, sil_documentos, etc.).
 *   2. Lee el estado de cada Cloud Scheduler cron (vía gcloud o
 *      directamente desde sus side-effects en DB).
 *   3. Detecta anomalías (e.g. proponentes/expedientes ratio bajo,
 *      tablas con last_insert > N días, count de un seed diferente al
 *      esperado).
 *   4. Persiste un snapshot timestamped en `cl2_daily_health` con
 *      `alerts` jsonb no-vacío cuando hay algo que requiere atención.
 *
 *   El alerting (email / Slack ping cuando alerts.length > 0) queda
 *   como hook a futuro — este job sólo escribe la tabla.
 *
 * Por qué no usar Cloud Monitoring directo:
 *   Cloud Monitoring sirve para métricas de infra (latency, error rate
 *   en endpoints HTTP) pero no entiende "el último expediente fue
 *   indexado hace 3 días". Esas métricas viven en datos del producto,
 *   no en señales de infraestructura. La tabla `cl2_daily_health` es
 *   una capa de business-logic monitoring por encima de la infra.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

const FRESHNESS_THRESHOLDS_HOURS = {
  sil_expedientes_scrape: 36,         // discovery + sync diarios; 36h tolerancia weekend
  sil_documentos_create: 36,          // bulk-download diario
  sessions_create: 7 * 24,            // sesiones cada plenario, máx ~7d sin uno
  transcript_segments_create: 7 * 24, // transcript después de session
  centinela_eventos_detect: 7 * 24,   // depends on legislative activity
} as const;

interface HealthSnapshot {
  taken_at: string;
  sil_expedientes_count: number;
  sil_documentos_count: number;
  sil_documentos_embedded_count: number;
  sil_proponentes_count: number;
  sil_proponentes_with_fraccion: number;
  sessions_indexed_count: number;
  sessions_pending_count: number;
  sessions_rejected_count: number;
  transcript_segments_count: number;
  legislative_chunks_count: number | null; // null si la table es muy grande para count(*)
  centinela_eventos_count: number;
  centinela_eventos_last_24h: number;
  diputados_count: number;
  messages_last_24h: number;
  ai_call_log_last_24h: number;
  sil_expedientes_last_scrape: string | null;
  sil_documentos_last_create: string | null;
  sil_proponentes_last_update: string | null;
  sessions_last_create: string | null;
  transcript_segments_last_create: string | null;
  centinela_eventos_last_detect: string | null;
}

interface HealthAlert {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  table?: string;
  value?: string | number | null;
}

export interface DailyHealthResult {
  status: 'ok' | 'warnings' | 'errors';
  snapshot: HealthSnapshot;
  alerts: HealthAlert[];
  duration_ms: number;
  snapshot_id: string | null;
}

// ── Supabase singleton ───────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for dailyHealthReport');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Helpers ───────────────────────────────────────────────────────────

async function rowCount(table: string, filter?: (q: any) => any): Promise<number> {
  let q = supa().from(table).select('id', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) {
    logger.warn('daily_health_count_error', { table, error: error.message });
    return -1;
  }
  return count ?? 0;
}

async function lastTimestamp(
  table: string,
  column: string,
): Promise<string | null> {
  const { data, error } = await supa()
    .from(table)
    .select(column)
    .order(column, { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn('daily_health_last_ts_error', { table, column, error: error.message });
    return null;
  }
  return (data?.[column as keyof typeof data] as string | null) ?? null;
}

function hoursAgo(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runDailyHealthReport(): Promise<DailyHealthResult> {
  const t0 = Date.now();
  const s = supa();
  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // ── Counts en paralelo ──────────────────────────────────────────
  const [
    silExpedientes,
    silDocumentos,
    silDocsEmbedded,
    silProponentes,
    silProponentesConFraccion,
    sessionsIndexed,
    sessionsPending,
    sessionsRejected,
    transcriptSegments,
    centinelaEventos,
    centinelaEventos24h,
    diputados,
    messages24h,
    aiCallLog24h,
  ] = await Promise.all([
    rowCount('sil_expedientes'),
    rowCount('sil_documentos'),
    rowCount('sil_documentos', (q) => q.eq('status', 'embedded')),
    rowCount('sil_expediente_proponentes'),
    rowCount('sil_expediente_proponentes', (q) => q.not('fraccion', 'is', null)),
    rowCount('sessions', (q) => q.eq('status', 'indexed')),
    rowCount('sessions', (q) => q.eq('status', 'pending')),
    rowCount('sessions', (q) => q.eq('status', 'rejected')),
    rowCount('transcript_segments'),
    rowCount('centinela_eventos'),
    rowCount('centinela_eventos', (q) => q.gte('detected_at', since24h)),
    rowCount('diputados'),
    rowCount('messages', (q) => q.gte('created_at', since24h)),
    rowCount('ai_call_log', (q) => q.gte('created_at', since24h)),
  ]);

  // `legislative_chunks` puede tener >800k rows; el count(*) es caro
  // (sequential scan en pgvector). Dejamos null y solo capturamos el
  // delta diario via INSERT count futuro.
  const legislativeChunks: number | null = null;

  // ── Freshness en paralelo ───────────────────────────────────────
  const [
    silExpScrape,
    silDocCreate,
    silPropUpdate,
    sessCreate,
    segCreate,
    cenEvDetect,
  ] = await Promise.all([
    lastTimestamp('sil_expedientes', 'scraped_at'),
    lastTimestamp('sil_documentos', 'created_at'),
    lastTimestamp('sil_expediente_proponentes', 'expediente_id'), // PK como proxy (no hay updated_at)
    lastTimestamp('sessions', 'created_at'),
    lastTimestamp('transcript_segments', 'created_at'),
    lastTimestamp('centinela_eventos', 'detected_at'),
  ]);

  const snapshot: HealthSnapshot = {
    taken_at: new Date().toISOString(),
    sil_expedientes_count: silExpedientes,
    sil_documentos_count: silDocumentos,
    sil_documentos_embedded_count: silDocsEmbedded,
    sil_proponentes_count: silProponentes,
    sil_proponentes_with_fraccion: silProponentesConFraccion,
    sessions_indexed_count: sessionsIndexed,
    sessions_pending_count: sessionsPending,
    sessions_rejected_count: sessionsRejected,
    transcript_segments_count: transcriptSegments,
    legislative_chunks_count: legislativeChunks,
    centinela_eventos_count: centinelaEventos,
    centinela_eventos_last_24h: centinelaEventos24h,
    diputados_count: diputados,
    messages_last_24h: messages24h,
    ai_call_log_last_24h: aiCallLog24h,
    sil_expedientes_last_scrape: silExpScrape,
    sil_documentos_last_create: silDocCreate,
    sil_proponentes_last_update: silPropUpdate,
    sessions_last_create: sessCreate,
    transcript_segments_last_create: segCreate,
    centinela_eventos_last_detect: cenEvDetect,
  };

  // ── Detección de alertas ────────────────────────────────────────
  const alerts: HealthAlert[] = [];

  const checkFreshness = (
    label: string,
    iso: string | null,
    thresholdHours: number,
    code: string,
  ) => {
    const h = hoursAgo(iso);
    if (h === null) {
      alerts.push({
        level: 'warning',
        code: `${code}_empty`,
        message: `${label} tiene 0 filas o sin timestamp`,
        table: label,
      });
      return;
    }
    if (h > thresholdHours) {
      alerts.push({
        level: 'warning',
        code,
        message: `${label} sin updates hace ${h.toFixed(1)}h (umbral: ${thresholdHours}h)`,
        table: label,
        value: iso,
      });
    }
  };

  checkFreshness('sil_expedientes', silExpScrape, FRESHNESS_THRESHOLDS_HOURS.sil_expedientes_scrape, 'sil_exp_stale');
  checkFreshness('sil_documentos', silDocCreate, FRESHNESS_THRESHOLDS_HOURS.sil_documentos_create, 'sil_docs_stale');
  checkFreshness('sessions', sessCreate, FRESHNESS_THRESHOLDS_HOURS.sessions_create, 'sessions_stale');
  checkFreshness('transcript_segments', segCreate, FRESHNESS_THRESHOLDS_HOURS.transcript_segments_create, 'segments_stale');
  checkFreshness('centinela_eventos', cenEvDetect, FRESHNESS_THRESHOLDS_HOURS.centinela_eventos_detect, 'novedad_stale');

  // Coverage ratios — alertas si bajan
  if (silDocumentos > 0) {
    const embedRate = silDocsEmbedded / silDocumentos;
    if (embedRate < 0.95) {
      alerts.push({
        level: 'warning',
        code: 'docs_embed_rate_low',
        message: `Solo ${(embedRate * 100).toFixed(1)}% de sil_documentos están embedded (${silDocsEmbedded}/${silDocumentos})`,
        value: embedRate,
      });
    }
  }

  if (silProponentes > 0) {
    const fraccionRate = silProponentesConFraccion / silProponentes;
    if (fraccionRate < 0.85) {
      alerts.push({
        level: 'info',
        code: 'proponentes_fraccion_low',
        message: `Solo ${(fraccionRate * 100).toFixed(1)}% de proponentes tienen fracción (${silProponentesConFraccion}/${silProponentes}) — seedear más cuatrienios sube esto`,
        value: fraccionRate,
      });
    }
  }

  // Diputados seed integrity check
  const EXPECTED_DIPUTADOS_MIN = 200; // 5 cuatrienios × ~50 esperados; con tolerancia
  if (diputados < EXPECTED_DIPUTADOS_MIN) {
    alerts.push({
      level: 'error',
      code: 'diputados_seed_broken',
      message: `Seed de diputados tiene solo ${diputados} entradas (esperado ≥${EXPECTED_DIPUTADOS_MIN}). Re-correr scrape-diputados-historic.py.`,
      value: diputados,
    });
  }

  // Errores explícitos durante los counts
  for (const [name, val] of Object.entries(snapshot)) {
    if (typeof val === 'number' && val === -1) {
      alerts.push({
        level: 'error',
        code: 'count_failed',
        message: `Count falló para ${name}`,
        table: name,
      });
    }
  }

  const errors = alerts.filter((a) => a.level === 'error').length;
  const warnings = alerts.filter((a) => a.level === 'warning').length;
  const status: DailyHealthResult['status'] = errors > 0 ? 'errors' : warnings > 0 ? 'warnings' : 'ok';

  // ── Persistir snapshot ──────────────────────────────────────────
  const duration_ms = Date.now() - t0;
  const row = {
    ...snapshot,
    alerts,
    raw_snapshot: snapshot,
    duration_ms,
    source: 'cron' as const,
  };

  let snapshotId: string | null = null;
  try {
    const { data, error } = await s.from('cl2_daily_health').insert(row).select('id').single();
    if (error) {
      logger.error('daily_health_insert_failed', { error: error.message });
    } else {
      snapshotId = (data as { id: string } | null)?.id ?? null;
    }
  } catch (err) {
    logger.error('daily_health_insert_throw', { error: (err as Error).message });
  }

  logger.info('daily_health_complete', {
    status,
    alerts_count: alerts.length,
    errors,
    warnings,
    duration_ms,
    snapshot_id: snapshotId,
  });

  return { status, snapshot, alerts, duration_ms, snapshot_id: snapshotId };
}
