-- shift-cl2 — match_chunks_v3 with metadata + comision/fecha filters.
--
-- WHY THIS EXISTS
-- ---------------
-- The legacy match_chunks (0002) returns chunks but NOT the per-chunk metadata
-- jsonb. For transcript chunks this metadata carries {start, end, word_count}
-- — the per-chunk timecode that lets Lexa/Atlas/Centinela cite a plenary
-- intervention with a precise HH:MM:SS pointer instead of just "según la
-- sesión #84". The lack of metadata at the RPC layer was the data-side
-- reason Ronald's experience felt like "ducktape" citations.
--
-- match_chunks_v2 (0007) returns metadata but lacks the comision / fecha
-- filters that the corpus-wide search_transcripts tool exposes. v3 unifies
-- both: comision + fecha + source_type + source_ref_prefix filters AND
-- metadata + similarity in the return shape.
--
-- BACKWARDS COMPAT
-- ----------------
-- - match_chunks (v1) is preserved. Nothing else is dropped.
-- - match_chunks_v2 is preserved (used by reglamento + SIL paths).
-- - The TS layer can migrate corpus-wide transcript search to v3 to gain
--   metadata, then drop v1's call site at leisure.
--
-- Idempotent. Apply via Supabase Studio.

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
    and (filter_comision is null or s.comision = filter_comision)
    and (filter_fecha_from is null or s.fecha >= filter_fecha_from)
    and (filter_fecha_to is null or s.fecha <= filter_fecha_to)
    and (filter_source_type is null or c.source_type = filter_source_type)
    and (filter_source_ref_prefix is null or c.source_ref like filter_source_ref_prefix || '%')
    and c.embedding is not null
  order by c.embedding <=> query_embedding asc
  limit match_count;
$$;

grant execute on function match_chunks_v3 to authenticated, service_role;

comment on function match_chunks_v3 is
  'Semantic search over legislative_chunks returning metadata jsonb (per-chunk '
  'start/end timecodes for transcripts, page refs for PDFs). Used by Lexa/Atlas/'
  'Centinela to surface HH:MM:SS citations from plenary transcripts and page '
  'numbers from SIL documents. Supersedes match_chunks (v1) for any caller '
  'that needs metadata.';
