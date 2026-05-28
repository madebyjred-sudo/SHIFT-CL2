/**
 * shift-cl2 — Job B: Ingest transcript_segments → legislative_chunks.
 *
 * Source: transcript_segments (73k+ rows) grouped per session_id, ordered by
 * segment_idx. We group consecutive segments into blocks of approximately
 * TARGET_CHARS (~3000 chars ≈ 600-800 tokens) preserving:
 *   - start_seconds (block start = first segment start)
 *   - end_seconds   (block end   = last segment end)
 *   - segment_ids[] array of source UUIDs (for forward-traceability)
 *
 * Output: legislative_chunks rows with source_type='transcript'.
 *   - session_id = the source session
 *   - source_ref = '<youtube_video_id>' if available, else session.id
 *   - chunk_index = sequential within session, starting at 0
 *   - metadata = { subtype: 'transcript_segment_block', session_id, comision,
 *                  fecha, tipo, start, end, word_count, segment_ids[],
 *                  segment_idx_start, segment_idx_end }
 *
 * Idempotency strategy:
 *   For each session we process, we delete all existing legislative_chunks
 *   rows with (session_id=<id>, source_type='transcript', metadata.subtype=
 *   'transcript_segment_block') before inserting fresh ones. This preserves
 *   any other transcript chunks (legacy GCS-elevenlabs) so we don't nuke them.
 *
 * Modes:
 *   --dry         No DB writes, no Vertex calls.
 *   --probe       Process only --probe-sessions=N sessions (default 1) for sanity.
 *   --sessions=A,B,C   Process only listed session_ids (CSV).
 *   --limit-sessions=N Cap how many sessions get processed in one run.
 *   --skip-existing    Skip sessions that already have transcript_segment_block chunks.
 *   --target-chars=N   Override the target block size (default 3000).
 *   (default)    Process all sessions that have transcript_segments.
 *
 * Run (probe — 1 session):
 *   cd /Users/juan/Downloads/shift-cl2
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx -r dotenv/config \
 *     apps/api/scripts/ingest-transcript-chunks.ts dotenv_config_path=.env.local --probe
 *
 * Run (full):
 *   cd /Users/juan/Downloads/shift-cl2
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx -r dotenv/config \
 *     apps/api/scripts/ingest-transcript-chunks.ts dotenv_config_path=.env.local
 *
 * Notes on source_type:
 *   The legislative_chunks_source_type_check constraint allows 'transcript' but
 *   NOT 'transcript_segment'. We reuse 'transcript' and disambiguate via
 *   metadata.subtype = 'transcript_segment_block'. The existing
 *   index-gcs-transcripts.ts already uses source_type='transcript' for
 *   ElevenLabs-derived chunks, so search tooling on the read side is
 *   already wired up to filter on it.
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const PROBE = args.includes('--probe');
const SKIP_EXISTING = args.includes('--skip-existing');

function argValue(name: string): string | undefined {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a?.split('=', 2)[1];
}

const TARGET_CHARS = Number(argValue('target-chars') ?? 3000);
const PROBE_SESSIONS = Number(argValue('probe-sessions') ?? 1);
const LIMIT_SESSIONS = argValue('limit-sessions')
  ? Number(argValue('limit-sessions'))
  : PROBE
  ? PROBE_SESSIONS
  : undefined;
const EXPLICIT_SESSIONS = argValue('sessions')?.split(',').map((s) => s.trim()).filter(Boolean);

// ─── Env ──────────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);

if (!SUPA_URL || !SUPA_KEY) {
  console.error('[transcript-ingest] Supabase env missing');
  process.exit(1);
}
if (!GCP_PROJECT && !DRY) {
  console.error('[transcript-ingest] GCP_PROJECT_ID missing');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !DRY) {
  console.error('[transcript-ingest] GOOGLE_APPLICATION_CREDENTIALS missing');
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
  if (DRY || !vertex) return new Array(EMBED_DIM).fill(0);
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface SegmentRow {
  id: string;
  session_id: string;
  segment_idx: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

interface SessionMeta {
  id: string;
  youtube_video_id: string | null;
  legacy_video_id: string | null;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  status: string | null;
}

interface Block {
  segment_idx_start: number;
  segment_idx_end: number;
  segment_ids: string[];
  start_seconds: number;
  end_seconds: number;
  text: string;
  word_count: number;
}

interface ChunkRow {
  session_id: string;
  source_type: 'transcript';
  source_ref: string;
  chunk_index: number;
  content: string;
  embedding: string;
  metadata: Record<string, unknown>;
}

// ─── Discover sessions with segments ──────────────────────────────────────────
async function fetchSessionsWithSegments(): Promise<string[]> {
  if (EXPLICIT_SESSIONS && EXPLICIT_SESSIONS.length > 0) {
    return EXPLICIT_SESSIONS;
  }

  // We need distinct session_ids that have at least one transcript_segments row.
  // Supabase JS doesn't support GROUP BY directly without an RPC, so we
  // page through transcript_segments and collect distinct session_ids.
  // For 73k rows this is fine (~73 pages of 1000).
  const distinct = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supa
      .from('transcript_segments')
      .select('session_id')
      .order('session_id', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`scan transcript_segments: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) distinct.add((r as { session_id: string }).session_id);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return [...distinct];
}

async function fetchSessionMeta(ids: string[]): Promise<Map<string, SessionMeta>> {
  const out = new Map<string, SessionMeta>();
  const pageSize = 500;
  for (let i = 0; i < ids.length; i += pageSize) {
    const slice = ids.slice(i, i + pageSize);
    const { data, error } = await supa
      .from('sessions')
      .select('id, youtube_video_id, legacy_video_id, fecha, comision, tipo, status')
      .in('id', slice);
    if (error) throw new Error(`fetch sessions: ${error.message}`);
    for (const row of data ?? []) {
      const r = row as SessionMeta;
      out.set(r.id, r);
    }
  }
  return out;
}

async function fetchSegmentsForSession(sessionId: string): Promise<SegmentRow[]> {
  const out: SegmentRow[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supa
      .from('transcript_segments')
      .select('id, session_id, segment_idx, start_seconds, end_seconds, text')
      .eq('session_id', sessionId)
      .order('segment_idx', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`fetch segments(${sessionId}): ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as SegmentRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

// ─── Grouping logic ───────────────────────────────────────────────────────────
function groupSegments(segs: SegmentRow[], targetChars: number): Block[] {
  const blocks: Block[] = [];
  if (segs.length === 0) return blocks;

  let buf: SegmentRow[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((s) => s.text.trim()).filter(Boolean).join(' ').trim();
    if (!text) {
      buf = [];
      bufChars = 0;
      return;
    }
    blocks.push({
      segment_idx_start: buf[0].segment_idx,
      segment_idx_end: buf[buf.length - 1].segment_idx,
      segment_ids: buf.map((s) => s.id),
      start_seconds: buf[0].start_seconds,
      end_seconds: buf[buf.length - 1].end_seconds,
      text,
      word_count: text.split(/\s+/).filter(Boolean).length,
    });
    buf = [];
    bufChars = 0;
  };

  for (const seg of segs) {
    buf.push(seg);
    bufChars += seg.text.length + 1;
    if (bufChars >= targetChars) {
      // Try to break at a sentence terminator within the last 200 chars.
      let lastDot = -1;
      for (let i = buf.length - 1; i >= Math.max(0, buf.length - 12); i--) {
        const t = buf[i].text.trim();
        if (/[.!?]$/.test(t)) {
          lastDot = i;
          break;
        }
      }
      if (lastDot > 0 && lastDot < buf.length - 1) {
        // Cut at lastDot inclusive, push the tail back into a new buffer.
        const head = buf.slice(0, lastDot + 1);
        const tail = buf.slice(lastDot + 1);
        const text = head.map((s) => s.text.trim()).filter(Boolean).join(' ').trim();
        if (text) {
          blocks.push({
            segment_idx_start: head[0].segment_idx,
            segment_idx_end: head[head.length - 1].segment_idx,
            segment_ids: head.map((s) => s.id),
            start_seconds: head[0].start_seconds,
            end_seconds: head[head.length - 1].end_seconds,
            text,
            word_count: text.split(/\s+/).filter(Boolean).length,
          });
        }
        buf = tail;
        bufChars = tail.reduce((n, s) => n + s.text.length + 1, 0);
      } else {
        flush();
      }
    }
  }
  flush();
  return blocks;
}

// ─── Idempotency: clear previous transcript blocks for a session ──────────────
async function clearPreviousBlocks(sessionId: string): Promise<number> {
  if (DRY) return 0;
  const { data, error } = await supa
    .from('legislative_chunks')
    .delete()
    .eq('session_id', sessionId)
    .eq('source_type', 'transcript')
    .filter('metadata->>subtype', 'eq', 'transcript_segment_block')
    .select('id');
  if (error) throw new Error(`clear blocks(${sessionId}): ${error.message}`);
  return data?.length ?? 0;
}

async function countExistingBlocks(sessionId: string): Promise<number> {
  // chunks_session_idx makes session_id queries fast. Combined with source_type
  // and metadata->>subtype filters this is selective enough.
  const { data, error } = await supa
    .from('legislative_chunks')
    .select('id', { count: 'exact' })
    .eq('session_id', sessionId)
    .eq('source_type', 'transcript')
    .filter('metadata->>subtype', 'eq', 'transcript_segment_block');
  if (error) {
    console.warn(`[transcript-ingest] count blocks(${sessionId}) warn: ${error.message}`);
    return 0;
  }
  return data?.length ?? 0;
}

// ─── Insert helper ────────────────────────────────────────────────────────────
const INSERT_BATCH = 25; // 25 * 3072d = small enough to keep payloads under 1MB

async function insertChunks(rows: ChunkRow[]): Promise<{ inserted: number; ids: string[] }> {
  if (DRY) {
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
      console.error(`[transcript-ingest] insert batch ${i} failed: ${error.message}`);
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
  if (!data) return { ok: false, dim: 0, message: 'no inserted row found' };
  const emb = (data as { embedding: unknown }).embedding;
  if (typeof emb === 'string') {
    const dim = emb.split(',').length;
    return { ok: dim === EMBED_DIM, dim };
  }
  if (Array.isArray(emb)) return { ok: emb.length === EMBED_DIM, dim: emb.length };
  return { ok: false, dim: 0, message: `unexpected embedding type ${typeof emb}` };
}

// ─── Per-session processing ───────────────────────────────────────────────────
interface SessionStats {
  session_id: string;
  segments: number;
  blocks_built: number;
  blocks_inserted: number;
  cleared: number;
  skipped: boolean;
  error?: string;
  duration_ms: number;
  first_inserted_id?: string;
}

async function processSession(sessionId: string, meta: SessionMeta | undefined): Promise<SessionStats> {
  const t0 = Date.now();
  const stats: SessionStats = {
    session_id: sessionId,
    segments: 0,
    blocks_built: 0,
    blocks_inserted: 0,
    cleared: 0,
    skipped: false,
    duration_ms: 0,
  };

  try {
    if (SKIP_EXISTING) {
      const existing = await countExistingBlocks(sessionId);
      if (existing > 0) {
        console.log(`[transcript-ingest] skip ${sessionId.slice(0, 8)} — ${existing} blocks exist`);
        stats.skipped = true;
        stats.duration_ms = Date.now() - t0;
        return stats;
      }
    }

    const segments = await fetchSegmentsForSession(sessionId);
    stats.segments = segments.length;
    if (segments.length === 0) {
      console.log(`[transcript-ingest] ${sessionId.slice(0, 8)} has 0 segments — skip`);
      stats.skipped = true;
      stats.duration_ms = Date.now() - t0;
      return stats;
    }

    const blocks = groupSegments(segments, TARGET_CHARS);
    stats.blocks_built = blocks.length;

    if (blocks.length === 0) {
      console.log(`[transcript-ingest] ${sessionId.slice(0, 8)} produced 0 blocks — skip`);
      stats.skipped = true;
      stats.duration_ms = Date.now() - t0;
      return stats;
    }

    // Clear previous blocks for this session (idempotency).
    stats.cleared = await clearPreviousBlocks(sessionId);

    // Embed.
    const embeddings = await inFlight(blocks, CONCURRENCY, async (b) => embedOne(b.text));

    // Determine source_ref preference: youtube_video_id > legacy_video_id > sessionId.
    const sref =
      meta?.youtube_video_id ?? meta?.legacy_video_id ?? sessionId;

    const rows: ChunkRow[] = blocks.map((b, idx) => ({
      session_id: sessionId,
      source_type: 'transcript',
      source_ref: sref,
      chunk_index: idx,
      content: b.text,
      embedding: JSON.stringify(embeddings[idx]),
      metadata: {
        subtype: 'transcript_segment_block',
        session_id: sessionId,
        comision: meta?.comision ?? undefined,
        fecha: meta?.fecha ?? undefined,
        tipo: meta?.tipo ?? undefined,
        youtube_video_id: meta?.youtube_video_id ?? undefined,
        legacy_video_id: meta?.legacy_video_id ?? undefined,
        start: b.start_seconds,
        end: b.end_seconds,
        word_count: b.word_count,
        segment_idx_start: b.segment_idx_start,
        segment_idx_end: b.segment_idx_end,
        segment_ids: b.segment_ids,
        embedded_at: new Date().toISOString(),
        embedded_by: 'ingest-transcript-chunks',
      },
    }));

    const ins = await insertChunks(rows);
    stats.blocks_inserted = ins.inserted;
    stats.first_inserted_id = ins.ids[0];
    stats.duration_ms = Date.now() - t0;
    console.log(
      `[transcript-ingest] ${sessionId.slice(0, 8)}: segs=${stats.segments} blocks=${stats.blocks_built} inserted=${stats.blocks_inserted} cleared=${stats.cleared} ${stats.duration_ms}ms`,
    );
    return stats;
  } catch (err) {
    stats.error = (err as Error)?.message ?? String(err);
    stats.duration_ms = Date.now() - t0;
    console.error(`[transcript-ingest] ${sessionId.slice(0, 8)} FAILED: ${stats.error}`);
    return stats;
  }
}

// ─── Driver ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[transcript-ingest] start. dry=${DRY} probe=${PROBE} target_chars=${TARGET_CHARS} limit_sessions=${LIMIT_SESSIONS ?? 'none'} skip_existing=${SKIP_EXISTING} embed=${EMBED_MODEL}/${EMBED_DIM}d`,
  );
  const t0 = Date.now();

  const sessionIds = await fetchSessionsWithSegments();
  console.log(`[transcript-ingest] sessions with segments: ${sessionIds.length}`);

  const selected = LIMIT_SESSIONS ? sessionIds.slice(0, LIMIT_SESSIONS) : sessionIds;
  console.log(`[transcript-ingest] processing ${selected.length} sessions`);

  const metaMap = await fetchSessionMeta(selected);

  const allStats: SessionStats[] = [];
  for (const sid of selected) {
    const meta = metaMap.get(sid);
    const stats = await processSession(sid, meta);
    allStats.push(stats);
  }

  // ─── Verify a sample ────────────────────────────────────────────────────────
  if (!DRY) {
    const firstOk = allStats.find((s) => s.blocks_inserted > 0 && s.first_inserted_id);
    if (firstOk && firstOk.first_inserted_id) {
      const v = await verifyEmbeddingShapeById(firstOk.first_inserted_id);
      console.log(
        `[transcript-ingest] verify embedding shape session=${firstOk.session_id.slice(0, 8)} id=${firstOk.first_inserted_id.slice(0, 8)}: ok=${v.ok} dim=${v.dim} ${v.message ?? ''}`,
      );
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  const totalSegs = allStats.reduce((n, s) => n + s.segments, 0);
  const totalBlocks = allStats.reduce((n, s) => n + s.blocks_inserted, 0);
  const totalCleared = allStats.reduce((n, s) => n + s.cleared, 0);
  const failures = allStats.filter((s) => s.error).length;
  const skipped = allStats.filter((s) => s.skipped).length;
  const seconds = Math.round((Date.now() - t0) / 1000);

  console.log(
    `[transcript-ingest] DONE in ${seconds}s. sessionsProcessed=${selected.length} segments=${totalSegs} blocksInserted=${totalBlocks} cleared=${totalCleared} skipped=${skipped} failures=${failures}`,
  );
  if (failures > 0) {
    console.log('[transcript-ingest] failures:');
    for (const s of allStats.filter((x) => x.error)) {
      console.log(`  - ${s.session_id}: ${s.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[transcript-ingest] fatal', err);
  process.exit(1);
});
