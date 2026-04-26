-- shift-cl2 — store enriched WebForms detail-panel fields on sil_expedientes.
--
-- The bulk WebForms backfill (backfill-sil-webforms.ts) only captures
-- (numero, titulo) from the search grid. The Select$0 postback exposes
-- a much richer detail panel: proponente, fecha de inicio/publicación,
-- número de gaceta/alcance/archivado, vencimientos, número de ley, lista
-- completa de firmantes, secuencia de comisiones con fechas.
--
-- Rather than balloon the column count, we fold the long-tail fields
-- into a single `extras` jsonb. The hot-path columns that already exist
-- on the table (proponente, tipo, fecha_presentacion, comision, estado)
-- get backfilled directly from the same enrichment pass.
--
-- Idempotent. Apply via Supabase Studio.

alter table sil_expedientes
  add column if not exists extras jsonb;

-- Index for searches that look at the law number, which is the most common
-- secondary key citizens recognize ("Ley 10234").
create index if not exists sil_exp_extras_ley_idx
  on sil_expedientes ((extras ->> 'numero_ley'))
  where extras is not null;
