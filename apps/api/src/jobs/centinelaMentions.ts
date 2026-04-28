/**
 * Centinela mentions scan job.
 *
 * PURPOSE: after a session's transcript is indexed, scan its segments for
 * mentions of watched entities (expedientes and diputados) and generate
 * 'mention' alerts.
 *
 * NOT a cron — triggered by transcriptProcess.ts after marking 'indexed'.
 *
 * PIPELINE:
 *   1. Load transcript_segments for the session
 *   2. Load centinela_watchlist distinct entities (expediente + diputado)
 *   3. For each segment:
 *      - Expedientes: regex \b\d{2,5}\.\d{3}\b to find expediente numbers
 *      - Diputados: case-insensitive substring match (MVP; pg_trgm if needed later)
 *   4. For each match, build alert payload with context_snippet + timecode
 *   5. INSERT alerts with dedup_key `mention:${session_id}:${matched_term}`
 * 6. Return result
 *
 * MODULE CONTRACT:
 *   - Pure async function, no Express coupling.
 *   - Uses service_role Supabase client.
 *   - Idempotent: dedup_key prevents duplicate alerts on re-run.
 *   - Caller (processSession) wraps this in try/catch — a scan failure must
 *     NOT fail the transcript pipeline.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Regex for expediente numbers in Costa Rica: NN.NNN format.
 * Matches 2-5 leading digits + dot + exactly 3 digits.
 * The word boundary ensures we don't match partial numbers (e.g. '124.429' inside '1124.4290').
 */
const EXPEDIENTE_REGEX = /\b(\d{2,5}\.\d{3})\b/g;

/** Context snippet window: chars around the match */
const CONTEXT_WINDOW = 200;

// ── Supabase client (lazy, service role) ─────────────────────────────────────

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      'supabase env missing for centinelaMentions (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface MentionsScanResult {
  session_id: string;
  segments_scanned: number;
  watchlist_size: number;
  alerts_inserted: number;
  duration_ms: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface TranscriptSegmentRow {
  id: string;
  segment_idx: number;
  start_seconds: number;
  text: string;
}

interface SessionRow {
  id: string;
  fecha: string | null;
  youtube_video_id: string | null;
}

interface WatchlistEntry {
  user_id: string;
  entity_type: string; // 'expediente' | 'diputado'
  entity_id: string;   // expediente_numero or diputado display name
  metadata: Record<string, unknown> | null;
}

interface MatchResult {
  matched_term: string;
  match_kind: 'expediente' | 'diputado';
  context_snippet: string;
  match_offset: number; // char offset in text
}

// ── Entity loading ────────────────────────────────────────────────────────────

/**
 * Load session row for youtube_video_id and fecha.
 */
