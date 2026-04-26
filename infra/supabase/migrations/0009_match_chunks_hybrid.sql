-- shift-cl2 — Hybrid retrieval (BM25 + dense) over legislative_chunks.
--
-- Why: pgvector cosine similarity (match_chunks_v2) is excellent at
-- semantic queries but brittle for tokens that don't survive embedding —
-- expediente numbers like "22.293", law refs like "Ley 6727", acronyms
-- like "CCSS", "INS", "ÁREA VIII", names of diputados that the embedder
-- has never seen. BM25 (Postgres ts_rank_cd over a tsvector) shines
-- there. Combining both via Reciprocal Rank Fusion captures the union of
-- their strengths.
--
-- Apply this migration AFTER the SIL DOCX bulk has finished embedding —
-- the GIN index over content_tsv is cheap to build for the existing
-- transcripts (~5k chunks) but for the post-bulk corpus (~1-2M chunks)
-- it takes ~30-90s. CONCURRENTLY would help in production; on a fresh
-- demo DB the locked rebuild is fine.
--
-- Idempotent. Apply via Supabase Studio.

-- 1. Generated tsvector column (Spanish dictionary).
-- We use STORED so the index can be GIN — Postgres requires this.
alter table legislative_chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('spanish', coalesce(content, ''))) stored;

create index if not exists legislative_chunks_tsv_idx
  on legislative_chunks using gin (content_tsv);

-- 2. Hybrid RPC — Reciprocal Rank Fusion of dense + sparse rankings.
--
-- RRF formula per result: sum over ranking sources of 1 / (k + rank).
-- k=60 is the standard from the original Cormack et al. paper. Higher
-- k → smoother contribution (lower-ranked items still matter); lower k
-- → top-ranked dominate.
--
-- The function over-fetches both branches at `match_count * 4` to give
-- RRF enough material to rerank, then trims to `match_count`.
create or replace function match_chunks_hybrid(
  query_embedding vector(3072),
  query_text text,
  match_count int default 10,
  filter_session_id uuid default null,
  filter_source_type text default null,
  filter_source_ref_prefix text default null,
  rrf_k int default 60
)
returns table (
  chunk_id uuid,
  session_id uuid,
  source_ref text,
  source_type text,
  chunk_index int,
  content text,
  dense_similarity float,
  bm25_score float,
  rrf_score float,
  fecha date,
  comision text,
  tipo text,
  video_url text,
  transcript_url text,
  metadata jsonb
)
language sql stable
security invoker
set search_path = public
as $$
  with
    -- Dense branch — pgvector cosine, identical to match_chunks_v2 minus
    -- the inner select limit / ordering (we keep limit but apply RRF
    -- outside). NULL filters mean "match everything".
    dense as (
      select
        c.id as chunk_id,
        1 - (c.embedding <=> query_embedding) as similarity,
        row_number() over (order by c.embedding <=> query_embedding asc) as rnk
      from legislative_chunks c
      where
        (filter_session_id is null or c.session_id = filter_session_id)
        and (filter_source_type is null or c.source_type = filter_source_type)
        and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
        and c.embedding is not null
      order by c.embedding <=> query_embedding asc
      limit greatest(match_count * 4, 50)
    ),
    -- Sparse branch — Postgres BM25-like via ts_rank_cd. websearch_to_tsquery
    -- accepts natural language ("Ley 6727 traslado riesgos") and yields a
    -- tsquery that respects quoting and OR/AND operators; ranking is
    -- length-normalized which matters for chunks of varying size.
    sparse as (
      select
        c.id as chunk_id,
        ts_rank_cd(c.content_tsv, websearch_to_tsquery('spanish', query_text)) as score,
        row_number() over (
          order by ts_rank_cd(c.content_tsv, websearch_to_tsquery('spanish', query_text)) desc
        ) as rnk
      from legislative_chunks c
      where
        (filter_session_id is null or c.session_id = filter_session_id)
        and (filter_source_type is null or c.source_type = filter_source_type)
        and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
        and c.content_tsv @@ websearch_to_tsquery('spanish', query_text)
      order by ts_rank_cd(c.content_tsv, websearch_to_tsquery('spanish', query_text)) desc
      limit greatest(match_count * 4, 50)
    ),
    -- Fuse: a chunk gets RRF contributions from each branch where it
    -- appears. Missing in a branch → that branch contributes 0.
    fused as (
      select
        coalesce(d.chunk_id, s.chunk_id) as chunk_id,
        d.similarity as dense_similarity,
        coalesce(s.score, 0) as bm25_score,
        (case when d.rnk is not null then 1.0 / (rrf_k + d.rnk) else 0 end)
          + (case when s.rnk is not null then 1.0 / (rrf_k + s.rnk) else 0 end)
          as rrf_score
      from dense d
      full outer join sparse s on s.chunk_id = d.chunk_id
    )
  select
    c.id as chunk_id,
    c.session_id,
    c.source_ref,
    c.source_type,
    c.chunk_index,
    c.content,
    f.dense_similarity,
    f.bm25_score,
    f.rrf_score,
    s.fecha,
    s.comision,
    s.tipo,
    s.video_url,
    s.transcript_url,
    c.metadata
  from fused f
  join legislative_chunks c on c.id = f.chunk_id
  left join sessions s on s.id = c.session_id
  order by f.rrf_score desc
  limit match_count;
$$;

grant execute on function match_chunks_hybrid to authenticated, service_role;

-- 3. (optional) function to inspect a query's tokens — useful for
-- debugging when something doesn't match. NOT required for production.
create or replace function debug_query_tokens(q text)
returns text language sql stable as $$
  select to_tsquery('spanish', q)::text;
$$;
