-- 0047_legislative_chunks_hnsw.sql
--
-- Vector index sobre legislative_chunks.embedding para resolver el bug de
-- `match_chunks_v2 RPC timeout` que tumbaba `centinela-similar-detect`.
--
-- ─── PROBLEMA ────────────────────────────────────────────────────────────
-- La tabla `legislative_chunks` tiene 825,774 filas con embeddings
-- vector(3072) (Gemini gemini-embedding-001 a 3072 dimensiones).
-- Cualquier query con `embedding <=> $1` hace sequential scan sobre todo
-- el corpus + comparación O(N) — en pgvector sin índice esto es lo
-- esperado, pero a 825k filas × 3072 dims tarda > 8s (statement_timeout
-- default de PostgREST y de la función match_chunks_v2).
--
-- Error observado en prod 2026-05-18 → 2026-05-19 (3 días de cron en
-- failure silencioso):
--   { "msg": "similar_detect_search_error",
--     "error": "match_chunks_v2 RPC error: canceling statement due to statement timeout",
--     "expediente_id": 22425 }
--
-- ─── SOLUCIÓN ────────────────────────────────────────────────────────────
-- pgvector ofrece dos tipos de índice vectorial: IVFFlat y HNSW.
-- IVFFlat es más simple pero tiene un cap duro de 2000 dimensiones —
-- inutilizable para nuestros embeddings de 3072 dims.
--
-- HNSW (Hierarchical Navigable Small World) sí soporta hasta 2000 dims
-- nativamente, pero con cast a `halfvec(3072)` (half-precision, 2 bytes
-- por dim en lugar de 4) sube el cap a 4000. La pérdida de precisión es
-- imperceptible para búsqueda semántica top-K (la diferencia perceptual
-- entre dos embeddings cosine-similar está en el 6º decimal o más allá,
-- bien fuera del rango de halfvec).
--
-- pgvector >= 0.7 soporta halfvec (Supabase migró a 0.8+ desde 2024).
--
-- Costo del índice:
--   - Almacenamiento: ~ 825k × 3072 × 2 bytes = 5 GB en disco
--   - Build time: 15-30 min en Supabase Pro (estimado)
--   - Query time post-índice: <100ms vs >8s sin índice
--
-- ─── IDEMPOTENCIA ────────────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY NO bloquea writes mientras se construye, pero:
--   - NO puede correr en transacción (Supabase Studio lo envuelve auto,
--     hay que ejecutarlo solo, sin BEGIN/COMMIT manual)
--   - Si falla a la mitad, deja el índice INVALID — hay que dropearlo
--     manualmente y re-correr.
--
-- Las funciones match_chunks_v2 / match_chunks_v3 se actualizan después
-- para usar el cast halfvec en el ORDER BY, así Postgres elige el índice
-- HNSW en el plan.

-- ═══════════════════════════════════════════════════════════════════════
-- 1) CREATE HNSW INDEX (concurrent — no bloquea writes)
-- ═══════════════════════════════════════════════════════════════════════

create index concurrently if not exists legislative_chunks_embedding_hnsw_halfvec_idx
  on legislative_chunks
  using hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ═══════════════════════════════════════════════════════════════════════
-- 2) UPDATE match_chunks_v2 para usar el cast halfvec
-- ═══════════════════════════════════════════════════════════════════════

create or replace function match_chunks_v2(
  query_embedding vector(3072),
  match_count int default 5,
  filter_session_id uuid default null,
  filter_source_type text default null,
  filter_source_ref_prefix text default null
)
returns table (
  chunk_id uuid,
  session_id uuid,
  source_ref text,
  source_type text,
  chunk_index int,
  content text,
  similarity float,
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
  -- El cast a halfvec(3072) hace que Postgres use el índice HNSW
  -- legislative_chunks_embedding_hnsw_halfvec_idx en el plan. Sin el cast
  -- caería al sequential scan y volvería al timeout original.
  select
    c.id as chunk_id,
    c.session_id,
    c.source_ref,
    c.source_type,
    c.chunk_index,
    c.content,
    1 - (c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)) as similarity,
    s.fecha,
    s.comision,
    s.tipo,
    s.video_url,
    s.transcript_url,
    c.metadata
  from legislative_chunks c
  left join sessions s on c.session_id = s.id
  where (filter_session_id is null or c.session_id = filter_session_id)
    and (filter_source_type is null or c.source_type = filter_source_type)
    and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
  order by c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)
  limit match_count;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) UPDATE match_chunks_v3 (con metadata + filtros adicionales)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function match_chunks_v3(
  query_embedding vector(3072),
  match_count int default 5,
  filter_session_id uuid default null,
  filter_comision text default null,
  filter_fecha_from date default null,
  filter_fecha_to date default null,
  filter_source_type text default null,
  filter_source_ref_prefix text default null
)
returns table (
  chunk_id uuid,
  session_id uuid,
  source_ref text,
  source_type text,
  chunk_index int,
  content text,
  similarity float,
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
  select
    c.id as chunk_id,
    c.session_id,
    c.source_ref,
    c.source_type,
    c.chunk_index,
    c.content,
    1 - (c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)) as similarity,
    s.fecha,
    s.comision,
    s.tipo,
    s.video_url,
    s.transcript_url,
    c.metadata
  from legislative_chunks c
  left join sessions s on c.session_id = s.id
  where (filter_session_id is null or c.session_id = filter_session_id)
    and (filter_source_type is null or c.source_type = filter_source_type)
    and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
    and (filter_comision is null or s.comision ilike '%' || filter_comision || '%')
    and (filter_fecha_from is null or s.fecha >= filter_fecha_from)
    and (filter_fecha_to is null or s.fecha <= filter_fecha_to)
  order by c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)
  limit match_count;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4) ANALYZE — actualiza estadísticas para que el planner elija el índice
-- ═══════════════════════════════════════════════════════════════════════

analyze legislative_chunks;
