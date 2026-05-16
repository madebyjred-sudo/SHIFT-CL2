/**
 * SharePoint OData crawler orchestrator — Track A, Sprint 1 (2026-05-14).
 *
 * ROLE IN THE SYSTEM:
 *   This is the stateful layer between the generic SharePointClient and the
 *   database. It manages cursors, upserts raw payloads, and returns a typed
 *   CrawlResult that the caller (script or admin endpoint) can log/report.
 *
 * IDEMPOTENCY:
 *   The crawler is fully idempotent. If interrupted mid-run, re-running it
 *   will:
 *     1. Re-read the cursor (last_modified was NOT updated yet if we crashed).
 *     2. Re-fetch items Modified > cursor.last_modified.
 *     3. Upsert them — existing rows with the same etag are skipped.
 *   Net effect: no duplicates, no gaps.
 *
 * ETAG DEDUPLICATION:
 *   SharePoint items carry an ETag in the payload (field `odata.etag` in
 *   verbose mode, `@odata.etag` in nometadata). If the etag matches the
 *   stored value, we skip the DB write. This saves writes when a list has
 *   many small Modified bumps (e.g. view count updates) but no real changes.
 *
 * CURSOR UPDATE STRATEGY:
 *   We update the cursor ONLY after a successful full run. On partial failure
 *   we set last_run_status='partial' and keep last_modified at the previous
 *   value so the next run retries the full window. This is slightly redundant
 *   but safe — better to re-process 200 rows than miss one.
 *
 * Source: pedido 10, §9.1, Sprint Design Doc §4 Track A.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SharePointClient } from './sharePointClient.js';
import { logger } from './logger.js';
import type { Item } from './sharePointClient.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  /**
   * OData $select fields. If omitted, all fields are fetched (safe but large).
   * For lists with many columns (e.g. Ordenes_dia), provide a select list to
   * reduce payload. The crawler always fetches Id, Modified, and Title at minimum.
   */
  select?: string[];
  /**
   * Max pages per run (safety valve). At $top=2000 this caps the total items
   * fetched per run. Default: 50 pages = 100,000 items (effectively unbounded
   * for all GLCP lists).
   */
  maxPages?: number;
  /**
   * Override the cursor stored in `sharepoint_cursors` with a custom
   * `Modified gt datetime'<iso>'` lower bound (pedido 16l del cliente —
   * backfill actas desde 2022 sin esperar a la deriva natural del crawler).
   *
   *   `null`     → ignora el cursor por completo (full backfill).
   *   `string`   → usa el ISO timestamp como punto de partida; útil para
   *                "todo desde 2022-01-01T00:00:00Z".
   *   `undefined`→ comportamiento normal (usa el cursor de la DB).
   *
   * El cursor en DB NO se modifica al inicio del run; al final del run el
   * crawler avanza el cursor al máximo `Modified` visto, igual que un run
   * normal. O sea: una pasada con override expande la cobertura sin perder
   * la posición.
   */
  cursorOverride?: string | null;
}

export interface CrawlResult {
  list_id: string;
  list_title: string;
  items_seen: number;
  items_new: number;
  items_updated: number;
  items_skipped_etag: number;
  errors: number;
  duration_ms: number;
  cursor_advanced_to: string | null;
}

interface CursorRow {
  list_id: string;
  list_title: string | null;
  last_modified: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_error: string | null;
  items_processed_lifetime: number;
}

// ─── Module-level Supabase singleton ────────────────────────────────────────

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'sharePointCrawler: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── ETag extraction helpers ─────────────────────────────────────────────────

/**
 * Extract the ETag from a raw SharePoint item payload.
 * OData verbose format: item['__metadata']?.etag
 * OData nometadata format: item['@odata.etag']
 * We try both since silSharePointClient uses verbose but could change.
 */
function extractEtag(item: Item): string | null {
  const meta = (item as Record<string, unknown>)['__metadata'] as Record<string, unknown> | undefined;
  if (meta?.etag && typeof meta.etag === 'string') return meta.etag;
  const noMeta = (item as Record<string, unknown>)['@odata.etag'];
  if (typeof noMeta === 'string') return noMeta;
  return null;
}

/**
 * Find the maximum Modified timestamp from a batch of items.
 * Returns null if no items have a Modified field.
 */
