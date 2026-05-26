-- shift-cl2 — Wave 4 #2: extend legislative_chunks.source_type with
-- 'constitucion' and 'loal'.
--
-- Lawyer audit (2026-05-26) reveló que Lexa NO podía responder preguntas
-- sobre:
--   • tratados internacionales (Constitución Art. 121 inciso 4)
--   • elección de magistrados de la Sala IV (Constitución Art. 158-163)
--   • plazo de resello tras veto presidencial (Constitución Art. 127)
--   • inmunidad parlamentaria (Constitución Art. 110-112)
--   • juramentación de diputados (LOAL)
-- porque ninguna de esas materias está en el Reglamento Asamblea ni en el
-- RAL Comentado (los únicos cuerpos normativos indexados hasta ahora).
--
-- Constitución Política de Costa Rica — 197 artículos vigentes.
-- LOAL (Ley Orgánica del Poder Legislativo / Ley Orgánica de la Asamblea
-- Legislativa) — ~100 artículos.
--
-- Ambos cuerpos van a legislative_chunks con un source_type propio para
-- que `searchConstitucionLoal` filtre por prefix en match_chunks_hybrid
-- igual que searchReglamento ya hace con 'Reglamento Asamblea'.
--
-- Idempotente. Apply via Supabase Studio o `supabase db push`.

alter table legislative_chunks
  drop constraint if exists legislative_chunks_source_type_check;

alter table legislative_chunks
  add constraint legislative_chunks_source_type_check
  check (source_type in (
    'transcript', 'pdf', 'web', 'metadata',
    'sil_expediente', 'sil_dictamen', 'sil_mocion',
    'sil_votacion', 'sil_acta', 'sil_ley',
    'reglamento',
    'constitucion', 'loal'
  ));
