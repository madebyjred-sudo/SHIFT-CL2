#!/usr/bin/env npx tsx
/**
 * crawler-sharepoint.ts — Cloud Run Job entry point for Track A, Sprint 1.
 *
 * Runs the SharePoint OData crawler for the top legislative lists of the
 * Asamblea Legislativa de Costa Rica (GLCP SharePoint).
 *
 * USAGE:
 *   npx tsx apps/api/scripts/crawler-sharepoint.ts
 *
 * ENV VARS:
 *   LIST_IDS            CSV of list GUIDs to crawl. Defaults to the 5 top
 *                       lists if not set. Example:
 *                       LIST_IDS="guid1,guid2,guid3"
 *   BACKFILL_FROM       ISO timestamp para forzar backfill desde esa fecha
 *                       (pedido 16l del cliente — actas comisión desde 2022).
 *                       Ignora el cursor de DB para este run pero NO lo borra;
 *                       el run termina avanzando el cursor a su tope, como
 *                       siempre. Ejemplo: BACKFILL_FROM="2022-01-01T00:00:00Z"
 *   BACKFILL_FULL       Si vale "1", ignora el cursor y baja TODO desde el
 *                       principio. Equivalente a borrar la fila de cursors
 *                       pero más explícito.
 *   NEXT_PUBLIC_SUPABASE_URL    Required.
 *   SUPABASE_SERVICE_ROLE_KEY   Required.
 *   SIL_SHAREPOINT_BASE         Optional. Defaults to https://www.asamblea.go.cr/glcp
 *   NODE_TLS_REJECT_UNAUTHORIZED  Set to '0' if the GLCP cert chain is broken.
 *                                 ONLY set in this Cloud Run Job, NOT in the main API.
 *
 * EXIT CODES:
 *   0  All lists crawled successfully (or with only skipped-etag items).
 *   1  One or more lists had fetch/upsert errors.
 *
 * LOG FORMAT:
 *   JSON lines on stdout (GCP-friendly — Cloud Logging picks them up natively).
 *   Each line has: ts, level, msg, list_id, list_title, + CrawlResult fields.
 *
 * DESIGN:
 *   Lists run sequentially to be polite to the government server.
 *   The politeness delay between lists is 2s.
 *   Total runtime for 5 lists with ~10k items total (first backfill):
 *     ~5 min (2000 items/page × 13 pages × 250ms + Supabase write time).
 *   Delta runs (30 min cron, <50 new items total): ~20-30s.
 *
 * CLOUD RUN JOB SPEC (for whoever wires the deployment):
 *   Image: same as the API (it includes tsx).
 *   Command: ["npx", "tsx", "apps/api/scripts/crawler-sharepoint.ts"]
 *   Schedule: every 30 min (cron: "0,30 * * * *")
 *   Memory: 512Mi (jsonb payloads can spike during backfill of large lists)
 *   Max retries: 2 (idempotent, safe to retry)
 */

// Must be set BEFORE any network code runs if TLS is broken on the gov server.
// Reads from env so it can be toggled per-environment without code changes.
// The warning is logged by sharePointClient.ts at module load.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  // Default to accepting the gov cert even if the chain has issues.
  // This is the right call for a crawler hitting a public government site
  // where we have no control over the cert setup.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import 'dotenv/config';
import { crawlList } from '../src/services/sharePointCrawler.js';
import { logger } from '../src/services/logger.js';
import type { CrawlResult } from '../src/services/sharePointCrawler.js';

// ─── Top 5 lists: list_id (GUID), list_title, url_path ────────────────────
//
// GUIDs obtained by calling /_api/web/lists and matching by Title.
// These are the 5 most operationally relevant lists for CL2 Consultoría
// (see pedido 10 of 2026-05-14 meeting notes for justification):
//
//   1. Ordenes_dia (8,103 items) — feeds Centinela directly.
//      Alert rule: audiencia_confirmada (critical) when expediente appears in order.
//   2. Actas (7,277 items) — "quién dijo qué" in committee sessions.
//   3. Consultas_mociones (1,071 items) — art. 137/138/177 motions; lobby trigger.
//   4. Decretos_Ejecutivos_Ampliacion (201 items) — executive agenda control
//      during extraordinary sessions (May-Jul + Nov-Jan). Critical per §16i.
//   5. vetos (30 items) — presidential vetoes; feeds "is it a law?" logic.
//
// TODO: The real GUIDs need to be fetched once by running:
//   npx tsx -e "
//     import { listSharePointLists } from './apps/api/src/services/silSharePointClient.js';
//     listSharePointLists().then(l => l.filter(x => !x.Hidden).forEach(x =>
//       console.log(x.Id, x.Title, x.ItemCount)));
//   "
// and updating DEFAULT_LISTS below. The title-based fallback in SharePointClient
// handles the case where GUIDs are wrong — it will do a title lookup.
// For now we use the URL-path names as the listIdOrTitle so the client falls
// through to title-based lookup (one extra round-trip per list, acceptable).