function maxModified(items: Item[]): string | null {
  let max: string | null = null;
  for (const item of items) {
    if (!item.Modified) continue;
    if (!max || item.Modified > max) max = item.Modified;
  }
  return max;
}

// ─── Main crawl function ─────────────────────────────────────────────────────

/**
 * Crawl a single SharePoint list, upsert items into sil_sharepoint_raw,
 * and advance the cursor in sharepoint_cursors.
 *
 * @param listId    GUID of the list (bare, no braces).
 * @param listTitle Human-readable name for logs and the cursor table.
 * @param options   Optional fetch controls.
 */
export async function crawlList(
  listId: string,
  listTitle: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const startMs = Date.now();
  const log = logger.with({ crawler: 'sharepoint', list_id: listId, list_title: listTitle });
  const client = new SharePointClient();
  const db = supa();

  let itemsSeen = 0;
  let itemsNew = 0;
  let itemsUpdated = 0;
  let itemsSkippedEtag = 0;
  let errors = 0;
  let cursorAdvancedTo: string | null = null;
  const allModifieds: string[] = [];

  // ── 1. Read cursor ────────────────────────────────────────────────────────
  const { data: cursorRow, error: cursorErr } = await db
    .from('sharepoint_cursors')
    .select('list_id, list_title, last_modified, last_run_at, last_run_status, last_error, items_processed_lifetime')
    .eq('list_id', listId)
    .maybeSingle();

  if (cursorErr) {
    log.warn('cursor read failed — doing full backfill', { error: cursorErr.message });
  }

  const cursor = cursorRow as CursorRow | null;
  // cursorOverride === undefined → uso el cursor de DB (comportamiento normal).
  // cursorOverride === null → full backfill (ignoro el cursor existente).
  // cursorOverride === ISO string → uso ese ISO como punto de partida.
  const lastModified =
    options.cursorOverride === undefined
      ? cursor?.last_modified ?? null
      : options.cursorOverride;
  const usingOverride = options.cursorOverride !== undefined;

  log.info('crawl start', {
    last_modified: lastModified ?? 'full_backfill',
    items_processed_lifetime: cursor?.items_processed_lifetime ?? 0,
    cursor_overridden: usingOverride,
  });

  // ── 2. Build filter ───────────────────────────────────────────────────────
  // If we have a cursor, only fetch items newer than last seen.
  // On first run (null cursor), fetch everything — that's the backfill.
  const filterExpr = lastModified
    ? `Modified gt datetime'${lastModified}'`
    : undefined;

  // Ensure we always fetch Id, Modified, Title, and (for doc libraries)
  // FileRef + FileLeafRef even if caller narrowed $select. FileRef + FileLeafRef
  // son cruciales para Track D (decretos) y cualquier downstream que necesite
  // descargar el archivo físico — el default view de SharePoint NO los incluye
  // en items de doc library, solo expone un `File.__deferred` reference.
  // Pedirlos explícitos los fuerza al payload. Side effect: en listas que no
  // son doc lib, SharePoint los ignora (no devuelve esos campos), sin error.
  const baseFields = ['Id', 'Modified', 'Title', 'FileRef', 'FileLeafRef'];
  const selectFields = options.select?.length
    ? [...new Set([...baseFields, ...options.select])]
    : baseFields; // pedir explícitamente los baseFields (incluyendo FileRef/FileLeafRef)

  // ── 3. Iterate and upsert ─────────────────────────────────────────────────
  // We batch upserts to avoid one DB round-trip per item. Batch size 100 balances
  // memory vs latency — at ~1KB/item that's ~100KB per flush, well within Node.
  const BATCH_SIZE = 100;
  let batch: Item[] = [];

  const flush = async (items: Item[]) => {
    if (items.length === 0) return;

    // Read existing etags in one query to detect skips.
    const ids = items.map((i) => String(i.Id));
    const { data: existing } = await db
      .from('sil_sharepoint_raw')
      .select('item_id, etag')
      .eq('list_id', listId)
      .in('item_id', ids);

    const existingEtags = new Map<string, string | null>(
      ((existing ?? []) as Array<{ item_id: string; etag: string | null }>)
        .map((r) => [r.item_id, r.etag]),
    );

    const toUpsert: Array<{
      list_id: string;
      item_id: string;
      list_title: string;
      scraped_at: string;
      etag: string | null;
      payload: unknown;
    }> = [];

    for (const item of items) {
      const itemId = String(item.Id);
      const etag = extractEtag(item);
      const prevEtag = existingEtags.get(itemId);

      // Skip if etag matches (item unchanged).
      if (etag && prevEtag === etag) {
        itemsSkippedEtag++;
        continue;
      }

      const isNew = !existingEtags.has(itemId);
      if (isNew) itemsNew++; else itemsUpdated++;

      toUpsert.push({
        list_id: listId,
        item_id: itemId,
        list_title: listTitle,
        scraped_at: new Date().toISOString(),
        etag,
        payload: item,
      });

      if (item.Modified) allModifieds.push(item.Modified);
    }

    if (toUpsert.length > 0) {
      const { error: upsertErr } = await db
        .from('sil_sharepoint_raw')
        .upsert(toUpsert, { onConflict: 'list_id,item_id' });

      if (upsertErr) {
        log.error('upsert batch failed', { error: upsertErr.message, batch_size: toUpsert.length });
        errors += toUpsert.length;
      }
    }
  };

  try {
    for await (const item of client.listItems(listId, {
      select: selectFields,
      filter: filterExpr,
      orderby: 'Modified asc', // asc so the cursor advances monotonically
      maxPages: options.maxPages ?? 50,
    })) {
      itemsSeen++;
      batch.push(item);

      if (batch.length >= BATCH_SIZE) {
        await flush(batch);
        batch = [];
        log.info('batch flushed', { items_seen: itemsSeen, items_new: itemsNew });
      }
    }

    // Flush remaining items.
    await flush(batch);
    batch = [];

  } catch (fetchErr) {
    log.error('fetch error during crawl', { error: (fetchErr as Error).message });
    errors++;

    // Update cursor with failure status and return early.
    await db.from('sharepoint_cursors').upsert({
      list_id: listId,
      list_title: listTitle,
      last_modified: lastModified,  // keep previous cursor
      last_run_at: new Date().toISOString(),
      last_run_status: 'failed',
      last_error: (fetchErr as Error).message.slice(0, 1000),
    }, { onConflict: 'list_id' });

    return {
      list_id: listId,
      list_title: listTitle,
      items_seen: itemsSeen,
      items_new: itemsNew,
      items_updated: itemsUpdated,
      items_skipped_etag: itemsSkippedEtag,
      errors,
      duration_ms: Date.now() - startMs,
      cursor_advanced_to: null,
    };
  }

  // ── 4. Advance cursor ─────────────────────────────────────────────────────
  // Use the max Modified we saw. If we saw nothing (delta returned 0 items),
  // keep the previous cursor so we don't accidentally reset it.
  const newMaxModified = allModifieds.length > 0
    ? allModifieds.reduce((a, b) => (a > b ? a : b))
    : null;

  cursorAdvancedTo = newMaxModified ?? lastModified;
  const runStatus = errors > 0 ? 'partial' : 'ok';
  const prevLifetime = cursor?.items_processed_lifetime ?? 0;

  await db.from('sharepoint_cursors').upsert({
    list_id: listId,
    list_title: listTitle,
    last_modified: cursorAdvancedTo,
    last_run_at: new Date().toISOString(),
    last_run_status: runStatus,
    last_error: errors > 0 ? `${errors} items failed to upsert` : null,
    items_processed_lifetime: prevLifetime + itemsSeen,
  }, { onConflict: 'list_id' });

  const durationMs = Date.now() - startMs;

  log.info('crawl complete', {
    items_seen: itemsSeen,
    items_new: itemsNew,
    items_updated: itemsUpdated,
    items_skipped_etag: itemsSkippedEtag,
    errors,
    duration_ms: durationMs,
    cursor_advanced_to: cursorAdvancedTo,
    status: runStatus,
  });

  return {
    list_id: listId,
    list_title: listTitle,
    items_seen: itemsSeen,
    items_new: itemsNew,
    items_updated: itemsUpdated,
    items_skipped_etag: itemsSkippedEtag,
    errors,
    duration_ms: durationMs,
    cursor_advanced_to: cursorAdvancedTo,
  };
}
