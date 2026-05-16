#!/usr/bin/env npx tsx
/**
 * crawler-lista-despacho.ts — Sprint 3 Track R.
 *
 * Crawler dedicado para la "Lista de despacho" del SharePoint GLCP de la
 * Asamblea Legislativa CR. Sigue el patrón de `crawler-sharepoint.ts` pero
 * con tres diferencias clave:
 *
 *   1. La lista NO tiene GUID conocido. El cliente la mencionó con varios
 *      nombres posibles ("Lista_Despacho", "Despacho", "Lista de despacho").
 *      Usamos `listSharePointLists()` + fuzzy match por title para encontrarla.
 *   2. Upsert al schema dedicado `lista_despacho_items` (no a `sil_sharepoint_raw`),
 *      parseando expediente_id + fecha_entrada del payload de cada row.
 *   3. Idempotente por (expediente_id, fecha_entrada) — el UNIQUE de la tabla
 *      protege contra duplicados aunque el cursor falle.
 *
 * USAGE:
 *   npx tsx apps/api/scripts/crawler-lista-despacho.ts
 *
 * ENV VARS:
 *   LISTA_DESPACHO_TITLE         Override del título a buscar. Default:
 *                                tries "Lista de despacho", "Lista_Despacho",
 *                                "Despacho" — el primero que matchee gana.
 *   LISTA_DESPACHO_LIST_ID       Override directo del GUID si ya se conoce.
 *                                Si se setea, salta el discovery.
 *   NEXT_PUBLIC_SUPABASE_URL     Required.
 *   SUPABASE_SERVICE_ROLE_KEY    Required.
 *   SIL_SHAREPOINT_BASE          Default https://www.asamblea.go.cr/glcp
 *   NODE_TLS_REJECT_UNAUTHORIZED Default '0' (gov cert chain is broken).
 *
 * EXIT CODES:
 *   0  → run OK (incluso si 0 items nuevos).
 *   1  → fetch o upsert falló.
 *   2  → discovery falló: ninguno de los títulos candidatos matcheó.
 *
 * NOTAS DE OPERACIÓN:
 *   - El crawler es idempotente. Si se interrumpe a mitad y se re-corre,
 *     re-upsertea sin duplicar (UNIQUE expediente_id, fecha_entrada).
 *   - El cursor `sharepoint_cursors` se actualiza al final para que el
 *     próximo delta sea barato.
 *   - Si la lista NO existe en el SharePoint todavía (porque el SharePoint
 *     no se ha publicado o el nombre cambió), corre `seed-lista-despacho.ts`
 *     para tener 20 items de demo y no bloquear la UI.
 *
 * Source: AGENTS/CL2/sprints/2026-05-16-sprint-2-3-design-doc.md Track R.
 */

// Like crawler-sharepoint.ts: aceptar el cert del gov server por default.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  listSharePointLists,
  type SharePointList,
} from '../src/services/silSharePointClient.js';
import { SharePointClient } from '../src/services/sharePointClient.js';
import { logger } from '../src/services/logger.js';
import {
  ingestListaDespachoItem,
  type RawDespachoRow,
} from '../src/services/listaDespachoMatcher.js';

const CANDIDATE_TITLES = [
  'Lista de despacho',
  'Lista_Despacho',
  'Despacho',
  'Lista despacho',
  'Listado de Despacho',
];

interface RunResult {
  list_id: string;
  list_title: string;
  items_seen: number;
  items_new: number;
  items_skipped_dup: number;
  errors: number;
  duration_ms: number;
}

// ─── Discovery: encontrar el GUID real de la lista ───────────────────────────

/**
 * Busca la lista de despacho por fuzzy match contra los títulos candidatos.
 *
 *   1. Si LISTA_DESPACHO_LIST_ID está seteado, lo usa directamente.
 *   2. Si LISTA_DESPACHO_TITLE está seteado, busca ese título exacto.
 *   3. Si no, itera CANDIDATE_TITLES por similitud (case-insensitive +
 *      coincidencia parcial).
 *
 * Returns null si ninguna coincide. El caller decide qué hacer (exit 2 o
 * fallback a seed).
 */
