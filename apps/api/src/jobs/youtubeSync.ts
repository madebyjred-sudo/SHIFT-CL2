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
 *   - `playlistItems.list` costs 1 quota unit per call vs 100 for `search.list`.
 *     Every channel has a deterministic "uploads" playlist: replace the `UC`
 *     prefix in the channel ID with `UU` to get the playlist ID.
 *   - We use `channels.list?forHandle=` (1 unit) to resolve the channel ID,
 *     then derive the uploads playlist ID and call `playlistItems.list` (1 unit).
 *     Total: 2 units per cron run instead of 101.
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
// playlistItems.list returns at most 50 per page (newest first). For a 7-day
// window on a channel that posts 3-5 sessions/week, 50 is always enough.
// Pagination is intentionally omitted for MVP — if a deeper backfill is ever
// needed, add pageToken handling here. Document decision: adding pagination
// costs 1 unit per page, still far cheaper than search.list (100 units).
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

/**
 * One item from the playlistItems.list API response.
 *
 * snippet.publishedAt  — when the item was ADDED to the playlist (usually same
 *                        as videoPublishedAt, but not guaranteed).
 * contentDetails.videoPublishedAt — when the video was UPLOADED to YouTube.
 *
 * We prefer videoPublishedAt for the "when was this session" timestamp because
 * it reflects the actual upload event, not a playlist-add event.
 */
interface YouTubePlaylistItem {
  snippet: {
    publishedAt: string;          // ISO 8601 — item added to playlist
    title: string;
    resourceId: { videoId: string };
    channelId: string;
  };
  contentDetails: {
    videoId: string;
    videoPublishedAt: string;     // ISO 8601 — actual video upload time
  };
}

interface YouTubePlaylistItemsResponse {
  items: YouTubePlaylistItem[];
  nextPageToken?: string;
  pageInfo: { totalResults: number; resultsPerPage: number };
}

/**
 * Normalised video metadata — internal shape passed between helpers.
 *
 * Decoupled from the raw API response so that the rest of the job (diff,
 * insert, dryRun reporting) doesn't care whether data came from search.list
 * or playlistItems.list.
 */
