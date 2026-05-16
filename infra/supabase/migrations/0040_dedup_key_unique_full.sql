-- 0040_dedup_key_unique_full.sql
--
-- Sprint 2 Track I fix — reemplaza el UNIQUE parcial de 0039 por uno completo.
--
-- Problema: PostgreSQL acepta `ON CONFLICT (cols)` solo si hay un unique
-- index o constraint que matchea EXACTAMENTE (col1, col2) sin WHERE. Un
-- UNIQUE parcial (WHERE dedup_key IS NOT NULL) requiere repetir el WHERE
-- en el ON CONFLICT, y supabase-js .upsert({}, { onConflict: 'a,b' }) no
-- soporta agregar predicado.
--
-- Error textual visto:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Fix: drop el parcial y crear UNIQUE completo `(user_id, dedup_key)`. En
-- PostgreSQL, NULL en columnas de unique permite múltiples filas por SQL
-- standard. Entonces:
--   (NULL, NULL)    → varias filas legacy OK
--   (uuid, 'key')   → una sola, dedup como queremos
--   (NULL, 'key')   → una sola
--
-- O sea, el comportamiento es idéntico al partial sin el agujero del
-- ON CONFLICT.

-- Index real creado por 0039 (verificado en migration file).
drop index if exists centinela_eventos_dedup_idx;

create unique index if not exists centinela_eventos_user_dedup_full_idx
  on centinela_eventos (user_id, dedup_key);

comment on index centinela_eventos_user_dedup_full_idx is
  'Unique total sobre (user_id, dedup_key). NULL en cualquier columna NO
   bloquea inserts adicionales — PostgreSQL trata NULL como distinct por
   SQL standard. Permite ON CONFLICT (user_id, dedup_key) sin WHERE.
   Reemplaza el partial idx 0039 que no era usable como ON CONFLICT target.';