async function discoverList(): Promise<SharePointList | null> {
  const overrideId = process.env.LISTA_DESPACHO_LIST_ID?.trim();
  const overrideTitle = process.env.LISTA_DESPACHO_TITLE?.trim();

  // Caso 1: GUID directo. No hace falta listar.
  if (overrideId) {
    logger.info('crawler-lista-despacho: using LISTA_DESPACHO_LIST_ID override', {
      list_id: overrideId,
    });
    return {
      Id: overrideId,
      Title: overrideTitle ?? 'Lista de despacho (override)',
      ItemCount: -1, // unknown
      LastItemModifiedDate: new Date().toISOString(),
      Hidden: false,
    };
  }

  const lists = await listSharePointLists();

  // Caso 2: título exacto vía env. Match case-insensitive sin más.
  if (overrideTitle) {
    const exact = lists.find(
      (l) => l.Title.toLowerCase() === overrideTitle.toLowerCase(),
    );
    if (exact) return exact;
    logger.warn('crawler-lista-despacho: LISTA_DESPACHO_TITLE no matcheó', {
      override_title: overrideTitle,
      lists_total: lists.length,
    });
    return null;
  }

  // Caso 3: fuzzy contra candidates. Prioridad: igualdad exacta, luego "includes".
  for (const candidate of CANDIDATE_TITLES) {
    const lower = candidate.toLowerCase();
    const exact = lists.find((l) => l.Title.toLowerCase() === lower);
    if (exact) return exact;
  }
  for (const candidate of CANDIDATE_TITLES) {
    const lower = candidate.toLowerCase();
    const fuzzy = lists.find(
      (l) =>
        l.Title.toLowerCase().includes(lower) ||
        lower.includes(l.Title.toLowerCase()),
    );
    if (fuzzy) return fuzzy;
  }

  logger.warn('crawler-lista-despacho: ningún candidato matcheó en SharePoint', {
    candidates: CANDIDATE_TITLES,
    lists_total: lists.length,
    lists_visibles: lists
      .filter((l) => !l.Hidden)
      .slice(0, 20)
      .map((l) => l.Title),
  });
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMs = Date.now();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    logger.error('crawler-lista-despacho: missing supabase env');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1. Discovery
  const list = await discoverList();
  if (!list) {
    logger.error('crawler-lista-despacho: lista no encontrada', {
      hint: 'corré `npx tsx apps/api/scripts/seed-lista-despacho.ts` ' +
            'para seedear 20 items demo mientras se aclara el título.',
    });
    process.exit(2);
  }

  logger.info('crawler-lista-despacho: lista encontrada', {
    list_id: list.Id,
    list_title: list.Title,
    item_count: list.ItemCount,
  });

  // 2. Cursor — para delta queries.
  const { data: cursorRow } = await db
    .from('sharepoint_cursors')
    .select('list_id, last_modified')
    .eq('list_id', list.Id)
    .maybeSingle();

  const lastModified = (cursorRow as { last_modified: string | null } | null)
    ?.last_modified ?? null;

  // 3. Iterate items
  const client = new SharePointClient();
  const result: RunResult = {
    list_id: list.Id,
    list_title: list.Title,
    items_seen: 0,
    items_new: 0,
    items_skipped_dup: 0,
    errors: 0,
    duration_ms: 0,
  };

  const filter = lastModified ? `Modified gt datetime'${lastModified}'` : undefined;
  let maxModifiedSeen: string | null = null;

  try {
    for await (const item of client.listItems(list.Id, {
      filter,
      orderby: 'Modified asc',
      maxPages: 20, // 40k items cap, well above lista de despacho size
    })) {
      result.items_seen++;
      if (item.Modified && (!maxModifiedSeen || item.Modified > maxModifiedSeen)) {
        maxModifiedSeen = item.Modified;
      }

      try {
        const outcome = await ingestListaDespachoItem(
          item as RawDespachoRow,
          db,
        );
        if (outcome === 'new') result.items_new++;
        else if (outcome === 'duplicate') result.items_skipped_dup++;
      } catch (err) {
        result.errors++;
        logger.warn('crawler-lista-despacho: ingest failed', {
          item_id: (item as Record<string, unknown>).Id,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    result.errors++;
    logger.error('crawler-lista-despacho: fetch error', {
      error: (err as Error).message,
    });
  }

  // 4. Update cursor — incluso si hubo errors, avanzamos lo que vimos.
  // Si todo falló (items_seen=0 con maxModifiedSeen=null), NO avanzamos
  // (evita bug de "cursor avanzó sin haber procesado items" que pasó con
  // Actas en Sprint 2 — ver STATE.md sección "Deuda menor del sprint").
  if (maxModifiedSeen) {
    await db.from('sharepoint_cursors').upsert(
      {
        list_id: list.Id,
        list_title: list.Title,
        last_modified: maxModifiedSeen,
        last_run_at: new Date().toISOString(),
        last_run_status: result.errors > 0 ? 'partial' : 'ok',
        last_error: result.errors > 0 ? `${result.errors} items failed` : null,
      },
      { onConflict: 'list_id' },
    );
  }

  result.duration_ms = Date.now() - startMs;
  logger.info('crawler-lista-despacho: run complete', result);
  process.exit(result.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error('crawler-lista-despacho: fatal', { error: (err as Error).message });
  process.exit(1);
});
