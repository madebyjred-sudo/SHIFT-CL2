/**
 * shift-cl2 — Job A: Ingest RAL (Reglamento de la Asamblea) into legislative_chunks.
 *
 * Source tables:
 *   - ral_articulos          (486 rows): texto_normativo, numero, capitulo, titulo_seccion, inciso
 *   - ral_interpretaciones   (195 rows): texto_interpretacion + fuente_* metadata, FK -> ral_articulos
 *
 * Output: legislative_chunks rows with source_type='reglamento'.
 *   - source_ref scheme:
 *       ral_articulo_<numero>[/<inciso>]
 *       ral_interpretacion_<articulo_numero>_<id_prefix>
 *   - metadata.subtype = 'ral_articulo' | 'ral_interpretacion' (so search can filter
 *     beyond what the existing check constraint allows).
 *
 * Idempotency:
 *   Pass --clear to wipe previously-inserted RAL chunks before re-inserting.
 *   The --clear path requires a full table scan filter on source_type=
 *   'reglamento' AND metadata->>subtype='ral_*', which can time out on
 *   Supabase's statement-timeout because there's no index on source_type
 *   (only session_id is indexed on legislative_chunks). For safer
 *   idempotency in production, add an index via migration and toggle this.
 *
 *   Default behavior (without --clear): skip cleanup. Re-runs will create
 *   duplicate chunks. The first run is always clean.
 *
 * Note on source_type:
 *   The legislative_chunks_source_type_check constraint (migration 0006) allows
 *   'reglamento' but NOT 'ral_articulo' / 'ral_interpretacion'. We reuse
 *   'reglamento' and disambiguate via metadata.subtype, since adding a migration
 *   would require a deploy (out of scope for this job).
 *
 * Modes:
 *   --dry         No DB writes, no Vertex calls. Print what would happen.
 *   --probe       Embed + insert only the first 10 articulos + first 10
 *                 interpretaciones (cheap sanity check before full run).
 *   --articulos   Only process ral_articulos.
 *   --interps     Only process ral_interpretaciones.
 *   (default)     Process both, full corpus.
 *
 * Run (probe):
 *   cd /Users/juan/Downloads/shift-cl2
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx -r dotenv/config \
 *     apps/api/scripts/ingest-ral-chunks.ts dotenv_config_path=.env.local --probe
 *
 * Run (full):
 *   cd /Users/juan/Downloads/shift-cl2
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx -r dotenv/config \
 *     apps/api/scripts/ingest-ral-chunks.ts dotenv_config_path=.env.local
 *
 * Expected time: 486 + 195 = 681 embeds @ concurrency 4 ~= 5-8 min for full run.
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const PROBE = args.includes('--probe');
const CLEAR = args.includes('--clear');
const ONLY_ARTICULOS = args.includes('--articulos');
const ONLY_INTERPS = args.includes('--interps');

const RUN_ARTICULOS = !ONLY_INTERPS;
const RUN_INTERPS = !ONLY_ARTICULOS;

// ─── Env ──────────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);

if (!SUPA_URL || !SUPA_KEY) {
  console.error('[ral-ingest] Supabase env missing');
  process.exit(1);
}
if (!GCP_PROJECT && !DRY) {
  console.error('[ral-ingest] GCP_PROJECT_ID missing');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !DRY) {
  console.error('[ral-ingest] GOOGLE_APPLICATION_CREDENTIALS missing');
  process.exit(1);
}

const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Vertex ───────────────────────────────────────────────────────────────────
const vertex = DRY
  ? null
  : new PredictionServiceClient({
      apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com`,
    });
const VERTEX_ENDPOINT = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;
const CONCURRENCY = 4;

async function embedOne(text: string): Promise<number[]> {
  if (DRY || !vertex) {
    // Return a deterministic stub of the right shape so downstream code is happy
    return new Array(EMBED_DIM).fill(0);
  }
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: EMBED_DIM });
  const [response] = await vertex.predict({
    endpoint: VERTEX_ENDPOINT,
    instances: instance ? [instance] : [],
    parameters,
  });
  const decoded = helpers.fromValue(response.predictions?.[0] as never) as {
    embeddings?: { values?: number[] };
  };
  const values = decoded?.embeddings?.values;
  if (!values || !Array.isArray(values)) throw new Error('vertex: missing embeddings.values');
  return values;
}

async function inFlight<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      let attempt = 0;
      // Retry up to 3x on transient errors.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          out[i] = await fn(items[i] as T, i);
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 600 * attempt));
        }
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Types from DB ────────────────────────────────────────────────────────────
interface RalArticuloRow {
  id: string;
  numero: string;
  inciso: string | null;
  capitulo: string | null;
  titulo_seccion: string | null;
  texto_normativo: string;
  edicion: string | null;
  vigente: boolean | null;
  source_pdf: string | null;
  source_pagina: number | null;
}

interface RalInterpretacionRow {
  id: string;
  articulo_id: string | null;
  articulo_numero: string | null;
  articulo_inciso: string | null;
  texto_interpretacion: string;
  fuente_tipo: string | null;
  fuente_cita: string | null;
  fuente_fecha: string | null;
  fuente_pdf: string | null;
  vigente: boolean | null;
  edicion: string | null;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchAllArticulos(limit?: number): Promise<RalArticuloRow[]> {
  const out: RalArticuloRow[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supa
      .from('ral_articulos')
      .select('id, numero, inciso, capitulo, titulo_seccion, texto_normativo, edicion, vigente, source_pdf, source_pagina')
      .order('numero', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`ral_articulos fetch error: ${error.message}`);
    out.push(...((data ?? []) as RalArticuloRow[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

async function fetchAllInterpretaciones(limit?: number): Promise<RalInterpretacionRow[]> {
  const out: RalInterpretacionRow[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supa
      .from('ral_interpretaciones')
      .select(
        'id, articulo_id, articulo_numero, articulo_inciso, texto_interpretacion, fuente_tipo, fuente_cita, fuente_fecha, fuente_pdf, vigente, edicion',
      )
      .order('articulo_numero', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`ral_interpretaciones fetch error: ${error.message}`);
    out.push(...((data ?? []) as RalInterpretacionRow[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

// ─── Idempotency: clear previous chunks ───────────────────────────────────────
async function clearPreviousRalChunks(): Promise<{ articulos: number; interps: number }> {
  // We can't trust counts with .delete().select() in all envs; we use two passes.
  let aDel = 0;
  let iDel = 0;

  if (RUN_ARTICULOS) {
    const { data, error } = await supa
      .from('legislative_chunks')
      .delete()
      .eq('source_type', 'reglamento')
      .filter('metadata->>subtype', 'eq', 'ral_articulo')
      .select('id');
    if (error) throw new Error(`clear ral_articulo chunks failed: ${error.message}`);
    aDel = data?.length ?? 0;
  }
  if (RUN_INTERPS) {
    const { data, error } = await supa
      .from('legislative_chunks')
      .delete()
      .eq('source_type', 'reglamento')
      .filter('metadata->>subtype', 'eq', 'ral_interpretacion')
      .select('id');
    if (error) throw new Error(`clear ral_interpretacion chunks failed: ${error.message}`);
    iDel = data?.length ?? 0;
  }
  return { articulos: aDel, interps: iDel };
}

// ─── Chunk shapers ────────────────────────────────────────────────────────────
function buildArticuloContent(row: RalArticuloRow): string {
  // Compose a rich, searchable chunk: titulo + capitulo + texto_normativo.
  const parts: string[] = [];
  const head = `Artículo ${row.numero}${row.inciso ? ` inciso ${row.inciso}` : ''}`;
  parts.push(head);
  if (row.titulo_seccion) parts.push(row.titulo_seccion);
  if (row.capitulo) parts.push(row.capitulo);
  parts.push(row.texto_normativo.trim());
  return parts.filter(Boolean).join('\n\n');
}

function buildInterpContent(row: RalInterpretacionRow): string {
  const parts: string[] = [];
  parts.push(
    `Interpretación oficial del Artículo ${row.articulo_numero ?? '?'}${
      row.articulo_inciso ? ` inciso ${row.articulo_inciso}` : ''
    } (${row.fuente_tipo ?? 'fuente_desconocida'})`,
  );
  if (row.fuente_cita) parts.push(`Fuente: ${row.fuente_cita}`);
  parts.push(row.texto_interpretacion.trim());
  return parts.filter(Boolean).join('\n\n');
}

interface ChunkRow {
  session_id: null;
  source_type: 'reglamento';
  source_ref: string;
  chunk_index: number;
  content: string;
  embedding: string;
  metadata: Record<string, unknown>;
}

// ─── Insert helper ────────────────────────────────────────────────────────────
const INSERT_BATCH = 50;

async function insertChunks(rows: ChunkRow[], label: string): Promise<{ inserted: number; ids: string[] }> {
  if (DRY) {
    console.log(`[ral-ingest][dry][${label}] would insert ${rows.length} rows`);
    return { inserted: rows.length, ids: [] };
  }
  let inserted = 0;
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const { error, data } = await supa
      .from('legislative_chunks')
      .insert(slice)
      .select('id');
    if (error) {
      console.error(`[ral-ingest][${label}] insert batch ${i} failed: ${error.message}`);
      throw new Error(error.message);
    }
    inserted += data?.length ?? slice.length;
    for (const r of data ?? []) ids.push((r as { id: string }).id);
  }
  return { inserted, ids };
}

// ─── Verify helper ────────────────────────────────────────────────────────────
async function verifyEmbeddingShapeById(id: string): Promise<{ ok: boolean; dim: number; message?: string }> {
  const { data, error } = await supa
    .from('legislative_chunks')
    .select('id, embedding')
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, dim: 0, message: error.message };
  if (!data) return { ok: false, dim: 0, message: 'row not found by id' };
  const emb = (data as { embedding: unknown }).embedding;
  if (typeof emb === 'string') {
    const dim = emb.split(',').length;
    return { ok: dim === EMBED_DIM, dim };
  }
  if (Array.isArray(emb)) {
    return { ok: emb.length === EMBED_DIM, dim: emb.length };
  }
  return { ok: false, dim: 0, message: `embedding has unexpected type ${typeof emb}` };
}

// ─── Driver ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[ral-ingest] start. dry=${DRY} probe=${PROBE} articulos=${RUN_ARTICULOS} interps=${RUN_INTERPS} embed=${EMBED_MODEL}/${EMBED_DIM}d`,
  );

  const t0 = Date.now();

  const limit = PROBE ? 10 : undefined;
  const articulos = RUN_ARTICULOS ? await fetchAllArticulos(limit) : [];
  const interps = RUN_INTERPS ? await fetchAllInterpretaciones(limit) : [];
  console.log(`[ral-ingest] fetched ${articulos.length} articulos, ${interps.length} interpretaciones`);

  if (!DRY && !PROBE && CLEAR) {
    console.log('[ral-ingest] --clear: clearing previous RAL chunks (may time out on Supabase)…');
    try {
      const cleared = await clearPreviousRalChunks();
      console.log(`[ral-ingest]   cleared: articulos=${cleared.articulos} interps=${cleared.interps}`);
    } catch (err) {
      console.warn(`[ral-ingest] --clear failed: ${(err as Error).message}`);
      console.warn('[ral-ingest] continuing without clearing — duplicates possible. Add an index on source_type to enable safe re-runs.');
    }
  } else if (!DRY && !PROBE && !CLEAR) {
    console.log('[ral-ingest] WARN: skipping pre-clear (--clear not passed). Re-running this script will create duplicates.');
  } else if (PROBE) {
    // In probe mode we skip pre-clear: the source_ref/source_type filter is
    // not indexed and times out on the 800k-row table. Probe duplicates are
    // a minor cost — easy to spot via metadata.embedded_at recency.
    console.log('[ral-ingest][probe] skipping pre-clear (probe mode — duplicates by source_ref are expected if re-run)');
  }

  // ─── Process articulos ──────────────────────────────────────────────────────
  let articulosInserted = 0;
  let articulosIds: string[] = [];
  if (RUN_ARTICULOS && articulos.length > 0) {
    console.log(`[ral-ingest] embedding ${articulos.length} articulos…`);
    const tEmbed = Date.now();
    const embeddings = await inFlight(articulos, CONCURRENCY, async (row) =>
      embedOne(buildArticuloContent(row)),
    );
    console.log(
      `[ral-ingest]   embedded in ${Math.round((Date.now() - tEmbed) / 1000)}s (avg ${
        Math.round((Date.now() - tEmbed) / articulos.length)
      }ms/row)`,
    );

    const rows: ChunkRow[] = articulos.map((row, idx) => ({
      session_id: null,
      source_type: 'reglamento',
      source_ref: `ral_articulo_${row.numero}${row.inciso ? `_${row.inciso}` : ''}`,
      chunk_index: idx,
      content: buildArticuloContent(row),
      embedding: JSON.stringify(embeddings[idx]),
      metadata: {
        subtype: 'ral_articulo',
        ral_articulo_id: row.id,
        numero: row.numero,
        inciso: row.inciso ?? undefined,
        capitulo: row.capitulo ?? undefined,
        titulo_seccion: row.titulo_seccion ?? undefined,
        edicion: row.edicion ?? undefined,
        vigente: row.vigente ?? undefined,
        source_pdf: row.source_pdf ?? undefined,
        source_pagina: row.source_pagina ?? undefined,
        embedded_at: new Date().toISOString(),
        embedded_by: 'ingest-ral-chunks',
      },
    }));

    const ar = await insertChunks(rows, 'articulos');
    articulosInserted = ar.inserted;
    articulosIds = ar.ids;
    console.log(`[ral-ingest]   inserted ${articulosInserted} articulos chunks`);
  }

  // ─── Process interpretaciones ───────────────────────────────────────────────
  let interpsInserted = 0;
  let interpsIds: string[] = [];
  if (RUN_INTERPS && interps.length > 0) {
    console.log(`[ral-ingest] embedding ${interps.length} interpretaciones…`);
    const tEmbed = Date.now();
    const embeddings = await inFlight(interps, CONCURRENCY, async (row) =>
      embedOne(buildInterpContent(row)),
    );
    console.log(
      `[ral-ingest]   embedded in ${Math.round((Date.now() - tEmbed) / 1000)}s (avg ${
        Math.round((Date.now() - tEmbed) / interps.length)
      }ms/row)`,
    );

    const rows: ChunkRow[] = interps.map((row, idx) => ({
      session_id: null,
      source_type: 'reglamento',
      source_ref: `ral_interpretacion_${row.articulo_numero ?? 'unk'}_${row.id.slice(0, 8)}`,
      chunk_index: idx,
      content: buildInterpContent(row),
      embedding: JSON.stringify(embeddings[idx]),
      metadata: {
        subtype: 'ral_interpretacion',
        ral_interpretacion_id: row.id,
        articulo_id: row.articulo_id ?? undefined,
        articulo_numero: row.articulo_numero ?? undefined,
        articulo_inciso: row.articulo_inciso ?? undefined,
        fuente_tipo: row.fuente_tipo ?? undefined,
        fuente_cita: row.fuente_cita ?? undefined,
        fuente_fecha: row.fuente_fecha ?? undefined,
        fuente_pdf: row.fuente_pdf ?? undefined,
        edicion: row.edicion ?? undefined,
        vigente: row.vigente ?? undefined,
        embedded_at: new Date().toISOString(),
        embedded_by: 'ingest-ral-chunks',
      },
    }));

    const ir = await insertChunks(rows, 'interpretaciones');
    interpsInserted = ir.inserted;
    interpsIds = ir.ids;
    console.log(`[ral-ingest]   inserted ${interpsInserted} interpretaciones chunks`);
  }

  // ─── Verify ─────────────────────────────────────────────────────────────────
  if (!DRY && (articulosInserted > 0 || interpsInserted > 0)) {
    console.log('[ral-ingest] verifying first inserted chunk has 3072-d embedding…');
    if (articulosIds[0]) {
      const v = await verifyEmbeddingShapeById(articulosIds[0]);
      console.log(`[ral-ingest]   verify articulo id=${articulosIds[0].slice(0, 8)}: ok=${v.ok} dim=${v.dim} ${v.message ?? ''}`);
    }
    if (interpsIds[0]) {
      const v = await verifyEmbeddingShapeById(interpsIds[0]);
      console.log(`[ral-ingest]   verify interp id=${interpsIds[0].slice(0, 8)}: ok=${v.ok} dim=${v.dim} ${v.message ?? ''}`);
    }
  }

  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[ral-ingest] DONE in ${seconds}s. articulosInserted=${articulosInserted} interpsInserted=${interpsInserted}`,
  );
}

main().catch((err) => {
  console.error('[ral-ingest] fatal', err);
  process.exit(1);
});
