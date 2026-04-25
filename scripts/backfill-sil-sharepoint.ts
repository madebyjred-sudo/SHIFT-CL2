/**
 * shift-cl2 — SIL SharePoint backfill (Day 1).
 *
 * Pulls structured legislative data from /glcp/_api/web/lists OData endpoint
 * into Supabase: sil_iniciativas, sil_mociones, sil_votaciones, sil_leyes_aprobadas.
 *
 * Pre-req:
 *   - migration 0005_sil_corpus.sql applied on Supabase
 *   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL set
 *
 * Run:   npm run backfill:sil:sharepoint
 * Time:  ~30-60 min for the six target lists (~60k rows total).
 *
 * Idempotent: ON CONFLICT updates rows by (list_guid, sharepoint_id).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  iterateListItems,
  listSharePointLists,
  type SharePointItemRaw,
} from '../apps/api/src/services/silSharePointClient.js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('[backfill] missing Supabase env');
  process.exit(1);
}
const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

// Lists worth backfilling, by visible Title (we resolve to GUID at runtime).
// The names match what the recon agent observed on /glcp/. If the SIL
// renames a list, the script logs the discrepancy and skips that one
// rather than crashing.
const TARGET_LISTS = [
  { title: 'Todas las iniciativas', table: 'sil_iniciativas' as const, mapper: mapIniciativa },
  { title: 'Lista_Mociones', table: 'sil_mociones' as const, mapper: mapMocion },
  { title: 'mociones_total', table: 'sil_mociones' as const, mapper: mapMocion },
  { title: 'res_de_leyes', table: 'sil_leyes_aprobadas' as const, mapper: mapLey },
];

type SilTable = 'sil_iniciativas' | 'sil_mociones' | 'sil_votaciones' | 'sil_leyes_aprobadas';

interface MappedRow {
  table: SilTable;
  row: Record<string, unknown>;
}

// ─── Field mappers ────────────────────────────────────────────────────

function mapIniciativa(item: SharePointItemRaw, listGuid: string): MappedRow {
  const get = (k: string): string | null => {
    const v = item[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    table: 'sil_iniciativas',
    row: {
      sharepoint_id: item.Id,
      list_guid: listGuid,
      expediente_numero: get('NumeroExpediente') ?? get('Title'),
      titulo: get('Asunto') ?? get('Title') ?? null,
      tipo_iniciativa: get('Tipo_de_Iniciativa') ?? get('TipoIniciativa') ?? null,
      fecha_recibido: parseSpDate(get('Fecha_recibido') ?? get('FechaRecibido')),
      asunto: get('Asunto'),
      recibido_por: get('Recibido_por') ?? get('RecibidoPor'),
      raw: item,
      created_at_sp: get('Created'),
      modified_at_sp: get('Modified'),
    },
  };
}

function mapMocion(item: SharePointItemRaw, _listGuid: string): MappedRow {
  const get = (k: string): string | null => {
    const v = item[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    table: 'sil_mociones',
    row: {
      sharepoint_id: item.Id,
      expediente_numero: get('NumeroExpediente') ?? null,
      titulo: get('Title') ?? get('Asunto'),
      proponente: get('Proponente') ?? get('Diputado'),
      fecha: parseSpDate(get('Fecha') ?? get('Modified')),
      tipo_mocion: get('TipoMocion') ?? null,
      resultado: get('Resultado') ?? null,
      raw: item,
    },
  };
}

function mapLey(item: SharePointItemRaw, _listGuid: string): MappedRow {
  const get = (k: string): string | null => {
    const v = item[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    table: 'sil_leyes_aprobadas',
    row: {
      sharepoint_id: item.Id,
      numero_ley: get('NumeroLey') ?? get('Title'),
      expediente_numero: get('NumeroExpediente'),
      titulo: get('Asunto') ?? get('Title'),
      fecha_publicacion: parseSpDate(get('FechaPublicacion') ?? get('Created')),
      gaceta: get('Gaceta'),
      raw: item,
    },
  };
}

function parseSpDate(input: string | null): string | null {
  if (!input) return null;
  // SharePoint OData returns ISO 8601 — Date.parse handles it.
  const t = Date.parse(input);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// ─── Run ──────────────────────────────────────────────────────────────

async function run() {
  console.log('[backfill] enumerating SharePoint lists…');
  const lists = await listSharePointLists();
  console.log(`[backfill] discovered ${lists.length} lists`);

  // crawl_runs row for observability — single row covers the whole script.
  const { data: crawlRow } = await supa
    .from('sil_crawl_runs')
    .insert({
      source: 'sharepoint_odata',
      list_or_target: TARGET_LISTS.map((t) => t.title).join(','),
    })
    .select('id')
    .single();
  const crawlId = crawlRow?.id ?? null;

  let totalIn = 0;
  let totalOut = 0;
  let totalErrors = 0;

  for (const target of TARGET_LISTS) {
    const list = lists.find((l) => l.Title === target.title);
    if (!list) {
      console.warn(`[backfill] list "${target.title}" not found — skipping`);
      continue;
    }
    console.log(`[backfill] → ${list.Title} (${list.Id}, ItemCount=${list.ItemCount})`);

    const buffer: Record<string, unknown>[] = [];
    let pageCount = 0;

    for await (const item of iterateListItems(list.Id)) {
      totalIn += 1;
      try {
        const mapped = target.mapper(item, list.Id);
        buffer.push(mapped.row);
      } catch (err) {
        totalErrors += 1;
        console.error(`[backfill] map error item ${item.Id}: ${(err as Error).message}`);
      }

      // Flush in batches of 500 to keep memory bounded and write throughput high.
      if (buffer.length >= 500) {
        const inserted = await flush(target.table, buffer);
        totalOut += inserted;
        buffer.length = 0;
        pageCount += 1;
        if (pageCount % 4 === 0) {
          console.log(`[backfill]   ${list.Title}: ${totalOut} written`);
        }
      }
    }
    if (buffer.length > 0) {
      const inserted = await flush(target.table, buffer);
      totalOut += inserted;
    }
    console.log(`[backfill]   ${list.Title}: done, ${totalOut} cumulative writes`);
  }

  if (crawlId) {
    await supa
      .from('sil_crawl_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in: totalIn,
        rows_out: totalOut,
        errors: totalErrors,
        status: totalErrors === 0 ? 'success' : 'partial',
      })
      .eq('id', crawlId);
  }

  console.log(`[backfill] DONE — in=${totalIn} out=${totalOut} errors=${totalErrors}`);
}

async function flush(table: SilTable, rows: Record<string, unknown>[]): Promise<number> {
  // Upsert by SharePoint id; tables have unique constraints (or could).
  // sil_iniciativas: unique (list_guid, sharepoint_id) — split conflict target.
  const onConflict =
    table === 'sil_iniciativas' ? 'list_guid,sharepoint_id' : undefined;
  const { error, count } = await supa.from(table).upsert(rows, {
    onConflict,
    ignoreDuplicates: false,
    count: 'exact',
  });
  if (error) {
    console.error(`[backfill] upsert ${table} error: ${error.message}`);
    return 0;
  }
  return count ?? rows.length;
}

run().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