async function loadSession(sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await supa()
    .from('sessions')
    .select('id, fecha, youtube_video_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) throw new Error(`loadSession(${sessionId}): ${error.message}`);
  return data as SessionRow | null;
}

/**
 * Load all transcript_segments for a session, ordered by segment_idx.
 */
async function loadSegments(sessionId: string): Promise<TranscriptSegmentRow[]> {
  const { data, error } = await supa()
    .from('transcript_segments')
    .select('id, segment_idx, start_seconds, text')
    .eq('session_id', sessionId)
    .order('segment_idx', { ascending: true });

  if (error) throw new Error(`loadSegments(${sessionId}): ${error.message}`);
  return (data ?? []) as TranscriptSegmentRow[];
}

/**
 * Load all watchlist entries with entity_type IN ('expediente', 'diputado').
 *
 * For expedientes: entity_id is the expediente number (e.g. '24.429' or '24429').
 *   We normalize to dot-format for matching.
 * For diputados: entity_id is the display name or UUID. We use metadata.display_name
 *   if available (for name matching), falling back to entity_id.
 *
 * Returns two structures:
 *   - expedienteWatchers: Map<normalized_numero, user_id[]>
 *   - diputadoWatchers:   Map<lowercase_name, user_id[]>
 */
async function loadWatchlist(): Promise<{
  expedienteWatchers: Map<string, string[]>;
  diputadoWatchers: Map<string, string[]>;
  totalSize: number;
}> {
  const { data, error } = await supa()
    .from('centinela_watchlist')
    .select('user_id, entity_type, entity_id, metadata')
    .in('entity_type', ['expediente', 'diputado']);

  if (error) throw new Error(`loadWatchlist: ${error.message}`);

  const expedienteWatchers = new Map<string, string[]>();
  const diputadoWatchers = new Map<string, string[]>();

  for (const row of (data ?? []) as WatchlistEntry[]) {
    if (row.entity_type === 'expediente') {
      // Normalize to dot-format: '24429' → '24.429', '24.429' stays
      const normalized = normalizeExpedienteNumero(row.entity_id);
      if (normalized) {
        const existing = expedienteWatchers.get(normalized) ?? [];
        existing.push(row.user_id);
        expedienteWatchers.set(normalized, existing);
      }
    } else if (row.entity_type === 'diputado') {
      // Use metadata.display_name if present, else entity_id
      const displayName: string =
        (typeof row.metadata?.display_name === 'string' ? row.metadata.display_name : null) ??
        row.entity_id;
      if (displayName) {
        const key = displayName.toLowerCase().trim();
        const existing = diputadoWatchers.get(key) ?? [];
        existing.push(row.user_id);
        diputadoWatchers.set(key, existing);
      }
    }
  }

  return {
    expedienteWatchers,
    diputadoWatchers,
    totalSize: expedienteWatchers.size + diputadoWatchers.size,
  };
}

// ── Matching helpers ──────────────────────────────────────────────────────────

/**
 * Normalize an expediente number to dot-format.
 * '24429' → '24.429', '24.429' → '24.429', garbage → null
 */
function normalizeExpedienteNumero(raw: string): string | null {
  const s = raw.trim();
  // Already dotted: NN.NNN
  if (/^\d{2,5}\.\d{3}$/.test(s)) return s;
  // Plain integer: >=5 digits → insert dot 3 from right
  if (/^\d{5,8}$/.test(s)) {
    return s.slice(0, -3) + '.' + s.slice(-3);
  }
  return null;
}

/**
 * Extract a context snippet around a match offset in text.
 * Trims to ±CONTEXT_WINDOW/2 characters, trying to break on word boundaries.
 */
function buildContextSnippet(text: string, offset: number, matchLength: number): string {
  const half = Math.floor(CONTEXT_WINDOW / 2);
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, offset + matchLength + half);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

/**
 * Scan a single segment text for expediente mentions.
 * Returns all matches intersected with the watchlist.
 */
function scanSegmentForExpedientes(
  text: string,
  watchedNumeros: Set<string>,
): Array<{ term: string; offset: number }> {
  const matches: Array<{ term: string; offset: number }> = [];
  // Reset lastIndex before each use (important when reusing the regex)
  EXPEDIENTE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPEDIENTE_REGEX.exec(text)) !== null) {
    const term = m[1]!;
    if (watchedNumeros.has(term)) {
      matches.push({ term, offset: m.index });
    }
  }
  return matches;
}

/**
 * Scan a single segment text for diputado mentions.
 * Uses simple case-insensitive substring matching (MVP).
 * Returns all matches with their offsets.
 */
function scanSegmentForDiputados(
  text: string,
  watchedNames: string[], // lowercase
): Array<{ term: string; offset: number }> {
  const lower = text.toLowerCase();
  const matches: Array<{ term: string; offset: number }> = [];
  for (const name of watchedNames) {
    const idx = lower.indexOf(name);
    if (idx !== -1) {
      // Use original-case term from the text for payload
      matches.push({ term: text.slice(idx, idx + name.length), offset: idx });
    }
  }
  return matches;
}

// ── YouTube URL builder ───────────────────────────────────────────────────────

function buildYouTubeUrl(videoId: string | null, startSeconds: number): string | null {
  if (!videoId) return null;
  return `https://youtube.com/watch?v=${videoId}&t=${Math.floor(startSeconds)}s`;
}

// ── Alert insertion ───────────────────────────────────────────────────────────

/**
 * Insert a 'mention' alert. Idempotent via ON CONFLICT DO NOTHING.
 * One alert per (user, session, matched_term) — covers all occurrences of
 * that term in the session. First occurrence wins for timecode.
 */