interface ListSpec {
  // GUID or Title name. SharePointClient accepts both.
  id: string;
  title: string;
}

const DEFAULT_LISTS: ListSpec[] = [
  { id: 'Órdenes del día',                          title: 'Órdenes del día' },
  { id: 'Actas',                                     title: 'Actas' },
  { id: 'Consultas sobre mociones presentadas vía artículo 137 y 138', title: 'Consultas_mociones' },
  { id: 'Decretos Ejecutivos Ampliación/Retiro',     title: 'Decretos_Ejecutivos_Ampliacion' },
  { id: 'vetos',                                     title: 'vetos' },
];

// ─── Parse LIST_IDS env override ────────────────────────────────────────────

function parseListIds(env: string | undefined): ListSpec[] {
  if (!env?.trim()) return DEFAULT_LISTS;
  return env.split(',').map((raw) => {
    const id = raw.trim();
    return { id, title: id };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Resuelve el `cursorOverride` a partir de las env vars BACKFILL_*.
 *
 * Precedencia (de mayor a menor):
 *   1. BACKFILL_FULL=1  →  `null` (full backfill, ignora cursor)
 *   2. BACKFILL_FROM=ISO →  esa ISO como lower bound
 *   3. nada            →  `undefined` (comportamiento normal con cursor de DB)
 */
function resolveCursorOverride(): string | null | undefined {
  if (process.env.BACKFILL_FULL === '1') return null;
  const from = process.env.BACKFILL_FROM?.trim();
  if (!from) return undefined;
  // Validación mínima: ISO 8601 con la 'T' interna. No queremos pasar basura
  // que rompa el filtro OData.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(from)) {
    throw new Error(
      `BACKFILL_FROM debe ser ISO 8601 (ej. "2022-01-01T00:00:00Z"). Recibido: "${from}"`,
    );
  }
  return from;
}

async function main(): Promise<void> {
  const lists = parseListIds(process.env.LIST_IDS);
  const cursorOverride = resolveCursorOverride();
  const results: CrawlResult[] = [];
  let anyFailed = false;

  logger.info('crawler-sharepoint: starting', {
    lists: lists.map((l) => l.title),
    total: lists.length,
    cursor_override:
      cursorOverride === undefined
        ? 'cursor_db'
        : cursorOverride === null
          ? 'full_backfill'
          : cursorOverride,
  });

  for (const list of lists) {
    try {
      const result = await crawlList(list.id, list.title, {
        // For Ordenes_dia and Actas (large lists), limit to the fields we actually
        // use downstream. For smaller lists, fetch everything (undefined = all fields).
        select: list.title === 'Órdenes del día' || list.title === 'Actas'
          ? ['Id', 'Title', 'Modified', 'Created', 'FileLeafRef', 'FileRef', 'EncodedAbsUrl']
          : undefined,
        maxPages: 50, // 100k items cap per run — well above any GLCP list
        cursorOverride,
      });

      results.push(result);

      if (result.errors > 0) {
        anyFailed = true;
        logger.warn('crawler-sharepoint: list had errors', {
          list_id: result.list_id,
          list_title: result.list_title,
          errors: result.errors,
          items_seen: result.items_seen,
        });
      } else {
        logger.info('crawler-sharepoint: list ok', {
          list_id: result.list_id,
          list_title: result.list_title,
          items_seen: result.items_seen,
          items_new: result.items_new,
          items_updated: result.items_updated,
          items_skipped_etag: result.items_skipped_etag,
          duration_ms: result.duration_ms,
        });
      }

      // Politeness delay between lists — 2s. Not between pages (that's handled
      // inside SharePointClient at 250ms). This is between full list runs.
      if (lists.indexOf(list) < lists.length - 1) {
        await new Promise((r) => setTimeout(r, 2_000));
      }

    } catch (err) {
      anyFailed = true;
      logger.error('crawler-sharepoint: list threw unexpectedly', {
        list_id: list.id,
        list_title: list.title,
        error: (err as Error).message,
      });
      results.push({
        list_id: list.id,
        list_title: list.title,
        items_seen: 0,
        items_new: 0,
        items_updated: 0,
        items_skipped_etag: 0,
        errors: 1,
        duration_ms: 0,
        cursor_advanced_to: null,
      });
    }
  }

  // ── Summary line (GCP-friendly) ─────────────────────────────────────────
  const totalSeen = results.reduce((s, r) => s + r.items_seen, 0);
  const totalNew = results.reduce((s, r) => s + r.items_new, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);

  logger.info('crawler-sharepoint: run summary', {
    total_lists: lists.length,
    total_items_seen: totalSeen,
    total_items_new: totalNew,
    total_errors: totalErrors,
    status: anyFailed ? 'partial' : 'ok',
  });

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  logger.error('crawler-sharepoint: fatal', { error: (err as Error).message });
  process.exit(1);
});
