-- 0056_sil_search_text_rpc.sql
--
-- RPC `search_sil_expedientes_by_text` — búsqueda full-text de
-- expedientes con OR-semantic + ranking.
--
-- ─── PROBLEMA ────────────────────────────────────────────────────────────
-- `websearch_to_tsquery` y `plainto_tsquery` (los que expone Supabase JS
-- via .textSearch) usan AND entre lexemas por default. Eso significa que
-- "Polo Turístico Golfo Papagayo" requiere que TODOS los lexemas estén
-- en el documento — pero ningún título de expediente tiene "Polo" (lo
-- llaman "Proyecto Turístico"), entonces el match falla.
--
-- Cliente CL2 doctrina: queries en lenguaje natural deben devolver
-- expedientes relevantes aunque no matcheen palabra-por-palabra. La forma
-- correcta es OR + ranking por relevancia, no AND estricto.
--
-- ─── SOLUCIÓN ────────────────────────────────────────────────────────────
-- Function Postgres que toma el query, lo tokeniza, filtra stopwords +
-- tokens cortos, construye `to_tsquery` con OR entre lexemas, ranquea por
-- ts_rank y devuelve top-K. El código TS llama via supa.rpc() en lugar de
-- .textSearch, eliminando la dependencia del fallback ilike.

create or replace function search_sil_expedientes_by_text(
  query_text text,
  match_limit int default 10,
  filter_comision text default null,
  filter_fecha_from date default null,
  filter_fecha_to date default null
)
returns table (
  id int,
  numero text,
  titulo text,
  proponente text,
  comision text,
  fecha_presentacion date,
  estado text,
  tipo text,
  legislatura text,
  url_detalle text,
  extras jsonb,
  rank real
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  ts_query tsquery;
  -- Construimos el tsquery manualmente con OR entre lexemas relevantes
  -- (length >= 3, ignoramos lo que ts_lexize ya considera stopword).
  lexemes text;
begin
  -- Pre-tokenizar: extraer palabras alphanum + length>=3 + lower + sin acentos.
  -- websearch_to_tsquery('spanish', X) hace stemming pero retorna AND; vamos a
  -- usar to_tsquery con join '|' manual.
  select string_agg(distinct lexeme, ' | ')
    into lexemes
    from (
      select lexeme
      from unnest(
        to_tsvector(
          'spanish',
          coalesce(query_text, '')
        )
      ) as t(lexeme, positions, weights)
      where length(lexeme) >= 3
    ) sub;

  if lexemes is null or length(lexemes) = 0 then
    return; -- No hay lexemas relevantes — sin resultados.
  end if;

  begin
    ts_query := to_tsquery('spanish', lexemes);
  exception when others then
    return; -- Query inválido — sin resultados.
  end;

  return query
  select
    e.id,
    e.numero,
    e.titulo,
    e.proponente,
    e.comision,
    e.fecha_presentacion,
    e.estado,
    e.tipo,
    e.legislatura,
    e.url_detalle,
    e.extras,
    ts_rank(e.titulo_proponente_tsv, ts_query) as rank
  from sil_expedientes e
  where e.titulo_proponente_tsv @@ ts_query
    and (filter_comision is null or e.comision = filter_comision)
    and (filter_fecha_from is null or e.fecha_presentacion >= filter_fecha_from)
    and (filter_fecha_to is null or e.fecha_presentacion <= filter_fecha_to)
  order by rank desc
  limit greatest(1, least(match_limit, 50));
end;
$$;

-- Permitir invocación desde service-role (es la única que llamamos).
-- RLS sigue aplicando — esta function es STABLE + security invoker, no escala
-- privilegios.

comment on function search_sil_expedientes_by_text(text, int, text, date, date) is
  'Búsqueda full-text sobre sil_expedientes con OR-semantic + ts_rank. '
  'Reemplaza el .textSearch que requería AND estricto. '
  'Migration 0056 (audit asesor 2026-05-26).';
