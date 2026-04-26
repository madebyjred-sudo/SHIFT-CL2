-- shift-cl2 — extend legislative_chunks.source_type with 'reglamento'.
--
-- Motivation: the Reglamento de la Asamblea Legislativa de Costa Rica
-- (96 articles) is the institutional procedural knowledge layer for
-- Lexa/Atlas. We index each article as a single chunk and want a
-- recognizable source_type so the new `search_reglamento` tool can
-- filter without ambiguity.
--
-- The previous constraint (added in 0005) listed: 'transcript', 'pdf',
-- 'web', 'metadata', 'sil_expediente', 'sil_dictamen', 'sil_mocion',
-- 'sil_votacion', 'sil_acta', 'sil_ley'. We add 'reglamento'.
--
-- Idempotent. Apply via Supabase Studio.

alter table legislative_chunks
  drop constraint if exists legislative_chunks_source_type_check;

alter table legislative_chunks
  add constraint legislative_chunks_source_type_check
  check (source_type in (
    'transcript', 'pdf', 'web', 'metadata',
    'sil_expediente', 'sil_dictamen', 'sil_mocion',
    'sil_votacion', 'sil_acta', 'sil_ley',
    'reglamento'
  ));
