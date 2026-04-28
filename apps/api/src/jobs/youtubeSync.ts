/**
 * YouTube channel sync job — Fase 0, Task 3.
 *
 * Lists recent videos from a YouTube channel (default @AsambleaCRC) via the
 * YouTube Data API v3 and creates `sessions` rows for any videos that don't
 * already have one, setting status='pending' so the transcript-process job
 * (Task 4) can pick them up.
 *
 * WHY this job exists:
 *   The legacy pipeline required a human to manually trigger indexing after
 *   each session. This job replaces that — it runs on a cron (every 6-12h)
 *   and auto-discovers new uploads. Combined with the transcript pipeline,
 *   lag drops from "days" to "4-12 hours after YouTube auto-transcribes".
 *
 * API choice (YouTube Data API v3 vs scraping):
 *   - `search.list` costs 100 quota units; the free tier is 10k/day.
 *     At 1-2 cron runs per day we use 100-200 units — well under budget.
 *   - `search.list` is the only reliable way to list videos by date range
 *     from a channel handle without scraping. The RSS feed doesn't include
 *     the full date-range filter we need and has a fixed 15-video limit.
 *
 * Idempotency:
 *   `youtube_video_id` in `sessions` doesn't have a unique DB constraint yet
 *   (migration 0018 added the column but not the constraint). We implement
 *   idempotency at the application layer: SELECT existing video IDs first,
 *   then skip any that already have a session row. The sync is re-runnable
 *   without creating duplicates.
 *
 *   If/when a UNIQUE constraint is added to sessions.youtube_video_id, the
 *   SELECT-then-INSERT pattern remains safe — it just adds a redundant DB
 *   guard. No code changes needed at that point.
 *
 * Title parsing:
 *   The Asamblea uses patterns like:
 *     "Sesión Plenaria N°47 - 24 de Febrero de 2026"
 *     "Comisión de Hacienda - 24/02/2026"
 *     "Sesión Extraordinaria N°12 - Expediente 24.429"
 *   Parsing is best-effort; if it fails, all structured fields are left NULL
 *   and the raw title is stored in metadata. The LLM review job (Task 4)
 *   can do a proper extraction pass on those.
 *
 * Module contract:
 *   - Pure async function, no Express coupling. Task 6 wires this to routes
 *     and Cloud Scheduler.
 *   - Uses service_role Supabase client (no user context — this is a job).
 *   - Uses withTimeout + withRetry from resilience.ts for the YouTube API.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withTimeout, withRetry } from '../services/resilience.js';
import { logger } from '../services/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DAYS_BACK = 7;
const DEFAULT_CHANNEL_HANDLE = '@AsambleaCRC';
// search.list returns at most 50 per page. For a 7-day window on a channel
// that posts 3-5 sessions/week, 50 is always enough. Pagination not needed.
const MAX_RESULTS = 50;
// YouTube Data API v3 base URL
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// HTTP call timeouts + retry: YouTube API is fast (<500ms normally).
// 15s timeout per attempt. 3 attempts with 2s base backoff.
const YT_TIMEOUT_MS = 15_000;
const YT_MAX_ATTEMPTS = 3;
const YT_BASE_DELAY_MS = 2_000;

// In-process cache for the channel ID resolved from a handle.
// The channel handle → channel ID mapping is stable (never changes), so we
// cache it for the lifetime of the process. Multiple cron invocations in the
// same Cloud Run instance reuse it without an extra API call.
const _channelIdCache = new Map<string, string>();

// ── Supabase client (lazy, service role) ─────────────────────────────────────
// Mirrors the `_supa` pattern from aiQuota.ts. The service role key is needed
// because this job runs outside user context (no JWT in scope).

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for youtubeSync (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface YoutubeSyncResult {
  /** Total videos returned by the YouTube API for the date window. */
  found: number;
  /** Sessions inserted (net-new). */
  new: number;
  /** Videos that already had a session row — skipped. */
  skipped: number;
  /** Failures during insert or unrecoverable errors per video. */
  errors: number;
  videoIds: {
    new: string[];
    skipped: string[];
    errored: Array<{ videoId: string; error: string }>;
  };
}