async function insertMentionAlert(
  userId: string,
  sessionId: string,
  sessionFecha: string | null,
  match: MatchResult,
  segment: TranscriptSegmentRow,
  youtubeUrl: string | null,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  const dedupKey = `mention:${sessionId}:${match.matched_term}`;

  const { error } = await supa()
    .from('centinela_alerts')
    .upsert(
      {
        user_id: userId,
        entity_type: match.match_kind,
        entity_id: match.matched_term,
        alert_type: 'mention',
        severity: 'info',
        dedup_key: dedupKey,
        payload: {
          session_id: sessionId,
          session_fecha: sessionFecha,
          match_kind: match.match_kind,
          matched_term: match.matched_term,
          context_snippet: match.context_snippet,
          timecode_start_s: segment.start_seconds,
          youtube_url_with_ts: youtubeUrl,
          segment_idx: segment.segment_idx,
        },
      },
      { onConflict: 'user_id,dedup_key', ignoreDuplicates: true },
    );

  if (error)
    throw new Error(`insertMentionAlert(${userId}, ${sessionId}, ${match.matched_term}): ${error.message}`);
  return true;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Scan all transcript segments of a session for entity mentions.
 * Called by transcriptProcess.ts after marking the session as 'indexed'.
 *
 * @param sessionId  UUID of the session to scan.
 * @param opts.dryRun  If true, no DB writes; result counts still accurate.
 */
export async function scanSessionForMentions(
  sessionId: string,
  opts?: { dryRun?: boolean },
): Promise<MentionsScanResult> {
  const dryRun = opts?.dryRun ?? false;
  const startMs = Date.now();

  logger.info('mentions_scan_start', { session_id: sessionId, dryRun });

  const result: MentionsScanResult = {
    session_id: sessionId,
    segments_scanned: 0,
    watchlist_size: 0,
    alerts_inserted: 0,
    duration_ms: 0,
  };

  // ── Step 1: Load session ────────────────────────────────────────────────────
  const session = await loadSession(sessionId);
  if (!session) {
    logger.warn('mentions_scan_session_not_found', { session_id: sessionId });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // ── Step 2: Load segments ───────────────────────────────────────────────────
  const segments = await loadSegments(sessionId);
  result.segments_scanned = segments.length;

  if (segments.length === 0) {
    logger.info('mentions_scan_no_segments', { session_id: sessionId });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // ── Step 3: Load watchlist ──────────────────────────────────────────────────
  const { expedienteWatchers, diputadoWatchers, totalSize } = await loadWatchlist();
  result.watchlist_size = totalSize;

  if (totalSize === 0) {
    logger.info('mentions_scan_empty_watchlist', { session_id: sessionId });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  // Build fast lookup sets
  const watchedNumeros = new Set(expedienteWatchers.keys());
  const watchedDiputadoNames = [...diputadoWatchers.keys()];

  // Track which (user, term) pairs already got an alert this session
  // to de-duplicate in-memory before calling DB (saves round-trips).
  const alertedPairs = new Set<string>(); // `${userId}:${term}`

  // ── Step 4: Scan segments ───────────────────────────────────────────────────
  for (const segment of segments) {
    const { text, start_seconds } = segment;
    if (!text) continue;

    const youtubeUrl = buildYouTubeUrl(session.youtube_video_id, start_seconds);

    // 4a. Expediente mentions
    if (watchedNumeros.size > 0) {
      const expMatches = scanSegmentForExpedientes(text, watchedNumeros);
      for (const { term, offset } of expMatches) {
        const watchers = expedienteWatchers.get(term) ?? [];
        const contextSnippet = buildContextSnippet(text, offset, term.length);
        const matchResult: MatchResult = {
          matched_term: term,
          match_kind: 'expediente',
          context_snippet: contextSnippet,
          match_offset: offset,
        };

        for (const userId of watchers) {
          const pairKey = `${userId}:${term}`;
          if (alertedPairs.has(pairKey)) continue;
          alertedPairs.add(pairKey);

          try {
            const inserted = await insertMentionAlert(
              userId,
              sessionId,
              session.fecha,
              matchResult,
              segment,
              youtubeUrl,
              dryRun,
            );
            if (inserted) result.alerts_inserted++;
          } catch (err) {
            logger.error('mentions_scan_alert_error', {
              session_id: sessionId,
              userId,
              term,
              error: (err as Error)?.message ?? String(err),
            });
            // Non-fatal: continue scanning
          }
        }
      }
    }

    // 4b. Diputado mentions
    if (watchedDiputadoNames.length > 0) {
      const dipMatches = scanSegmentForDiputados(text, watchedDiputadoNames);
      for (const { term, offset } of dipMatches) {
        const lowerTerm = term.toLowerCase();
        const watchers = diputadoWatchers.get(lowerTerm) ?? [];
        const contextSnippet = buildContextSnippet(text, offset, term.length);
        const matchResult: MatchResult = {
          matched_term: term,
          match_kind: 'diputado',
          context_snippet: contextSnippet,
          match_offset: offset,
        };

        for (const userId of watchers) {
          const pairKey = `${userId}:${lowerTerm}`;
          if (alertedPairs.has(pairKey)) continue;
          alertedPairs.add(pairKey);

          try {
            const inserted = await insertMentionAlert(
              userId,
              sessionId,
              session.fecha,
              matchResult,
              segment,
              youtubeUrl,
              dryRun,
            );
            if (inserted) result.alerts_inserted++;
          } catch (err) {
            logger.error('mentions_scan_alert_error', {
              session_id: sessionId,
              userId,
              term,
              error: (err as Error)?.message ?? String(err),
            });
            // Non-fatal: continue scanning
          }
        }
      }
    }
  }

  result.duration_ms = Date.now() - startMs;

  logger.info('mentions_scan_complete', {
    session_id: sessionId,
    segments_scanned: result.segments_scanned,
    watchlist_size: result.watchlist_size,
    alerts_inserted: result.alerts_inserted,
    duration_ms: result.duration_ms,
    dryRun,
  });

  return result;
}

// ── Export for testing ────────────────────────────────────────────────────────
export function _resetSupaClient(): void {
  _supa = null;
}

// Export internals for unit testing
export { normalizeExpedienteNumero, buildContextSnippet, scanSegmentForExpedientes, scanSegmentForDiputados };
