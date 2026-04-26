/**
 * shift-cl2 — Seed LightRAG with chunks already in Supabase.
 *
 * LightRAG (graph-augmented RAG) lives inside Cerebro. It needs every chunk
 * fed once via POST /lightrag/insert so it can run entity+relation
 * extraction. That extraction is LLM-heavy (one Haiku call per chunk
 * roughly) so seeding 43k chunks blindly would take days. This script
 * supports filters to seed a curated subset for demo readiness.
 *
 * Filters (env vars):
 *   SOURCE_TYPES   comma list. Default: sil_expediente,sil_dictamen,metadata
 *                  (skip transcripts — too noisy for entity extraction).
 *   EXP_MIN        only chunks whose metadata.expediente_numero >= N (recent).
 *   LIMIT          cap on total chunks. Default: infinity.
 *   BATCH_SIZE     chunks per /insert call. Default: 50.
 *                  Higher means fewer round-trips, but Cerebro processes
 *                  the batch sequentially so latency grows linearly.
 *   PROGRESS_FILE  path to JSON file for resumability. Default:
 *                  .logs/lightrag-seed-progress.json
 *   CEREBRO_BASE   override the Cerebro base URL.
 *   CEREBRO_KEY    bearer token. Default empty (local dev).
 *   DRY_RUN=1      skip the POST, just count what would be sent.
 *
 * Resumable: progress tracked by chunk_id in PROGRESS_FILE. Re-running
 * picks up where it left off. Delete the file to restart from scratch
 * (LightRAG dedupes internally so re-feeding is a no-op cost-wise).
 *
 * Run:    npm run seed:lightrag
 * Time:   ~7s per chunk (Haiku entity extraction). Do the math from
 *         your filters before launching. Designed to run overnight.
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('[seed-lightrag] SUPA env missing'); process.exit(1);
}

const CEREBRO_BASE = process.env.CEREBRO_BASE_URL ?? 'http://localhost:8000';
const CEREBRO_KEY = process.env.CEREBRO_API_KEY ?? '';

const SOURCE_TYPES = (process.env.SOURCE_TYPES ?? 'sil_expediente,sil_dictamen,metadata')
  .split(',').map((s) => s.trim()).filter(Boolean);
const EXP_MIN = process.env.EXP_MIN ? Number(process.env.EXP_MIN) : null;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Number.POSITIVE_INFINITY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);
const PROGRESS_FILE = process.env.PROGRESS_FILE ?? '.logs/lightrag-seed-progress.json';
const DRY_RUN = process.env.DRY_RUN === '1';

const supa = createClient(SUPA_URL, SUPA_KEY);

interface ChunkRow {
  id: string;
  source_type: string;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
}

interface InsertChunk {
  chunk_id: string;
  content: string;
  source_type?: string;
  source_ref?: string;
  expediente_numero?: string;
  comision?: string;
  fecha?: string;
}

interface Progress {
  done: string[];          // chunk_ids already accepted
  failed: Array<{ id: string; reason: string }>;
  inserted: number;
  failures: number;
  startedAt: string;
}

function loadProgress(): Progress {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')) as Progress;
    }
  } catch (err) {
    console.warn('[seed-lightrag] progress file corrupt, starting fresh:', (err as Error).message);
  }
  return { done: [], failed: [], inserted: 0, failures: 0, startedAt: new Date().toISOString() };
}

function saveProgress(p: Progress): void {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function toInsertChunk(row: ChunkRow): InsertChunk {
  const meta = row.metadata ?? {};
  return {
    chunk_id: row.id,
    content: row.content,
    source_type: row.source_type,
    source_ref: row.source_ref ?? undefined,
    expediente_numero: typeof meta.expediente_numero === 'string'
      ? meta.expediente_numero
      : typeof meta.numero === 'string' ? meta.numero : undefined,
    comision: typeof meta.comision === 'string' ? meta.comision : undefined,
    fecha: typeof meta.fecha === 'string' ? meta.fecha : undefined,
  };
}

async function postBatch(chunks: InsertChunk[]): Promise<{ ok: boolean; status: number; detail: string }> {
  if (DRY_RUN) return { ok: true, status: 200, detail: 'dry-run' };
  let res: Response;
  try {
    res = await fetch(`${CEREBRO_BASE}/lightrag/insert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CEREBRO_KEY ? { Authorization: `Bearer ${CEREBRO_KEY}` } : {}),
      },
      body: JSON.stringify({ chunks }),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: (err as Error).message };
  }
  const body = await res.text();
  return { ok: res.ok, status: res.status, detail: body.slice(0, 400) };
}

async function* iterateChunks(): AsyncGenerator<ChunkRow> {
  // Cursor-style page through Supabase using id ASC. UUID strings sort
  // lexicographically; that's deterministic enough for resumability.
  let lastId: string | null = null;
  const pageSize = 500;
  while (true) {
    let q = supa
      .from('legislative_chunks')
      .select('id, source_type, source_ref, content, metadata')
      .in('source_type', SOURCE_TYPES)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (lastId) q = q.gt('id', lastId);
    const { data, error } = await q;
    if (error) throw new Error(`supabase fetch: ${error.message}`);
    if (!data || data.length === 0) return;
    for (const row of data) {
      // EXP_MIN filter (parsed from metadata.expediente_numero — strings
      // like "23.456" with thousands separator).
      if (EXP_MIN !== null) {
        const en = (row.metadata as Record<string, unknown> | null)?.expediente_numero;
        if (typeof en === 'string') {
          const n = Number(en.replace(/\./g, ''));
          if (Number.isFinite(n) && n < EXP_MIN) {
            lastId = row.id;
            continue;
          }
        }
      }
      yield row as ChunkRow;
    }
    lastId = data[data.length - 1].id;
    if (data.length < pageSize) return;
  }
}

async function main(): Promise<void> {
  console.log(
    `[seed-lightrag] start. cerebro=${CEREBRO_BASE} types=[${SOURCE_TYPES.join(',')}] ` +
    `exp_min=${EXP_MIN ?? '∞'} limit=${LIMIT} batch=${BATCH_SIZE} dry=${DRY_RUN}`,
  );

  const progress = loadProgress();
  const seen = new Set(progress.done);
  console.log(`[seed-lightrag] resumed from progress: ${progress.inserted} done, ${progress.failures} failed`);

  let buffer: InsertChunk[] = [];
  let scanned = 0;
  let queued = 0;
  const t0 = Date.now();

  const flush = async () => {
    if (buffer.length === 0) return;
    const t = Date.now();
    const r = await postBatch(buffer);
    const dt = Date.now() - t;
    if (r.ok) {
      progress.inserted += buffer.length;
      for (const c of buffer) progress.done.push(c.chunk_id);
      console.log(`[seed-lightrag] +${buffer.length} (total ${progress.inserted}) in ${dt}ms`);
    } else {
      progress.failures += buffer.length;
      for (const c of buffer) progress.failed.push({ id: c.chunk_id, reason: `${r.status}: ${r.detail.slice(0, 120)}` });
      console.warn(`[seed-lightrag] BATCH FAILED status=${r.status}: ${r.detail.slice(0, 200)}`);
    }
    saveProgress(progress);
    buffer = [];
  };

  for await (const row of iterateChunks()) {
    scanned += 1;
    if (seen.has(row.id)) continue;
    buffer.push(toInsertChunk(row));
    queued += 1;
    if (buffer.length >= BATCH_SIZE) await flush();
    if (progress.inserted + buffer.length >= LIMIT) break;
  }
  await flush();

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[seed-lightrag] DONE in ${dt}s — scanned=${scanned} queued=${queued} inserted=${progress.inserted} failures=${progress.failures}`,
  );
  if (progress.failures > 0) {
    console.log(`[seed-lightrag] inspect failed in ${PROGRESS_FILE} (.failed[])`);
  }
}

main().catch((err) => {
  console.error('[seed-lightrag] fatal:', err);
  process.exit(1);
});
