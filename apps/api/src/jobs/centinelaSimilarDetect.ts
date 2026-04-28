/**
 * Centinela similar-expediente detection job.
 *
 * PURPOSE: when a new expediente is detected (during sil-sync or as a standalone
 * run), embed its title+texto-base, compute cosine similarity vs embeddings of
 * watched expedientes, and generate 'similar' alerts when score > threshold.
 *
 * APPROACH: server-side similarity via pgvector's match_chunks_v2 RPC.
 * For each candidate expediente:
 *   1. Fetch its centroid embedding from legislative_chunks (average of its
 *      sil_expediente chunks)
 *   2. Call match_chunks_v2 with filter_source_type='sil_expediente' to find
 *      the top-K similar chunks in the entire corpus
 *   3. Derive the distinct expediente_ids from those chunks' source_ref
 *   4. Intersect with each user's centinela_watchlist
 *   5. For (candidate, watched) pairs above threshold, insert 'similar' alert
 *
 * COST: O(candidates × K) DB round-trips, with K capped at 10.
 * For small watchlists (MVP) and short candidate lists (7d window ≈ <100),
 * this is acceptable. For scale: add pgvector approximate-index + server-side
 * set intersection via a dedicated RPC.
 *
 * MODULE CONTRACT:
 *   - Pure async function, no Express coupling.
 *   - Uses service_role Supabase client.
 *   - Idempotent: dedup_key prevents duplicate alerts on re-run.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_SIMILARITY_THRESHOLD = 0.75;
const DEFAULT_LOOKBACK_DAYS = 7;
const MATCH_CHUNKS_LIMIT = 10; // top-K similar chunks per candidate

// ── Supabase client (lazy, service role) ─────────────────────────────────────

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      'supabase env missing for centinelaSimilarDetect (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SimilarDetectResult {
  candidates_processed: number;
  watchlist_pairs_evaluated: number;
  alerts_inserted: number;
  errors: string[];
  duration_ms: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface SilExpedienteRow {
  id: number;
  numero: string;
  titulo: string | null;
  scraped_at: string;
}

interface ChunkRow {
  chunk_id: string;
  source_ref: string;
  similarity: number;
}

interface WatchlistEntry {
  user_id: string;
  entity_id: string; // numeric id as string
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

/**
 * Resolve candidate expedientes: either the provided IDs or recently-added ones.
 */
async function resolveCandidates(
  candidateIds?: number[],
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<SilExpedienteRow[]> {
  if (candidateIds && candidateIds.length > 0) {
    const { data, error } = await supa()
      .from('sil_expedientes')
      .select('id, numero, titulo, scraped_at')
      .in('id', candidateIds);

    if (error) throw new Error(`resolveCandidates(ids): ${error.message}`);
    return (data ?? []) as SilExpedienteRow[];
  }

  // Recent expedientes: scraped_at > now() - interval
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);

  const { data, error } = await supa()
    .from('sil_expedientes')
    .select('id, numero, titulo, scraped_at')
    .gte('scraped_at', cutoff.toISOString());

  if (error) throw new Error(`resolveCandidates(recent): ${error.message}`);
  return (data ?? []) as SilExpedienteRow[];
}

/**
 * Get the centroid embedding for an expediente from legislative_chunks.
 *
 * We call match_chunks_v2 with a dummy zero-vector is NOT an option —
 * instead we fetch the raw embedding via a direct query on legislative_chunks.
 *
 * Centroid approach: average across all sil_expediente chunks for this expediente.
 * source_ref for sil_expediente chunks follows the pattern 'sil_expediente:<id>'
 * (e.g. 'sil_expediente:24429').
 *
 * Returns null if no chunks exist (expediente not yet embedded).
 *
 * NOTE: Supabase JS client doesn't directly support fetching vector columns as
 * arrays through the REST API in a type-safe way. We use a raw RPC to get the
 * embedding as a float array. If that RPC doesn't exist, we fall back to the
 * match_chunks_v2 approach of passing a known query embedding.
 *
 * For MVP, we use a scalar sub-select workaround: fetch the chunk content and
 * use match_chunks_v2 with a query derived from the chunk content itself.
 * This is a chicken-and-egg problem — we need the embedding to search for
 * similar embeddings. The correct approach is:
 *
 *   Option A: expose a get_chunk_embedding(source_ref) RPC in Postgres
 *   Option B: re-embed the expediente title via Vertex AI at query time
 *   Option C: use Supabase's raw SQL via `.rpc('sql', ...)` (not supported)
 *
 * CHOSEN: Option B for correctness + independence from a new RPC.
 * We embed the expediente titulo using the embedQuery function.
 * If Vertex AI is unavailable, we log a warning and skip the candidate.
 */