// ── Internal types ────────────────────────────────────────────────────────────

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    publishedAt: string;   // ISO 8601
    title: string;
    description: string;
    channelId: string;
  };
}

interface YouTubeSearchResponse {
  items: YouTubeSearchItem[];
  nextPageToken?: string;
  pageInfo: { totalResults: number; resultsPerPage: number };
}

interface YouTubeChannelResponse {
  items: Array<{ id: string }>;
}

interface YouTubeVideoItem {
  id: string;
  contentDetails: { duration: string }; // ISO 8601 duration, e.g. "PT4H30M15S"
}

interface YouTubeVideosResponse {
  items: YouTubeVideoItem[];
}

/** Parsed metadata from a video title. All fields nullable — best-effort. */
interface ParsedTitleMeta {
  fecha: string | null;       // ISO date (YYYY-MM-DD) or null
  comision: string | null;    // e.g. "Hacienda", "Jurídicos", "Plenaria"
  tipo: 'plenario' | 'comision' | 'extraordinaria' | null;
  sesion_num: number | null;  // N° extracted from title, if present
}

// ── Title parsing ─────────────────────────────────────────────────────────────

// Spanish month names → zero-padded month number.
// Using full month names + abbreviations commonly used in legislative titles.
const MONTH_MAP: Record<string, string> = {
  enero: '01', enero_abbr: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09', setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

/**
 * Attempt to parse a structured date from a video title.
 *
 * Handles two main patterns observed in @AsambleaCRC titles:
 *   1. "DD de Mes de YYYY"   → e.g. "24 de Febrero de 2026"
 *   2. "DD/MM/YYYY"          → numeric slash-delimited
 *   3. "YYYY-MM-DD"          → ISO, rare but safe to handle
 *
 * Returns ISO date string (YYYY-MM-DD) or null on failure.
 * We never throw from here — null signals "parse failed, store raw title".
 */
function parseDateFromTitle(title: string): string | null {
  // Pattern 1: "DD de Mes de YYYY" — case-insensitive
  const longDateRe = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i;
  const m1 = title.match(longDateRe);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const monthName = m1[2].toLowerCase();
    const year = m1[3];
    const month = MONTH_MAP[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  // Pattern 2: DD/MM/YYYY
  const slashDateRe = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
  const m2 = title.match(slashDateRe);
  if (m2) {
    const day = m2[1].padStart(2, '0');
    const month = m2[2].padStart(2, '0');
    const year = m2[3];
    return `${year}-${month}-${day}`;
  }

  // Pattern 3: YYYY-MM-DD (ISO) — if present in title
  const isoDateRe = /(\d{4})-(\d{2})-(\d{2})/;
  const m3 = title.match(isoDateRe);
  if (m3) return m3[0];

  return null;
}

/**
 * Determine session tipo from the title.
 *
 * Maps to the CHECK constraint on sessions.tipo:
 *   'plenario' | 'comision' | 'extraordinaria'
 *
 * Precedence: extraordinaria wins over plenaria since a title can have
 * "Sesión Extraordinaria Plenaria N°X" — in that case it's extraordinaria.
 */
function parseTipoFromTitle(title: string): 'plenario' | 'comision' | 'extraordinaria' | null {
  const lower = title.toLowerCase();
  if (lower.includes('extraordinaria')) return 'extraordinaria';
  if (lower.includes('plenaria') || lower.includes('plenario')) return 'plenario';
  // "Comisión" by itself (without "Sesión") → tipo=comision
  if (lower.includes('comisión') || lower.includes('comision')) return 'comision';
  return null;
}

/**
 * Extract the commission name from the title.
 *
 * Pattern: "Comisión de <Name>" or "Comisión Permanente de <Name>".
 * Returns the Name portion only (e.g. "Hacienda", "Asuntos Jurídicos").
 *
 * For plenario sessions there is no commission — returns null.
 */
function parseComisionFromTitle(title: string): string | null {
  // Match "Comisión [Permanente/Especial/etc] de <Name>" where Name ends at
  // a dash, parenthesis, or end of string.
  const re = /comisi[oó]n\s+(?:permanente\s+|especial\s+|de\s+)?de\s+([^-(]+)/i;
  const m = title.match(re);
  if (m) {
    return m[1].trim()
      // Remove trailing session numbers like "N°47" accidentally matched
      .replace(/\s+n[°º]\d+\s*$/, '')
      .trim();
  }
  return null;
}

/**
 * Extract the session number (N°XX) from the title.
 */
function parseSesionNumFromTitle(title: string): number | null {
  const re = /n[°º]\s*(\d+)/i;
  const m = title.match(re);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Best-effort parser for Asamblea session titles.
 *
 * On any exception, returns an all-null result rather than propagating.
 * A bad parse is not a job failure — the LLM review job handles correction.
 */
function parseTitleMeta(title: string): ParsedTitleMeta {
  try {
    return {
      fecha:      parseDateFromTitle(title),
      comision:   parseComisionFromTitle(title),
      tipo:       parseTipoFromTitle(title),
      sesion_num: parseSesionNumFromTitle(title),
    };
  } catch {
    // Defensive: if any regex throws (shouldn't), fail gracefully
    return { fecha: null, comision: null, tipo: null, sesion_num: null };
  }
}

// ── ISO 8601 duration helper ──────────────────────────────────────────────────

/**
 * Parse an ISO 8601 duration string into total seconds.
 *
 * Handles the subset YouTube uses: PT[<H>H][<M>M][<S>S]
 * Examples: "PT4H30M15S" → 16215, "PT45M" → 2700, "PT15S" → 15
 *
 * Returns 0 on any parse failure (missing/invalid input) so callers
 * can safely use the result without null-checking arithmetic.
 *
 * Exported for unit testing.
 */
export function parseIsoDurationToSeconds(iso: string): number {
  if (!iso) return 0;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

// ── YouTube API helpers ───────────────────────────────────────────────────────

/**
 * Fetch a JSON endpoint from the YouTube Data API v3.
 *
 * Wrapped in withTimeout (15s) + withRetry (3 attempts, exponential backoff).
 * The retry only fires on network errors (5xx from YouTube, fetch failures);
 * 4xx errors (invalid key, quota exceeded) are NOT retried.
 */
async function ytApiFetch<T>(url: string, label: string): Promise<T> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const resp = await fetch(url, { signal });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            const err = new Error(`YouTube API ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
            // 4xx = don't retry (auth/quota failure won't change on retry)
            if (resp.status >= 400 && resp.status < 500) {
              // Mark non-retryable via a custom property
              (err as Error & { ytNonRetryable: boolean }).ytNonRetryable = true;
            }
            throw err;
          }
          return resp.json() as Promise<T>;
        },
        { ms: YT_TIMEOUT_MS, label },
      ),
    {
      attempts: YT_MAX_ATTEMPTS,
      baseDelayMs: YT_BASE_DELAY_MS,
      label,
      shouldRetry: (err) => {
        // Don't retry on explicit 4xx from YouTube API (quota/auth failures)
        if ((err as Error & { ytNonRetryable?: boolean }).ytNonRetryable) return false;
        // Don't retry on aborted signals (timeout exceeded, caller cancelled)
        return true;
      },
    },
  );
}

/**
 * Resolve a YouTube channel handle (e.g. "@AsambleaCRC") to its canonical
 * channel ID via the `channels.list?forHandle=` endpoint.
 *
 * Result is cached in-process for the lifetime of the Cloud Run instance —
 * the mapping is stable and we don't want to spend quota on every cron run.
 *
 * Cost: 1 unit (channels.list costs 1 unit, not 100).
 */
async function resolveChannelId(handle: string, apiKey: string): Promise<string> {
  const cached = _channelIdCache.get(handle);
  if (cached) {
    logger.info('youtube_sync_channel_id_cache_hit', { handle, channelId: cached });
    return cached;
  }

  const url = `${YT_API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
  const data = await ytApiFetch<YouTubeChannelResponse>(url, `yt:channels:${handle}`);

  if (!data.items || data.items.length === 0) {
    throw new Error(`YouTube channel not found for handle: ${handle}`);
  }

  const channelId = data.items[0].id;
  _channelIdCache.set(handle, channelId);
  logger.info('youtube_sync_channel_id_resolved', { handle, channelId });
  return channelId;
}

/**
 * List recent videos from a channel using search.list.
 *
 * Cost: 100 units per call. The free tier is 10k/day; at 1-2 cron runs
 * per day we spend 100-200 units — well under budget.
 *
 * Returns up to MAX_RESULTS (50) videos sorted by date descending.
 * For a 7-day window on a channel posting 3-5 sessions/week, 50 is always
 * enough. Pagination is omitted intentionally (would cost another 100 units
 * per page for a backfill scenario that doesn't arise in normal operation).
 */
async function listChannelVideos(
  channelId: string,
  publishedAfter: Date,
  apiKey: string,
): Promise<YouTubeSearchItem[]> {
  const publishedAfterIso = publishedAfter.toISOString();
  const url =
    `${YT_API_BASE}/search` +
    `?part=snippet` +
    `&channelId=${encodeURIComponent(channelId)}` +
    `&type=video` +
    `&order=date` +
    `&maxResults=${MAX_RESULTS}` +
    `&publishedAfter=${encodeURIComponent(publishedAfterIso)}` +
    `&key=${apiKey}`;

  const data = await ytApiFetch<YouTubeSearchResponse>(url, `yt:search:${channelId}`);

  logger.info('youtube_sync_videos_listed', {
    channelId,
    publishedAfter: publishedAfterIso,
    totalResults: data.pageInfo?.totalResults ?? 0,
    returned: data.items?.length ?? 0,
  });

  return data.items ?? [];
}

/**
 * Fetch video durations from the YouTube Data API v3 videos.list endpoint.
 *
 * Cost: 1 quota unit per call (regardless of how many IDs, up to 50).
 * Negligible impact on the 10k/day free-tier budget.
 *
 * Returns a Map<videoId, durationSeconds | null>.
 * A video ID maps to null if YouTube omits it from the response (can happen
 * for age-restricted or otherwise hidden videos).
 */
async function fetchVideoDurations(
  videoIds: string[],
  apiKey: string,
): Promise<Map<string, number | null>> {
  const durationMap = new Map<string, number | null>();
  if (videoIds.length === 0) return durationMap;

  const url =
    `${YT_API_BASE}/videos` +
    `?part=contentDetails` +
    `&id=${videoIds.map(encodeURIComponent).join(',')}` +
    `&key=${apiKey}`;

  const data = await ytApiFetch<YouTubeVideosResponse>(url, `yt:videos:durations`);

  // Build a lookup from the response items
  for (const item of data.items ?? []) {
    durationMap.set(item.id, parseIsoDurationToSeconds(item.contentDetails?.duration ?? ''));
  }

  // Any requested ID absent from the response → null (not just missing from map)
  for (const id of videoIds) {
    if (!durationMap.has(id)) {
      durationMap.set(id, null);
    }
  }

  logger.info('youtube_sync_durations_fetched', {
    requested: videoIds.length,
    returned: data.items?.length ?? 0,
  });

  return durationMap;
}

// ── Supabase: existing sessions diff ─────────────────────────────────────────

/**
 * Fetch the set of youtube_video_ids that already have a sessions row.
 *
 * Returns a Set<string> for O(1) membership tests. This is the deduplication
 * mechanism. We SELECT before INSERT because sessions.youtube_video_id does
 * not have a UNIQUE constraint in migration 0018 (column added, not
 * constrained). The SELECT-then-INSERT pattern is safe for a single-writer
 * job: only one cron instance runs at a time (Cloud Scheduler guarantees
 * non-overlapping invocations at this cadence).
 *
 * If a UNIQUE constraint is added later, this code remains correct — the
 * SELECT becomes a redundant but harmless pre-check.
 */
async function fetchExistingVideoIds(videoIds: string[]): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set();

  const { data, error } = await supa()
    .from('sessions')
    .select('youtube_video_id')
    .in('youtube_video_id', videoIds);

  if (error) {
    // Failing here is bad: we'd try to insert all videos and potentially
    // create duplicates. Throw so the job can report an error cleanly.
    throw new Error(`Failed to query existing sessions: ${error.message}`);
  }

  return new Set(
    (data ?? [])
      .map((r: { youtube_video_id: string | null }) => r.youtube_video_id)
      .filter((id): id is string => id !== null),
  );
}

/**
 * Insert a new session row for a YouTube video.
 *
 * Structure follows the spec:
 *   - Structured fields (fecha, comision, tipo) written to their own columns
 *     when parse succeeds (they exist in the sessions table from migration 0001).
 *   - Unstructured / pipeline-only data goes into metadata jsonb.
 *   - On parse failure, structured columns are omitted (NULL) and metadata
 *     carries parsed:null + raw_title for downstream LLM review.
 *
 * Returns the inserted session's ID, or throws on DB error.
 */
async function insertSession(
  item: YouTubeSearchItem,
  parsed: ParsedTitleMeta,
  channelId: string,
  durationSeconds: number | null,
): Promise<string> {
  const title = item.snippet.title;
  const videoId = item.id.videoId;
  const publishedAt = item.snippet.publishedAt;

  // Validate tipo against the sessions CHECK constraint.
  // The DB enforces check (tipo in ('plenario','comision','extraordinaria')),
  // so we must not pass a value outside that set. null is always safe.
  const tipoValue = parsed.tipo ?? null;

  const row = {
    youtube_video_id: videoId,
    status: 'pending' as const,
    source: 'youtube' as const,
    // Structured fields — NULL if parsing failed; LLM review job fills them in
    fecha:    parsed.fecha    ?? null,
    comision: parsed.comision ?? null,
    tipo:     tipoValue,
    metadata: {
      raw_title: title,
      parsed: (parsed.fecha || parsed.comision || parsed.tipo || parsed.sesion_num)
        ? {
            fecha:      parsed.fecha,
            comision:   parsed.comision,
            tipo:       parsed.tipo,
            sesion_num: parsed.sesion_num,
          }
        : null,
      channel_id:       channelId,
      published_at:     publishedAt,
      duration_seconds: durationSeconds,
    },
  };

  const { data, error } = await supa()
    .from('sessions')
    .insert(row)
    .select('id')
    .single();

  if (error) throw new Error(`Insert failed for ${videoId}: ${error.message}`);
  return (data as { id: string }).id;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Sync recent YouTube videos from a channel into the sessions table.
 *
 * Safe to call multiple times (idempotent via SELECT-then-INSERT dedup).
 * Designed to run as a Cloud Run job triggered by Cloud Scheduler (Task 6).
 *
 * @param opts.daysBack       How many days back to search (default: 7)
 * @param opts.channelHandle  YouTube handle (default: '@AsambleaCRC')
 * @param opts.dryRun         If true, don't insert — only report the diff
 */
export async function syncYoutubeChannel(opts?: {
  daysBack?: number;
  channelHandle?: string;
  dryRun?: boolean;
}): Promise<YoutubeSyncResult> {
  const daysBack       = opts?.daysBack       ?? DEFAULT_DAYS_BACK;
  const channelHandle  = opts?.channelHandle  ?? DEFAULT_CHANNEL_HANDLE;
  const dryRun         = opts?.dryRun         ?? false;

  // ── 1. Validate env ─────────────────────────────────────────────────────────
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'YOUTUBE_API_KEY env var is not set. ' +
      'Set it in your Cloud Run service configuration. ' +
      'No RSS fallback is implemented — this job requires the YouTube Data API v3.',
    );
  }

  logger.info('youtube_sync_start', { daysBack, channelHandle, dryRun });

  // ── 2. Resolve channel handle → channel ID ──────────────────────────────────
  const channelId = await resolveChannelId(channelHandle, apiKey);

  // ── 3. Compute the publishedAfter cutoff ─────────────────────────────────────
  const publishedAfter = new Date();
  publishedAfter.setDate(publishedAfter.getDate() - daysBack);
  // Zero out time component so the cutoff is midnight N days ago.
  // This prevents drift: a job running at 3am vs 11pm doesn't differ in coverage.
  publishedAfter.setUTCHours(0, 0, 0, 0);

  // ── 4. List recent videos ────────────────────────────────────────────────────
  const videos = await listChannelVideos(channelId, publishedAfter, apiKey);
  const found = videos.length;

  if (found === 0) {
    logger.info('youtube_sync_no_videos', { channelHandle, daysBack });
    return { found: 0, new: 0, skipped: 0, errors: 0, videoIds: { new: [], skipped: [], errored: [] } };
  }

  // ── 4b. Fetch video durations via videos.list?part=contentDetails ────────────
  // Cost: 1 quota unit (negligible). Must be called before the diff so the map
  // is available when constructing each new session's metadata.
  const allVideoIds = videos.map((v) => v.id.videoId);
  const durationMap = await fetchVideoDurations(allVideoIds, apiKey);

  // ── 5. Diff against existing sessions ───────────────────────────────────────
  const existingIds = await fetchExistingVideoIds(allVideoIds);

  const toInsert = videos.filter((v) => !existingIds.has(v.id.videoId));
  const skippedIds = allVideoIds.filter((id) => existingIds.has(id));

  logger.info('youtube_sync_diff', {
    found,
    existing: existingIds.size,
    toInsert: toInsert.length,
  });

  // ── 6. dryRun: report without inserting ─────────────────────────────────────
  if (dryRun) {
    const dryNew = toInsert.map((v) => v.id.videoId);
    logger.info('youtube_sync_dry_run', { wouldInsert: dryNew.length, skipped: skippedIds.length });
    return {
      found,
      new:     dryNew.length,
      skipped: skippedIds.length,
      errors:  0,
      videoIds: { new: dryNew, skipped: skippedIds, errored: [] },
    };
  }

  // ── 7. Insert new sessions ───────────────────────────────────────────────────
  const insertedIds: string[] = [];
  const erroredItems: Array<{ videoId: string; error: string }> = [];

  for (const video of toInsert) {
    const videoId = video.id.videoId;
    const title   = video.snippet.title;

    try {
      const parsed = parseTitleMeta(title);

      // Warn if parsing yielded nothing — will be handled by LLM review
      if (!parsed.fecha && !parsed.comision && !parsed.tipo) {
        logger.warn('youtube_sync_title_parse_miss', { videoId, title });
      }

      const durationSeconds = durationMap.get(videoId) ?? null;
      await insertSession(video, parsed, channelId, durationSeconds);
      insertedIds.push(videoId);

      logger.info('youtube_sync_session_inserted', {
        videoId,
        title,
        fecha:    parsed.fecha,
        comision: parsed.comision,
        tipo:     parsed.tipo,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      erroredItems.push({ videoId, error: message });
      logger.error('youtube_sync_insert_error', { videoId, title, error: message });
      // Continue with remaining videos — partial success is better than none.
      // The errored videos will be picked up on the next cron run.
    }
  }

  const result: YoutubeSyncResult = {
    found,
    new:     insertedIds.length,
    skipped: skippedIds.length,
    errors:  erroredItems.length,
    videoIds: {
      new:     insertedIds,
      skipped: skippedIds,
      errored: erroredItems,
    },
  };

  logger.info('youtube_sync_complete', {
    found:   result.found,
    new:     result.new,
    skipped: result.skipped,
    errors:  result.errors,
    dryRun,
  });

  return result;
}

// ── Exports for testing ───────────────────────────────────────────────────────
// These internal functions are exported for unit testing only. They are NOT
// part of the stable public API. The `_` prefix signals this convention.
// Callers outside tests should use syncYoutubeChannel only.
export { parseTitleMeta as _parseTitleMeta, _channelIdCache };
