/**
 * SIL SharePoint OData client — pulls structured legislative data from the
 * Asamblea Legislativa's SharePoint REST endpoint (no auth required, public
 * data licensed CC BY 4.0).
 *
 * Endpoint pattern:
 *   GET https://www.asamblea.go.cr/glcp/_api/web/lists                    → enum lists
 *   GET https://www.asamblea.go.cr/glcp/_api/web/lists(guid'…')/items     → items
 *   Header: Accept: application/json;odata=verbose
 *   Pagination: response.d.__next contains the next-page URL with $skiptoken
 *
 * Why not Playwright: SharePoint serves JSON, no JS execution needed. A plain
 * fetch with cookies disabled is 50x faster and 10x more stable.
 *
 * Rate limit: SP doesn't enforce one but the server is government-owned —
 * we cap at 4 concurrent requests + 250ms delay between batches to be polite.
 */
import { withRetry, withTimeout } from './resilience.js';

const SIL_BASE = process.env.SIL_SHAREPOINT_BASE ?? 'https://www.asamblea.go.cr/glcp';
const SP_TIMEOUT_MS = 15_000;

const COMMON_HEADERS = {
  Accept: 'application/json;odata=verbose',
  'User-Agent': 'shift-cl2/1.0 (+https://cl2.shiftlab.io; contact: madebyjred@gmail.com)',
} as const;

export interface SharePointList {
  Id: string;                                 // GUID
  Title: string;
  ItemCount: number;
  LastItemModifiedDate: string;               // ISO timestamp
  Description?: string;
  Hidden: boolean;
}

export interface SharePointItemRaw {
  Id: number;
  Title?: string | null;
  Created?: string;
  Modified?: string;
  AuthorId?: number;
  EditorId?: number;
  // Lists carry arbitrary fields beyond Id/Title — preserve everything.
  [k: string]: unknown;
}

interface ODataEnvelope<T> {
  d: {
    results?: T[];
    __next?: string;
  } | T;
}

interface ODataListEnvelope {
  d: { results: SharePointList[] };
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const res = await fetch(url, { headers: COMMON_HEADERS, signal });
          if (!res.ok) throw new Error(`${label} ${res.status}`);
          return (await res.json()) as T;
        },
        { ms: SP_TIMEOUT_MS, label },
      ),
    {
      attempts: 3,
      baseDelayMs: 500,
      label,
      // 4xx other than 429 = bug, fail fast. 5xx + 429 = retry.
      shouldRetry: (err) => {
        const m = (err as Error)?.message ?? '';
        const code = m.match(/ (\d{3})$/)?.[1];
        if (!code) return true;
        const n = Number(code);
        return n === 429 || n >= 500;
      },
    },
  );
}

/**
 * Enumerate every list in the /glcp site. Returns visible non-system lists
 * with their GUID, name, and modified date — caller picks the relevant ones
 * (iniciativas, mociones, dictámenes, votaciones, actas, leyes aprobadas).
 */
export async function listSharePointLists(): Promise<SharePointList[]> {
  const url = `${SIL_BASE}/_api/web/lists`;
  const env = await fetchJson<ODataListEnvelope>(url, 'sil:lists');
  return (env.d.results ?? []).filter((l) => !l.Hidden);
}

/**
 * Async iterator over every item in a list. Handles `__next` pagination
 * transparently; caller just awaits the iterator and gets all rows. Stops
 * after `maxPages` iterations as a safety valve (default unbounded).
 *
 * Items come straight from SharePoint — fields vary by list, so the caller
 * is responsible for narrowing the shape.
 */
export async function* iterateListItems(
  listGuid: string,
  opts: {
    /** ISO datetime — only items Modified > this are returned (delta crawl). */
    modifiedSince?: string;
    /** OData $select to reduce payload (optional). */
    select?: string[];
    /** OData $orderby clause (optional). */
    orderBy?: string;
    /** Hard cap on pages to fetch (safety; ~5000 items at $top=2000). */
    maxPages?: number;
  } = {},
): AsyncGenerator<SharePointItemRaw> {
  const params = new URLSearchParams();
  // Force the largest page size SP allows. At $top=2000 a list of 25k items
  // takes 13 round-trips instead of 250.
  params.set('$top', '2000');
  if (opts.select?.length) params.set('$select', opts.select.join(','));
  if (opts.orderBy) params.set('$orderby', opts.orderBy);

  const filters: string[] = [];
  if (opts.modifiedSince) {
    // datetime' literal is what SP OData v3 expects for date columns.
    filters.push(`Modified gt datetime'${opts.modifiedSince}'`);
  }
  if (filters.length) params.set('$filter', filters.join(' and '));

  let nextUrl: string | null = `${SIL_BASE}/_api/web/lists(guid'${listGuid}')/items?${params.toString()}`;
  let page = 0;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;

  while (nextUrl && page < maxPages) {
    const env = await fetchJson<ODataEnvelope<SharePointItemRaw>>(
      nextUrl,
      `sil:items:${listGuid.slice(0, 8)}:p${page}`,
    );
    const data = env.d as { results: SharePointItemRaw[]; __next?: string };
    const rows = data.results ?? [];
    for (const r of rows) yield r;
    nextUrl = data.__next ?? null;
    page += 1;
    // Light politeness delay between pages — gov server, no need to hammer.
    if (nextUrl) await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Drain an async iterator into an array with progress reporting. Use only
 * for lists you're confident are bounded (≪ 100k items); otherwise stream
 * directly into the database in the worker.
 */
export async function collectAll<T>(
  it: AsyncIterable<T>,
  onProgress?: (count: number) => void,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) {
    out.push(item);
    if (onProgress && out.length % 500 === 0) onProgress(out.length);
  }
  return out;
}