async function getExpedienteEmbedding(expediente: SilExpedienteRow): Promise<number[] | null> {
  // Import embedQuery lazily to avoid loading Vertex AI client in tests
  // (tests mock this function directly)
  const { embedQuery } = await import('../services/embeddings.js');

  const text = [
    expediente.titulo ?? '',
    `Expediente número ${expediente.numero}`,
  ]
    .filter(Boolean)
    .join(' — ')
    .trim();

  if (!text) {
    logger.warn('similar_detect_no_text', { expediente_id: expediente.id });
    return null;
  }

  try {
    return await embedQuery(text);
  } catch (err) {
    logger.warn('similar_detect_embed_failed', {
      expediente_id: expediente.id,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
}

/**
 * Find similar expedientes using pgvector's match_chunks_v2.
 * Returns a map from expediente_id (number) to their best similarity score.
 *
 * source_ref for sil_expediente chunks: 'sil_expediente:<id>'
 * We extract the id from the source_ref field.
 */
async function findSimilarExpedientes(
  embedding: number[],
  excludeExpedienteId: number,
  threshold: number,
): Promise<Map<number, number>> {
  // Call match_chunks_v2 via supabase RPC
  const { data, error } = await supa().rpc('match_chunks_v2', {
    query_embedding: embedding,
    match_count: MATCH_CHUNKS_LIMIT,
    filter_session_id: null,
    filter_source_type: 'sil_expediente',
    filter_source_ref_prefix: null,
  });

  if (error) throw new Error(`match_chunks_v2 RPC error: ${error.message}`);

  const resultMap = new Map<number, number>();
  const chunks = (data ?? []) as ChunkRow[];

  for (const chunk of chunks) {
    if (chunk.similarity < threshold) continue;

    // source_ref format: 'sil_expediente:24429'
    const match = chunk.source_ref?.match(/^sil_expediente:(\d+)$/);
    if (!match) continue;

    const expId = Number(match[1]);
    if (expId === excludeExpedienteId) continue; // skip self

    // Keep best (highest) similarity per expediente
    const existing = resultMap.get(expId);
    if (existing === undefined || chunk.similarity > existing) {
      resultMap.set(expId, chunk.similarity);
    }
  }

  return resultMap;
}

/**
 * Load all centinela_watchlist entries for entity_type='expediente'.
 * Returns a map from expediente_id (number) to list of user_ids watching it.
 */
async function loadExpedienteWatchlist(): Promise<Map<number, string[]>> {
  const { data, error } = await supa()
    .from('centinela_watchlist')
    .select('entity_id, user_id')
    .eq('entity_type', 'expediente');

  if (error) throw new Error(`loadExpedienteWatchlist: ${error.message}`);

  const map = new Map<number, string[]>();
  for (const row of (data ?? []) as WatchlistEntry[]) {
    const id = Number(row.entity_id);
    if (!Number.isFinite(id)) continue;
    const existing = map.get(id) ?? [];
    existing.push(row.user_id);
    map.set(id, existing);
  }
  return map;
}

/**
 * Get the numero for a watched expediente (for alert payload).
 * We cache these in a simple map per run.
 */
async function getExpedienteNumero(expedienteId: number): Promise<string | null> {
  const { data, error } = await supa()
    .from('sil_expedientes')
    .select('numero')
    .eq('id', expedienteId)
    .maybeSingle();

  if (error) {
    logger.warn('similar_detect_numero_fetch_error', { expedienteId, error: error.message });
    return null;
  }
  return (data as { numero: string } | null)?.numero ?? null;
}

/**
 * Insert a 'similar' alert for a user. Idempotent via ON CONFLICT DO NOTHING.
 */
async function insertSimilarAlert(
  userId: string,
  candidateExpediente: SilExpedienteRow,
  watchedExpedienteId: number,
  watchedNumero: string,
  similarityScore: number,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  const dedupKey = `similar:${watchedNumero}->${candidateExpediente.numero}`;

  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: 'expediente',
        entity_id: String(candidateExpediente.id),
        alert_type: 'similar',
        severity: 'info',
        dedup_key: dedupKey,
        payload: {
          similar_expediente_id: candidateExpediente.id,
          similar_expediente_numero: candidateExpediente.numero,
          similar_expediente_titulo: candidateExpediente.titulo,
          watched_expediente_id: watchedExpedienteId,
          watched_expediente_numero: watchedNumero,
          similarity_score: Math.round(similarityScore * 1000) / 1000,
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );

  if (error)
    throw new Error(
      `insertSimilarAlert(${userId}, ${candidateExpediente.id}, ${watchedExpedienteId}): ${error.message}`,
    );
  return true;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Detect semantically similar expedientes for watchlist users.
 *
 * @param opts.candidateExpedienteIds  If provided, scan only these expedientes.
 *                                     Otherwise scans recent (last 7d) additions.
 * @param opts.similarityThreshold     Cosine similarity threshold (default 0.75).
 * @param opts.dryRun                  If true, no DB writes.
 */
export async function detectSimilarExpedientes(opts?: {
  candidateExpedienteIds?: number[];
  similarityThreshold?: number;
  dryRun?: boolean;
}): Promise<SimilarDetectResult> {
  const dryRun = opts?.dryRun ?? false;
  const threshold = opts?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const startMs = Date.now();

  logger.info('similar_detect_start', { dryRun, threshold });

  const result: SimilarDetectResult = {
    candidates_processed: 0,
    watchlist_pairs_evaluated: 0,
    alerts_inserted: 0,
    errors: [],
    duration_ms: 0,
  };

  // ── Step 1: Load watchlist ──────────────────────────────────────────────────
  let watchlistMap = new Map<number, string[]>();
  try {
    watchlistMap = await loadExpedienteWatchlist();
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`watchlist_load_failed: ${message}`);
    logger.error('similar_detect_watchlist_error', { error: message });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  if (watchlistMap.size === 0) {
    logger.info('similar_detect_empty_watchlist');
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // ── Step 2: Resolve candidates ──────────────────────────────────────────────
  let candidates: SilExpedienteRow[] = [];
  try {
    candidates = await resolveCandidates(opts?.candidateExpedienteIds);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    result.errors.push(`candidates_resolve_failed: ${message}`);
    logger.error('similar_detect_candidates_error', { error: message });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  if (candidates.length === 0) {
    logger.info('similar_detect_no_candidates');
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // Cache for watched expediente numbers (avoid repeated DB fetches)
  const watchedNumeroCache = new Map<number, string | null>();

  // ── Step 3: Process each candidate ─────────────────────────────────────────
  for (const candidate of candidates) {
    // 3a. Get embedding
    let embedding: number[] | null = null;
    try {
      embedding = await getExpedienteEmbedding(candidate);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      result.errors.push(`embed_failed(${candidate.id}): ${message}`);
      logger.error('similar_detect_embed_error', { expediente_id: candidate.id, error: message });
      continue;
    }

    if (!embedding) {
      logger.warn('similar_detect_no_embedding', { expediente_id: candidate.id });
      continue;
    }

    // 3b. Find similar expedientes via pgvector
    let similarMap = new Map<number, number>();
    try {
      similarMap = await findSimilarExpedientes(embedding, candidate.id, threshold);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      result.errors.push(`similarity_search_failed(${candidate.id}): ${message}`);
      logger.error('similar_detect_search_error', { expediente_id: candidate.id, error: message });
      continue;
    }

    result.candidates_processed++;

    if (similarMap.size === 0) continue;

    // 3c. Intersect similar set with watchlist + emit alerts
    for (const [watchedId, score] of similarMap) {
      const watchers = watchlistMap.get(watchedId);
      if (!watchers || watchers.length === 0) continue;

      // Skip if the candidate is already watched (user knows about it)
      const candidateWatchers = watchlistMap.get(candidate.id);

      // Get watched expediente numero (cached)
      if (!watchedNumeroCache.has(watchedId)) {
        watchedNumeroCache.set(watchedId, await getExpedienteNumero(watchedId));
      }
      const watchedNumero = watchedNumeroCache.get(watchedId);
      if (!watchedNumero) continue;

      for (const userId of watchers) {
        result.watchlist_pairs_evaluated++;

        // Skip if user already watches the candidate itself
        if (candidateWatchers?.includes(userId)) continue;

        try {
          const inserted = await insertSimilarAlert(
            userId,
            candidate,
            watchedId,
            watchedNumero,
            score,
            dryRun,
          );
          if (inserted) result.alerts_inserted++;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          result.errors.push(`alert_insert_failed(${userId},${candidate.id}): ${message}`);
          logger.error('similar_detect_alert_error', {
            userId,
            candidate_id: candidate.id,
            error: message,
          });
        }
      }
    }
  }

  result.duration_ms = Date.now() - startMs;

  logger.info('similar_detect_complete', {
    candidates_processed: result.candidates_processed,
    watchlist_pairs_evaluated: result.watchlist_pairs_evaluated,
    alerts_inserted: result.alerts_inserted,
    errors: result.errors.length,
    duration_ms: result.duration_ms,
    dryRun,
  });

  return result;
}

// ── Export for testing ────────────────────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}
