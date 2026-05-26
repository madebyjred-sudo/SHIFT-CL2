import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embeddings.js';
import { withRetry, withTimeout } from './resilience.js';

/**
 * Per-chunk metadata jsonb. Shape varies by source_type:
 *   - transcript chunks → { start, end, word_count, title }
 *     `start` and `end` are seconds (numeric) into the plenary video,
 *     allowing the LLM to cite an exact HH:MM:SS timecode rather than
 *     just "según la sesión #84".
 *   - sil_* chunks → { sil_doc_id, sil_doc_tipo, sil_doc_titulo,
 *     sil_doc_fecha, expediente_numero, ... } — see process-sil-docs.ts.
 *   - reglamento chunks → { articulo_numero, articulo_titulo,
 *     articulo_full_title, ... } — see index-reglamento.ts.
 *
 * Kept loose on purpose: callers cherry-pick the fields they need and
 * absent ones are tolerated. The tool dispatcher in openRouterClient.ts
 * is the single place that turns this into citation strings.
 */
export interface ChunkMetadata {
  // transcript
  start?: number;
  end?: number;
  word_count?: number;
  title?: string;
  // transcript — Wave 4 #4 (2026-05-26): expediente que se estaba debatiendo
  // en el momento de la votación, asignado heurísticamente vía voteExtractor.
  // null/undefined si el chunk no es de votación o no había expediente
  // mencionado en chunks previos. Permite que Lexa cite "votación del expediente
  // X (sesión Y · HH:MM)" aún cuando el N° no aparezca literal en el chunk.
  votando_expediente?: string;
  // sil_*
  sil_doc_id?: string;
  sil_doc_tipo?: string;
  sil_doc_titulo?: string;
  sil_doc_fecha?: string;
  sil_doc_url?: string;
  expediente_numero?: string;
  expediente_titulo?: string;
  expediente_url?: string;
  comision?: string;
  estado?: string;
  fecha_presentacion?: string;
  // reglamento
  reglamento?: boolean;
  articulo_numero?: number | string;
  articulo_titulo?: string;
  articulo_full_title?: string;
  url?: string;
  // catch-all for forward compatibility
  [key: string]: unknown;
}

export interface ChunkHit {
  chunk_id: string;
  session_id: string;
  source_ref: string;
  chunk_index: number;
  content: string;
  similarity: number;
  fecha: string;
  comision: string;
  tipo: string;
  video_url: string | null;
  transcript_url: string | null;
  // Exposed by match_chunks_v3. Carries per-chunk timecodes for transcripts
  // (start/end in seconds) so the LLM can cite a precise HH:MM:SS pointer
  // into the plenary video — not "según la sesión #84" pero "según la
  // sesión #84 · 01:23:45".
  metadata?: ChunkMetadata | null;
  // Surfaced by match_chunks_v3 for transcript chunks; null for SIL/Reglamento.
  // null-safe access at the dispatcher; helps the renderer decide which
  // citation flavor to emit (timecode vs article-number vs doc-type).
  source_type?: string | null;
}

export interface SearchArgs {
  query: string;
  top_k?: number;
  comision?: string;
  fecha_from?: string;
  fecha_to?: string;
}

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

/**
 * Embed query via Vertex AI then call match_chunks_v3 RPC. Returns top-K
 * chunks WITH per-chunk metadata (jsonb) so the dispatcher can emit precise
 * citations:
 *   - transcript → [Sesión #N · HH:MM:SS] from metadata.start
 *   - sil_*      → [Exp. N · tipo_doc · fecha] from metadata.expediente_numero etc.
 *   - reglamento → [Art. N] from metadata.articulo_numero
 *
 * Failure mode: if match_chunks_v3 isn't yet applied to the target DB
 * (migration 0026), we fall back to match_chunks (no metadata) so the
 * tool keeps working with degraded citations. This preserves staging vs
 * prod migration drift without breaking the demo flow.
 */
export async function searchTranscripts(args: SearchArgs): Promise<ChunkHit[]> {
  // 2026-05-26: subido de 5→12. Lawyer test L9 ("qué votación en plenaria
  // 21 may") demostró que con k=5 los chunks con "56 votos a favor" se
  // pierden en queries genéricas. Plenarias tienen ~1000 chunks; k=12
  // da mejor cobertura sin saturar el context.
  const topK = args.top_k ?? 12;

  const queryEmbedding = await embedQuery(args.query);

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // Try v3 first (returns metadata). If the RPC doesn't exist yet
          // (migration not applied), fall back to v1 so we keep working.
          const v3 = await supa()
            .rpc('match_chunks_v3', {
              query_embedding: queryEmbedding,
              match_count: topK,
              filter_session_id: null,
              filter_comision: args.comision ?? null,
              filter_fecha_from: args.fecha_from ?? null,
              filter_fecha_to: args.fecha_to ?? null,
              filter_source_type: null,
              filter_source_ref_prefix: null,
            })
            .abortSignal(signal);
          if (!v3.error) {
            return (v3.data ?? []) as ChunkHit[];
          }
          // PostgREST emits 42883 (function does not exist) before 0026 is
          // applied. Anything else is a real failure; rethrow.
          const msg = v3.error.message ?? '';
          const code = (v3.error as { code?: string }).code ?? '';
          if (!(code === '42883' || /does not exist/i.test(msg))) {
            throw new Error(`match_chunks_v3 rpc: ${msg}`);
          }

          // Fallback path — no metadata, but search still works.
          const v1 = await supa()
            .rpc('match_chunks', {
              query_embedding: queryEmbedding,
              match_count: topK,
              filter_session_id: null,
              filter_comision: args.comision ?? null,
              filter_fecha_from: args.fecha_from ?? null,
              filter_fecha_to: args.fecha_to ?? null,
            })
            .abortSignal(signal);
          if (v1.error) throw new Error(`match_chunks fallback: ${v1.error.message}`);
          return (v1.data ?? []) as ChunkHit[];
        },
        { ms: 8_000, label: 'supabase:match_chunks_v3' },
      ),
    { attempts: 2, baseDelayMs: 300, label: 'supabase:match_chunks_v3' },
  );
}
