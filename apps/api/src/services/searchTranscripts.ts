import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embeddings.js';
import { withRetry, withTimeout } from './resilience.js';

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
 * Embed query via Vertex AI then call match_chunks RPC. Returns top-K chunks
 * with metadata for citation rendering. Stable across Sprint 2 demo + Sprint 3
 * real corpus.
 */
export async function searchTranscripts(args: SearchArgs): Promise<ChunkHit[]> {
  const topK = args.top_k ?? 5;

  const queryEmbedding = await embedQuery(args.query);

  // pgvector match is read-only and idempotent; safe to retry on transient
  // network blips. Timeout sized for a corpus that fits comfortably in
  // memory — anything past 8s means the index is degraded.
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const { data, error } = await supa()
            .rpc('match_chunks', {
              query_embedding: queryEmbedding,
              match_count: topK,
              filter_session_id: null,
              filter_comision: args.comision ?? null,
              filter_fecha_from: args.fecha_from ?? null,
              filter_fecha_to: args.fecha_to ?? null,
            })
            .abortSignal(signal);
          if (error) throw new Error(`match_chunks rpc: ${error.message}`);
          return (data ?? []) as ChunkHit[];
        },
        { ms: 8_000, label: 'supabase:match_chunks' },
      ),
    { attempts: 2, baseDelayMs: 300, label: 'supabase:match_chunks' },
  );
}
