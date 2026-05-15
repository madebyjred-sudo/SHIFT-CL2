/**
 * SharePoint OData generic client — feeds the Track A crawler.
 *
 * WHY THIS FILE EXISTS (vs silSharePointClient.ts):
 *   silSharePointClient.ts is a low-level fetch layer that exposes raw iterators.
 *   This file wraps that layer into a class API with pagination, metadata, and
 *   query building — designed for the crawler orchestrator (sharePointCrawler.ts)
 *   to consume without knowing OData internals.
 *
 * The separation keeps silSharePointClient.ts stable (it's also used by other jobs)
 * and lets this class evolve without breaking those callers.
 *
 * SSL NOTE: The GLCP server sometimes presents a cert chain that Node's TLS rejects
 * (expired intermediate). If NODE_TLS_REJECT_UNAUTHORIZED is set to '0' in the
 * environment, we allow it here and log a warning at startup. This is intentional
 * and scoped ONLY to this service — do NOT set this globally in the main API
 * process. The Cloud Run Job that runs the crawler sets it via env var so the
 * main API is unaffected.
 *
 * Source: pedido 10, §9.2 — Track A, Sprint 1 (2026-05-14).
 */

import { iterateListItems, listSharePointLists } from './silSharePointClient.js';
import type { SharePointItemRaw, SharePointList } from './silSharePointClient.js';
import { logger } from './logger.js';

// Warn once at module load if TLS verification is disabled.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  logger.warn('sharePointClient: NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS cert errors suppressed. ' +
    'This is intentional for the GLCP crawler (govt cert chain issues) but MUST NOT be ' +
    'set in the main API process. Set it only in the Cloud Run Job env for crawler-sharepoint.ts.');
}

export interface ListMeta {
  id: string;
  title: string;
  itemCount: number;
  baseTemplate: number;
  lastModified: string;
}

export interface Item extends SharePointItemRaw {
  // Alias for clarity in crawler code
  Id: number;
  Modified?: string;
  Created?: string;
  Title?: string | null;
}

export interface ODataQueryOpts {
  select?: string[];
  filter?: string;
  top?: number;
  orderby?: string;
  /** Max number of pages (safety valve). Default = unbounded. */
  maxPages?: number;
}

/**
 * Build an OData query string from structured options.
 * Exported so callers can debug / log the URL before fetching.
 */
export function buildOdataQuery(opts: ODataQueryOpts): string {
  const parts: string[] = [];
  if (opts.select?.length) parts.push(`$select=${opts.select.join(',')}`);
  if (opts.filter) parts.push(`$filter=${encodeURIComponent(opts.filter)}`);
  if (opts.top) parts.push(`$top=${opts.top}`);
  if (opts.orderby) parts.push(`$orderby=${encodeURIComponent(opts.orderby)}`);
  return parts.join('&');
}

export class SharePointClient {
  private readonly baseUrl: string;

  /**
   * @param baseUrl  Base URL of the SharePoint site, e.g.
   *                 "https://www.asamblea.go.cr/glcp"
   *                 Defaults to SIL_SHAREPOINT_BASE env var or the GLCP URL.
   */
  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl
      ?? process.env.SIL_SHAREPOINT_BASE
      ?? 'https://www.asamblea.go.cr/glcp';
  }

  /**
   * Async generator that paginates through all items in a list.
   * Uses $skiptoken pagination (SharePoint OData standard). Each `yield`
   * is a single item row with all fields (or the $select subset).
   *
   * The caller should stream items directly into the database rather than
   * collecting them all in memory — a list like Ordenes_dia has 8,103 items.
   *
   * @param listIdOrTitle  GUID of the list (preferred) or its Title string.
   *                       GUIDs work with the guid'...' syntax in the URL.
   *                       Title strings work with getbytitle('...') but are
   *                       fragile if the title has special chars — prefer GUID.
   */
  async *listItems(
    listIdOrTitle: string,
    opts: ODataQueryOpts = {},
  ): AsyncIterable<Item> {
    // Detect if the caller passed a GUID (contains hyphens and is 36 chars,
    // possibly wrapped in braces) vs a Title string.
    const isGuid = /^[{]?[0-9a-f-]{36}[}]?$/i.test(listIdOrTitle.trim());

    // Strip braces if present — iterateListItems expects bare GUIDs.
    const normalizedGuid = isGuid
      ? listIdOrTitle.replace(/[{}]/g, '')
      : null;

    if (!normalizedGuid) {
      // Title-based lookup: fetch the list metadata first to get the GUID.
      // This adds one round-trip but keeps the API consistent.
      // TODO: if perf becomes an issue, cache title→guid in a module-level Map.
      const lists = await listSharePointLists();
      const match = lists.find(
        (l) => l.Title.toLowerCase() === listIdOrTitle.toLowerCase(),
      );
      if (!match) {
        throw new Error(`sharePointClient: list title "${listIdOrTitle}" not found in GLCP`);
      }
      yield* this._iterateByGuid(match.Id, opts);
    } else {
      yield* this._iterateByGuid(normalizedGuid, opts);
    }
  }

  private async *_iterateByGuid(
    guid: string,
    opts: ODataQueryOpts,
  ): AsyncGenerator<Item> {
    const iterOpts = {
      modifiedSince: opts.filter?.match(/Modified gt datetime'([^']+)'/)?.[1],
      select: opts.select,
      orderBy: opts.orderby,
      maxPages: opts.maxPages,
    };

    // If filter is more complex than a simple Modified-gt, pass it raw.
    // iterateListItems only supports modifiedSince natively; anything else
    // needs a custom $filter. For Sprint 1, modifiedSince covers 100% of
    // our use cases — leave a TODO for complex filters.
    // TODO: support arbitrary $filter strings in iterateListItems or build
    //       a fetch wrapper here that passes the raw filter param.

    for await (const raw of iterateListItems(guid, iterOpts)) {
      yield raw as Item;
    }
  }

  /**
   * Fetch metadata about a single list: title, item count, base template.
   * Useful for the admin endpoint to show list health without fetching items.
   */
  async getListMetadata(listId: string): Promise<ListMeta> {
    const guid = listId.replace(/[{}]/g, '');
    const lists = await listSharePointLists();
    const match = lists.find((l) => l.Id.toLowerCase() === guid.toLowerCase());
    if (!match) {
      throw new Error(`sharePointClient: list ${listId} not found in GLCP`);
    }
    return {
      id: match.Id,
      title: match.Title,
      itemCount: match.ItemCount,
      // SharePoint base templates: 100=GenericList, 101=DocumentLibrary, etc.
      // We cast to number here; the raw value comes as number from the API.
      baseTemplate: 100, // TODO: expose BaseTemplate from listSharePointLists()
      lastModified: match.LastItemModifiedDate,
    };
  }
}

// Re-export for convenience so the crawler doesn't need to import from two files.
export type { SharePointItemRaw, SharePointList };
