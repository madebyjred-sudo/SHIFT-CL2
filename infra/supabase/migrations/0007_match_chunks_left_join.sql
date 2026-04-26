-- shift-cl2 — match_chunks_v2 with LEFT JOIN (supports session-less chunks).
--
-- The original match_chunks (0002) does INNER JOIN sessions on session_id.
-- That excludes chunks where session_id IS NULL — namely the Reglamento and
-- SIL chunks (sil_dictamen, sil_mocion, sil_expediente, etc). The original
-- function is preserved unchanged for plenaria callers; this v2 is what
-- reglamento + SIL searches use going forward.
--
-- Idempotent. Run after the chunks are populated; takes effect on next call.

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
  select
    c.id as chunk_id,
    c.session_id,
    c.source_ref,
    c.source_type,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    s.fecha,
    s.comision,
    s.tipo,
    s.video_url,
    s.transcript_url,
    c.metadata
  from legislative_chunks c
  left join sessions s on s.id = c.session_id
  where
    (filter_session_id is null or c.session_id = filter_session_id)
    and (filter_source_type is null or c.source_type = filter_source_type)
    and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
  order by c.embedding <=> query_embedding asc
  limit match_count;
$$;

grant execute on function match_chunks_v2 to authenticated, service_role;
