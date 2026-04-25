-- shift-cl2 — RAG search RPC + HNSW index
-- Apply AFTER 0001_init.sql AND after seed-demo.ts populates real embeddings.
-- Index needs ≥10 rows to be useful; safe to run on demo seed (15 chunks).

-- =====================================================
-- match_chunks(query_embedding, match_count, filter)
-- =====================================================
-- Returns top-K chunks ranked by cosine similarity.
-- Filter args optional: limit by session_id, comision, fecha range.

create or replace function match_chunks(
  query_embedding vector(3072),
  match_count int default 5,
  filter_session_id uuid default null,
  filter_comision text default null,
  filter_fecha_from date default null,
  filter_fecha_to date default null
)
returns table (
  chunk_id uuid,
  session_id uuid,
  source_ref text,
  chunk_index int,
  content text,
  similarity float,
  fecha date,
  comision text,
  tipo text,
  video_url text,
  transcript_url text
)
language sql stable
security invoker
set search_path = public
as $$
  select
    c.id as chunk_id,
    c.session_id,
    c.source_ref,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    s.fecha,
    s.comision,
    s.tipo,
    s.video_url,
    s.transcript_url
  from legislative_chunks c
  join sessions s on s.id = c.session_id
  where
    (filter_session_id is null or c.session_id = filter_session_id)
    and (filter_comision is null or s.comision = filter_comision)
    and (filter_fecha_from is null or s.fecha >= filter_fecha_from)
    and (filter_fecha_to is null or s.fecha <= filter_fecha_to)
  order by c.embedding <=> query_embedding asc
  limit match_count;
$$;

-- Allow authed users to call the RPC
grant execute on function match_chunks to authenticated, service_role;

-- =====================================================
-- Vector index — DEFERRED to Sprint 3
-- =====================================================
-- pgvector HNSW caps at 2000 dim; gemini-embedding-001 is 3072d.
-- For MVP demo (15 chunks) sequential scan is microseconds, no index needed.
--
-- Sprint 3 options when corpus grows (>10K chunks):
--   1. halfvec(3072) — pgvector 0.7+, 16-bit floats, HNSW supports up to 4000d
--   2. IVFFlat — slower than HNSW but supports full 3072 dim
--   3. Truncate via Matryoshka — set VERTEX_EMBEDDING_DIM=1536 (gemini-embedding-001
--      preserves quality at lower dims via MRL training)
--
-- Pick when we know corpus size + query QPS.
