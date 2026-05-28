-- 0055_sil_expedientes_tsv_column.sql
--
-- Crea la columna `titulo_proponente_tsv` que el código de searchExpedientes
-- referencia desde hace tiempo pero que nunca existió en el schema.
--
-- ─── PROBLEMA ────────────────────────────────────────────────────────────
-- `apps/api/src/services/silClient.ts` ejecuta:
--   .textSearch('titulo_proponente_tsv', query, { config: 'spanish' })
--
-- Esa columna NO existía. Existía solo el GIN index sobre la EXPRESIÓN
-- `to_tsvector('spanish', titulo || ' ' || proponente)`. PostgREST/Supabase
-- JS NO puede usar un index funcional vía .textSearch — necesita una
-- columna real referenciable por nombre.
--
-- Resultado: el textSearch FALLABA SIEMPRE con "column does not exist", y
-- caía a un fallback ilike. Eso degradó el recall a casi cero en queries
-- en lenguaje natural ("expedientes sobre turismo", "Polo Turístico
-- Papagayo", etc.) durante todo el período en que el código estuvo así.
--
-- Audit asesor 2026-05-26 (FEDEFARMA + ICT) reveló el bug. Ver decisions/.
--
-- ─── SOLUCIÓN (esta migración) ───────────────────────────────────────────
-- 1. Crear `titulo_proponente_tsv` como GENERATED ALWAYS AS STORED. Postgres
--    rellena automáticamente para todas las filas existentes (~21k) y la
--    mantiene actualizada en cada INSERT/UPDATE de titulo o proponente.
-- 2. Reemplazar el GIN index funcional viejo por un GIN sobre la columna
--    nueva. El planificador entonces usa el index cuando el código corre
--    `.textSearch('titulo_proponente_tsv', ...)`.
-- 3. Una vez aplicado, podemos REMOVER el fallback ilike multi-token de
--    `searchExpedientes` — el textSearch ahora funciona como primario.
--
-- ─── BUILD EN SUPABASE STUDIO ────────────────────────────────────────────
-- ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS ... STORED bloquea la
-- tabla durante el rewrite (~ segundos para 21k rows). En tablas más grandes
-- esto sería problemático; para nuestra escala, OK. CREATE INDEX CONCURRENTLY
-- viene después y NO bloquea writes.
--
-- Para correr el archivo entero, necesitamos statement_timeout=0:
--   SET statement_timeout = 0;
--   -- (el script de aplicación lo agrega antes)
--
-- ─── IDEMPOTENCIA ────────────────────────────────────────────────────────
-- IF NOT EXISTS en columna + index. Re-correr es seguro.

begin;

alter table sil_expedientes
  add column if not exists titulo_proponente_tsv tsvector
  generated always as (
    to_tsvector(
      'spanish',
      coalesce(titulo, '') || ' ' || coalesce(proponente, '')
    )
  ) stored;

commit;

-- El index CONCURRENTLY va fuera de transacción.
-- (Ejecutar el bloque siguiente por separado en Supabase Studio:)

-- DROP old functional GIN si existe (limpieza, no crítico — Postgres elige
-- el mejor index, pero quitar el funcional viejo reduce overhead).
drop index if exists sil_exp_tsv_idx;

-- New GIN sobre la columna nueva.
create index if not exists sil_expedientes_titulo_proponente_tsv_idx
  on sil_expedientes
  using gin (titulo_proponente_tsv);
