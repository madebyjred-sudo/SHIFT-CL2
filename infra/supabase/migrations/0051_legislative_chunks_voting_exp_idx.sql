-- 0051_legislative_chunks_voting_exp_idx.sql
--
-- Partial index sobre metadata.votando_expediente en legislative_chunks.
--
-- ─── PROBLEMA ────────────────────────────────────────────────────────────
-- Wave 4 #4 + #7 introdujeron `metadata.votando_expediente` para que Lexa
-- pueda asociar chunks de transcript a un expediente votado. Sin embargo,
-- queries que mencionan un expediente específico ("votos del 24.998")
-- terminaban en sequential scan sobre 826k+ rows (5+ segundos), porque
-- no había index sobre el path JSONB.
--
-- Adicionalmente: cuando match_chunks_v3 RPC time-outea (queries amplias
-- sobre HNSW degradado o falta de filter de fecha), Lexa devuelve
-- "no encontré". Este partial index sirve como fallback de alta confianza:
-- searchTranscripts.ts hace un lookup directo por expediente mentioned en
-- la query, antes del semantic search.
--
-- ─── SOLUCIÓN ────────────────────────────────────────────────────────────
-- Partial index sobre la expresión `metadata->>'votando_expediente'` con
-- predicado `IS NOT NULL`. Solo cubre ~100 rows (chunks con linkage de
-- votación), tiny en disco, build en segundos.
--
-- EXPLAIN ANALYZE post-index: 0.5ms (Index Scan) vs 5812ms (Seq Scan).
--
-- ─── BUILD MANUAL EN SUPABASE STUDIO ────────────────────────────────────
-- CREATE INDEX CONCURRENTLY NO puede correr dentro de transacción (Supabase
-- Studio lo envuelve auto). Ejecutar el bloque sin BEGIN/COMMIT, con las
-- SET previas que evitan statement_timeout:
--
--   SET statement_timeout = 0;
--   SET maintenance_work_mem = '512MB';  -- ajustar a tier de Supabase
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS legislative_chunks_voting_exp_idx
--     ON legislative_chunks ((metadata->>'votando_expediente'))
--     WHERE metadata->>'votando_expediente' IS NOT NULL;

create index concurrently if not exists legislative_chunks_voting_exp_idx
  on legislative_chunks ((metadata->>'votando_expediente'))
  where metadata->>'votando_expediente' is not null;
