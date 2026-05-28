/**
 * ingestTranscriptChunks — chunkea segments de sesiones recién indexadas
 *   a `legislative_chunks` para que Lexa los pueda citar.
 *
 * Por qué este job existe:
 *   `transcriptProcess.ts` deja los segments en `transcript_segments` y
 *   marca la sesión como `status='indexed'`. PERO no los ingesta a
 *   `legislative_chunks`, que es la tabla de la que Lexa hace recall.
 *   Sin este job, las sesiones nuevas son invisibles para Lexa.
 *
 *   El backfill manual del 2026-05-17 cubrió las 136 sesiones existentes
 *   (1.414 bloques). Este job mantiene el corpus actualizado para sesiones
 *   que entren después.
 *
 * Estrategia (delta):
 *   1. Listar `session_id` distintos de `transcript_segments`.
 *   2. Listar `session_id` distintos de `legislative_chunks WHERE
 *      source_type='transcript'`.
 *   3. Diff: sesiones con segments PERO sin chunks.
 *   4. Para cada sesión: agrupar segments por bloques de ~3000 chars,
 *      generar embeddings vía Vertex, insertar a `legislative_chunks`.
 *
 * Idempotencia:
 *   Antes de insertar para una sesión, DELETE existentes con
 *   (session_id, source_type='transcript', metadata->>'subtype'=
 *   'transcript_segment_block'). Re-run seguro.
 *
 * Cuándo correr:
 *   Cron cada 30 min. Procesa hasta N sesiones por run para respetar
 *   timeout del scheduler.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedDocuments } from '../services/embeddings.js';
import { logger } from '../services/logger.js';
import { linkVotesToExpedientes } from '../services/voteExtractor.js';

const TARGET_CHARS = 3000;
const MAX_SESSIONS_PER_RUN = 8;

interface Segment {
  id: string;
  segment_idx: number;
  start_seconds: number | null;
  end_seconds: number | null;
  text: string;
}

interface SessionMeta {
  id: string;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  youtube_video_id: string | null;
}

export interface IngestTranscriptResult {
  sessions_processed: number;
  blocks_inserted: number;
  blocks_replaced: number;
  failures: number;
  sessions_remaining: number;
}

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('ingestTranscriptChunks: supabase env missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function paginatedDistinct(s: SupabaseClient, table: string, col: string, eq?: { col: string; val: string }): Promise<Set<string>> {
  const out = new Set<string>();
  for (let off = 0; off < 200_000; off += 1000) {
    let q = s.from(table).select(col).order('id', { ascending: true }).range(off, off + 999);
    if (eq) q = q.eq(eq.col, eq.val);
    const { data, error } = await q;
    if (error) throw new Error(`paginate ${table}.${col}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) out.add((r as unknown as Record<string, string>)[col]);
    if (data.length < 1000) break;
  }
  return out;
}

async function fetchSegments(s: SupabaseClient, sessionId: string): Promise<Segment[]> {
  const out: Segment[] = [];
  for (let off = 0; off < 100_000; off += 1000) {
    const { data, error } = await s
      .from('transcript_segments')
      .select('id, segment_idx, start_seconds, end_seconds, text')
      .eq('session_id', sessionId)
      .order('segment_idx', { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`fetchSegments ${sessionId}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as Segment[]));
    if (data.length < 1000) break;
  }
  return out;
}

function groupSegmentsIntoBlocks(segs: Segment[]): Array<{
  text: string;
  start: number | null;
  end: number | null;
  segment_ids: string[];
  segment_idx_start: number;
  segment_idx_end: number;
}> {
  const blocks: Array<{ text: string; start: number | null; end: number | null; segment_ids: string[]; segment_idx_start: number; segment_idx_end: number }> = [];
  let cur = { text: '', start: null as number | null, end: null as number | null, segment_ids: [] as string[], segment_idx_start: 0, segment_idx_end: 0 };
  for (const seg of segs) {
    if (cur.text.length === 0) {
      cur.start = seg.start_seconds;
      cur.segment_idx_start = seg.segment_idx;
    }
    cur.text += (cur.text.length > 0 ? ' ' : '') + (seg.text ?? '');
    cur.end = seg.end_seconds;
    cur.segment_idx_end = seg.segment_idx;
    cur.segment_ids.push(seg.id);
    if (cur.text.length >= TARGET_CHARS) {
      blocks.push(cur);
      cur = { text: '', start: null, end: null, segment_ids: [], segment_idx_start: 0, segment_idx_end: 0 };
    }
  }
  if (cur.text.length > 0) blocks.push(cur);
  return blocks;
}

export async function runIngestTranscriptChunks(opts: { limit_sessions?: number } = {}): Promise<IngestTranscriptResult> {
  const limit = Math.min(Math.max(opts.limit_sessions ?? MAX_SESSIONS_PER_RUN, 1), 50);
  const s = supa();

  logger.info('ingest_transcript_chunks_start', { limit });

  // 1. Sesiones con segments
  const withSegs = await paginatedDistinct(s, 'transcript_segments', 'session_id');

  // 2. Delta: para cada session candidata, EXISTS check rápido en
  //    legislative_chunks (usa el index session_id). NO podemos hacer
  //    paginated scan de legislative_chunks filtered por source_type porque
  //    no hay index en esa columna (>31k filas → statement timeout).
  const pending: string[] = [];
  for (const sid of withSegs) {
    const { data: hit, error } = await s
      .from('legislative_chunks')
      .select('id', { head: false })
      .eq('session_id', sid)
      .eq('source_type', 'transcript')
      .limit(1);
    if (error) {
      logger.warn('ingest_transcript_chunks_delta_check_failed', { sessionId: sid, error: error.message });
      continue;
    }
    if (!hit || hit.length === 0) pending.push(sid);
  }
  logger.info('ingest_transcript_chunks_delta', {
    sessions_with_segments: withSegs.size,
    pending: pending.length,
  });

  const targets = pending.slice(0, limit);
  let blocksInserted = 0;
  let blocksReplaced = 0;
  let failures = 0;
  let processed = 0;

  for (const sessionId of targets) {
    try {
      // Sesión meta
      const { data: meta } = await s
        .from('sessions')
        .select('id, fecha, comision, tipo, youtube_video_id')
        .eq('id', sessionId)
        .maybeSingle();
      const m = (meta ?? null) as SessionMeta | null;

      const segs = await fetchSegments(s, sessionId);
      if (segs.length === 0) {
        processed++;
        continue;
      }
      const blocks = groupSegmentsIntoBlocks(segs);
      if (blocks.length === 0) {
        processed++;
        continue;
      }

      // Idempotencia: DELETE bloques transcript previos para esta sesión
      const { count: delCount } = await s
        .from('legislative_chunks')
        .delete({ count: 'exact' })
        .eq('session_id', sessionId)
        .eq('source_type', 'transcript');
      blocksReplaced += delCount ?? 0;

      // Embed bloques (batch via embedDocuments)
      const embeddings = await embedDocuments(blocks.map((b) => b.text));

      // Wave 4 #4: pre-compute linkages vote-chunk → expediente para esta
      // sesión. Usamos los block-indices como ids temporales — los aplicamos
      // al rows.map de abajo via lookup map.
      const tempLinkages = linkVotesToExpedientes(
        blocks.map((b, idx) => ({
          id: String(idx),
          chunk_index: idx,
          content: b.text,
        })),
      );
      const voteExpByIdx = new Map<number, string>();
      for (const lk of tempLinkages) {
        voteExpByIdx.set(parseInt(lk.chunk_id, 10), lk.votando_expediente);
      }

      const rows = blocks.map((b, idx) => ({
        session_id: sessionId,
        source_type: 'transcript' as const,
        source_ref: m?.youtube_video_id ?? sessionId,
        chunk_index: idx,
        content: b.text,
        embedding: embeddings[idx],
        metadata: {
          subtype: 'transcript_segment_block',
          session_id: sessionId,
          fecha: m?.fecha ?? null,
          comision: m?.comision ?? null,
          tipo: m?.tipo ?? null,
          start_seconds: b.start,
          end_seconds: b.end,
          word_count: b.text.split(/\s+/).length,
          segment_ids: b.segment_ids,
          segment_idx_start: b.segment_idx_start,
          segment_idx_end: b.segment_idx_end,
          // Wave 4 #4: linkage opcional para que search_transcripts cite
          // "votación del expediente X" aún cuando el N° no esté en el chunk.
          ...(voteExpByIdx.has(idx) ? { votando_expediente: voteExpByIdx.get(idx) } : {}),
        },
      }));

      const { error: insErr } = await s.from('legislative_chunks').insert(rows);
      if (insErr) {
        logger.warn('ingest_transcript_chunks_session_failed', { sessionId, error: insErr.message });
        failures++;
      } else {
        blocksInserted += rows.length;
      }
      processed++;
    } catch (e) {
      logger.warn('ingest_transcript_chunks_session_exception', { sessionId, error: (e as Error).message });
      failures++;
      processed++;
    }
  }

  const result: IngestTranscriptResult = {
    sessions_processed: processed,
    blocks_inserted: blocksInserted,
    blocks_replaced: blocksReplaced,
    failures,
    sessions_remaining: Math.max(0, pending.length - processed),
  };
  logger.info('ingest_transcript_chunks_complete', { ...result });
  return result;
}