interface VideoMeta {
  videoId: string;
  title: string;
  publishedAt: string;  // ISO 8601 — video upload time (videoPublishedAt preferred)
  channelId: string;
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

// ── Legislative-session title filter ─────────────────────────────────────────
//
// El canal @AsambleaCRC publica TODO: plenarios, comisiones, noticias,
// entrevistas, traspasos, curiosidades. Si dejamos pasar todo, el listado
// `/sesiones` se llena de ruido (verificado 2026-05-18: 108 noticias entraron
// como `tipo=NULL` y se mezclaron con plenarios reales).
//
// Esta lista de regex acepta SOLO sesiones legislativas legítimas. Si un título
// no matchea ninguno, lo descartamos al ingest. Lo elegimos como whitelist
// estricta (no blacklist) porque el set de tipos noticia es abierto: hoy son
// "Curiosidades", mañana puede ser cualquier otro formato editorial.
//
// Los patrones son intencionalmente permisivos en mayúsculas/tildes y orden de
// palabras, pero EXIGEN palabras-ancla que sólo aparecen en sesiones:
//   - Plenario: "Plenario Legislativo" o "Sesión Plenaria" (formato viejo CR
//     todavía usado) o "Sesión {Ordinaria|Extraordinaria|Solemne}"
//   - Comisión: "Comisión {Permanente|Especial|Plena|Investigadora|Mixta|
//     Ordinaria|de|sobre|para}" — exige qualifier directo para evitar
//     "Anuncian integración de las 3 Comisiones..." (noticia)
//   - "Sesión Legislativa" como catch-all suave
//
// Cualquier título sin esos anchors va a `youtube_skip_non_session` log y no
// llega a la tabla `sessions`.
const PLENARIO_TITLE_RE        = /\b(?:plenario\s+legislativo|sesi[oó]n\s+plenaria)\b/i;
const SESION_TIPO_RE           = /\bsesi[oó]n\s+(?:ordinaria|extraordinaria|solemne|legislativa)\b/i;
const COMISION_TITLE_RE        = /\bcomisi[oó]n\s+(?:permanente|especial|plena|investigadora|mixta|ordinaria|de\b|sobre\b|para\b)/i;

/**
 * True if `title` matches a known legislative-session pattern.
 *
 * Whitelist by design: we'd rather miss an occasional session with an unusual
 * title (re-runnable: edit the regex and re-discover) than admit hundreds of
 * news/event uploads as sessions.
 *
 * Validated 2026-05-18 against 258 filas prod:
 *   - Acepta: "Plenario Legislativo, Sesión Ordinaria #10, …" (formato actual),
 *     "Sesión Plenaria N°47 - …" (formato viejo CR), "Comisión Permanente
 *     Ordinaria de Asuntos Económicos", "Comisión Especial de la Provincia de
 *     Puntarenas", "Comisión de Hacienda".
 *   - Rechaza: "Asamblea Legislativa Noticias …", "Anuncian integración de las
 *     3 Comisiones …", "Costa Rica escribe una nueva página política …",
 *     "Curiosidades de la Asamblea …", "Entrevista a/con …", "Transmisión
 *     especial: Traspaso de Poderes".
 *
 * Exported for unit testing.
 */
export function isLegislativeSession(title: string): boolean {
  if (!title) return false;
  return (
    PLENARIO_TITLE_RE.test(title) ||
    SESION_TIPO_RE.test(title) ||
    COMISION_TITLE_RE.test(title)
  );
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
  // Pattern 1: "DD de Mes de YYYY" — formato canónico de prensa CR
  const longDateRe = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i;
  const m1 = title.match(longDateRe);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const monthName = m1[2].toLowerCase();
    const year = m1[3];
    const month = MONTH_MAP[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  // Pattern 1b: "DD Mes YYYY" sin "de" — formato común en títulos de
  // Asamblea Legislativa CR (ej: "Sesión Ordinaria #07, 11 mayo 2026").
  // Agregado 2026-05-12 tras ver que el Plenario #07 quedaba con fecha=null.
  // El (?:de\s+)? hace opcional un solo "de" entre día y mes para cubrir
  // también "11 de mayo 2026" sin el segundo "de".
  const shortDateRe = /(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\s+(\d{4})/i;
  const m1b = title.match(shortDateRe);
  if (m1b) {
    const day = m1b[1].padStart(2, '0');
    const monthName = m1b[2].toLowerCase();
    const year = m1b[3];
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
      .replace(/\s+n[°º]\d+\s*$/i, '')
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
 * List recent uploads from a channel using playlistItems.list.
 *
 * Cost: 1 quota unit per call (vs 100 for search.list).
 *
 * HOW: Every YouTube channel has an auto-generated "uploads" playlist whose ID
 * is derived deterministically from the channel ID by replacing the `UC` prefix
 * with `UU`. This is an undocumented but stable Google convention, widely
 * documented in the developer community and confirmed by the YouTube Data API
 * team. Example: channelId=UCWN0rIWneMdqRmZ4yHs5GuA → playlistId=UUWN0rIWneMdqRmZ4yHs5GuA
 *
 * The response is in REVERSE chronological order (newest first). We filter
 * client-side by videoPublishedAt >= cutoff. Once we encounter a video older
 * than the cutoff we can stop (all remaining items will be even older).
 *
 * Pagination: MVP fetches page 1 only (50 items). At ~3-5 sessions/week over
 * 7 days, 50 is overkill. If a deeper backfill is needed in the future, add
 * pageToken handling here (costs 1 unit per page — still far cheaper than
 * search.list at 100 units).
 *
 * Returns an array of VideoMeta (normalised, decoupled from raw API shape).
 */
async function listChannelUploads(
  channelId: string,
  publishedAfter: Date,
  apiKey: string,
): Promise<VideoMeta[]> {
  // Derive the uploads playlist ID: replace `UC` prefix with `UU`.
  // This is a deterministic Google convention — every channel has exactly one
  // uploads playlist with this ID pattern.
  const uploadsPlaylistId = channelId.replace(/^UC/, 'UU');

  const url =
    `${YT_API_BASE}/playlistItems` +
    `?part=snippet,contentDetails` +
    `&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
    `&maxResults=${MAX_RESULTS}` +
    `&key=${apiKey}`;

  const data = await ytApiFetch<YouTubePlaylistItemsResponse>(url, `yt:playlistItems:${channelId}`);

  const cutoffMs = publishedAfter.getTime();
  const results: VideoMeta[] = [];

  for (const item of data.items ?? []) {
    // Prefer contentDetails.videoPublishedAt (actual upload time) over
    // snippet.publishedAt (when added to playlist — usually identical but not
    // guaranteed for backdated uploads or channel migrations).
    const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet.publishedAt;

    // Stop iterating once we hit a video older than the cutoff.
    // playlistItems.list is reverse-chronological — once one video is too old,
    // all subsequent ones will be older still.
    if (new Date(publishedAt).getTime() < cutoffMs) break;

    results.push({
      videoId:     item.contentDetails?.videoId ?? item.snippet.resourceId.videoId,
      title:       item.snippet.title,
      publishedAt,
      channelId,
    });
  }

  logger.info('youtube_sync_videos_listed', {
    channelId,
    uploadsPlaylistId,
    publishedAfter: publishedAfter.toISOString(),
    returned: results.length,
    rawItems: data.items?.length ?? 0,
  });

  return results;
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
 * Check if a session with the same (fecha, tipo, raw_title) already exists.
 *
 * Caso de uso: YouTube sube DOS videos para la misma sesión real — uno como
 * livestream (con duration_seconds eventualmente correcto) y otro como upload
 * recortado/post-procesado (a veces con dur=0 o dur menor). El dedup por
 * `youtube_video_id` no caza estos casos porque los IDs son distintos.
 *
 * Estrategia: si ya hay una fila con misma fecha + tipo + raw_title en
 * `sessions` (cualquier status excepto rejected), descartamos el video nuevo.
 * Mantenemos la fila vieja porque generalmente ya tiene transcript_segments
 * indexados; reemplazarla rompería la cadena.
 *
 * Si parsed.fecha o parsed.tipo es null, retornamos false (no dedup posible
 * sin esos campos — caería al fallback de inserción + filtro de tipo NULL).
 */
async function isDuplicateByFechaTipoTitle(
  fecha: string | null,
  tipo: 'plenario' | 'comision' | 'extraordinaria' | null,
  rawTitle: string,
): Promise<boolean> {
  if (!fecha || !tipo || !rawTitle) return false;

  const { data, error } = await supa()
    .from('sessions')
    .select('id, status')
    .eq('fecha', fecha)
    .eq('tipo', tipo)
    .neq('status', 'rejected')
    .filter('metadata->>raw_title', 'eq', rawTitle)
    .limit(1);

  if (error) {
    // No queremos romper el sync por un error de query — logueamos y
    // permitimos el insert (si hay duplicado real lo cazará el siguiente run).
    logger.warn('youtube_sync_dedup_query_failed', {
      fecha,
      tipo,
      error: error.message,
    });
    return false;
  }

  return (data ?? []).length > 0;
}

/**
 * Re-fetch duration from YouTube for sessions creadas en últimas 48h con
 * `metadata.duration_seconds = 0`.
 *
 * Caso: cuando el cron corre justo después de un livestream, YouTube todavía
 * devuelve `contentDetails.duration = "P0D"` y nuestro `parseIsoDurationToSeconds`
 * devuelve 0. La duración real aparece minutos/horas después. Sin este refresh,
 * `duration_seconds = 0` queda permanente y el frontend muestra "0 mins".
 *
 * Ventana de 48h: cubre el típico delay de YouTube en publicar la duración
 * (que suele resolverse en <12h pero hemos visto casos a >24h en plenarios
 * largos). Más allá de 48h asumimos que el video se quedó así por una razón
 * estructural (ej. todavía es livestream activo) y no insistimos.
 *
 * Costo: 1 quota unit por batch de 50 IDs. Si hay 0 candidatos, no se llama
 * a YouTube.
 */
async function refreshZeroDurationsRecent(apiKey: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  const { data, error } = await supa()
    .from('sessions')
    .select('id, youtube_video_id, metadata')
    .gte('created_at', cutoff)
    .not('youtube_video_id', 'is', null)
    .filter('metadata->>duration_seconds', 'eq', '0');

  if (error) {
    logger.warn('youtube_sync_refresh_zero_dur_query_failed', { error: error.message });
    return;
  }

  type Row = { id: string; youtube_video_id: string; metadata: Record<string, unknown> | null };
  const candidates = (data ?? []) as Row[];
  if (candidates.length === 0) {
    logger.info('youtube_sync_refresh_zero_dur_no_candidates', {});
    return;
  }

  const videoIds = candidates.map((c) => c.youtube_video_id);
  const durationMap = await fetchVideoDurations(videoIds, apiKey);

  let updated = 0;
  for (const c of candidates) {
    const secs = durationMap.get(c.youtube_video_id);
    if (!secs || secs <= 0) continue;
    const newMeta = { ...(c.metadata ?? {}), duration_seconds: secs };
    const { error: upErr } = await supa()
      .from('sessions')
      .update({ metadata: newMeta })
      .eq('id', c.id);
    if (upErr) {
      logger.warn('youtube_sync_refresh_zero_dur_update_failed', {
        sessionId: c.id,
        videoId: c.youtube_video_id,
        error: upErr.message,
      });
      continue;
    }
    updated++;
  }

  logger.info('youtube_sync_refresh_zero_dur_complete', {
    candidates: candidates.length,
    updated,
  });
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
  item: VideoMeta,
  parsed: ParsedTitleMeta,
  durationSeconds: number | null,
): Promise<string> {
  const { title, videoId, publishedAt, channelId } = item;

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

  // ── 3b. Refresh duration_seconds=0 en sesiones recientes (livestreams) ──────
  // YouTube devuelve `contentDetails.duration = "P0D"` mientras un livestream
  // está activo o recién terminado, así que muchas sesiones quedan con
  // duration_seconds=0. Al inicio de cada corrida, re-consultamos YouTube para
  // las creadas en las últimas 48h y actualizamos cuando ya tiene duración real.
  // Esto es independiente del discovery — corre antes para refrescar lo que ya
  // está en DB.
  await refreshZeroDurationsRecent(apiKey).catch((err) => {
    // Non-fatal: no rompemos el sync si esto falla. Logueamos y seguimos.
    logger.warn('youtube_sync_refresh_zero_durations_failed', {
      error: (err as Error)?.message ?? String(err),
    });
  });

  // ── 4. List recent uploads via playlistItems.list ───────────────────────────
  const videos = await listChannelUploads(channelId, publishedAfter, apiKey);
  const found = videos.length;

  if (found === 0) {
    logger.info('youtube_sync_no_videos', { channelHandle, daysBack });
    return { found: 0, new: 0, skipped: 0, errors: 0, videoIds: { new: [], skipped: [], errored: [] } };
  }

  // ── 4a. Filtrar por título: SOLO sesiones legislativas ───────────────────────
  // Cualquier upload que no matchee `isLegislativeSession()` se descarta acá
  // (noticias, entrevistas, traspasos, curiosidades). Logueamos cada descarte
  // para auditoría — si el filtro se vuelve demasiado estricto y descarta una
  // sesión real, vamos a verlo en los logs y ajustar el regex.
  const filteredVideos: VideoMeta[] = [];
  const skippedNonSession: Array<{ videoId: string; title: string }> = [];
  for (const v of videos) {
    if (isLegislativeSession(v.title)) {
      filteredVideos.push(v);
    } else {
      skippedNonSession.push({ videoId: v.videoId, title: v.title });
      logger.info('youtube_skip_non_session', { videoId: v.videoId, title: v.title });
    }
  }
  if (skippedNonSession.length > 0) {
    logger.info('youtube_sync_filter_summary', {
      total: videos.length,
      kept: filteredVideos.length,
      skipped_non_session: skippedNonSession.length,
    });
  }

  // ── 4b. Fetch video durations via videos.list?part=contentDetails ────────────
  // Cost: 1 quota unit (negligible). Must be called before the diff so the map
  // is available when constructing each new session's metadata.
  const allVideoIds = filteredVideos.map((v) => v.videoId);
  const durationMap = await fetchVideoDurations(allVideoIds, apiKey);

  // ── 5. Diff against existing sessions ───────────────────────────────────────
  // Doble dedup:
  //  - por youtube_video_id (caso normal: re-run del cron sobre el mismo video)
  //  - por (fecha + tipo + raw_title) (caso live+recorte: YouTube sube 2 videos
  //    distintos para la misma sesión real, uno como live stream y otro como
  //    upload recortado — dedup por video_id no los caza)
  const existingIds = await fetchExistingVideoIds(allVideoIds);

  const duplicateByTitle: VideoMeta[] = [];
  const toInsert: VideoMeta[] = [];
  for (const v of filteredVideos) {
    if (existingIds.has(v.videoId)) continue; // YA cuenta como skip por video_id
    const parsedForDedup = parseTitleMeta(v.title);
    const isDup = await isDuplicateByFechaTipoTitle(parsedForDedup.fecha, parsedForDedup.tipo, v.title);
    if (isDup) {
      duplicateByTitle.push(v);
      logger.info('youtube_dedup_skip_by_title', {
        videoId: v.videoId,
        title: v.title,
        fecha: parsedForDedup.fecha,
        tipo: parsedForDedup.tipo,
      });
      continue;
    }
    toInsert.push(v);
  }

  const skippedIds = [
    ...filteredVideos.filter((v) => existingIds.has(v.videoId)).map((v) => v.videoId),
    ...duplicateByTitle.map((v) => v.videoId),
  ];

  logger.info('youtube_sync_diff', {
    found,
    filtered_out: skippedNonSession.length,
    existing_by_video_id: existingIds.size,
    duplicate_by_title: duplicateByTitle.length,
    toInsert: toInsert.length,
  });

  // ── 6. dryRun: report without inserting ─────────────────────────────────────
  if (dryRun) {
    const dryNew = toInsert.map((v) => v.videoId);
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
    const { videoId, title } = video;

    try {
      const parsed = parseTitleMeta(title);

      // Warn if parsing yielded nothing — will be handled by LLM review
      if (!parsed.fecha && !parsed.comision && !parsed.tipo) {
        logger.warn('youtube_sync_title_parse_miss', { videoId, title });
      }

      const durationSeconds = durationMap.get(videoId) ?? null;
      await insertSession(video, parsed, durationSeconds);
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
export {
  parseTitleMeta as _parseTitleMeta,
  _channelIdCache,
  isDuplicateByFechaTipoTitle as _isDuplicateByFechaTipoTitle,
  refreshZeroDurationsRecent as _refreshZeroDurationsRecent,
};
