-- 0048_ai_call_log_tokens_precise.sql
-- Token accounting certero por user (Supabase Auth uid).
--
-- ai_call_log existe desde 0017 con tokens_in/tokens_out/meta. Esta
-- migración extiende para que el contador sea CERTERO:
--   - model: identificador del modelo concreto ("anthropic/claude-sonnet-4",
--     "google/gemini-2.5-flash", etc.) — el meta jsonb venía con eso a
--     veces pero sin estructura. Ahora columna explícita.
--   - provider: openrouter / vertex / elevenlabs — para agrupar por
--     vendor en facturación.
--   - cache_read_tokens / cache_create_tokens: Anthropic prompt caching
--     factura 10% del read y 125% del create — ignorarlos es ±30% error.
--   - cost_usd_estimated: calculado en el momento del log con la pricing
--     table de tokenAccounting.ts. Materializado para no re-calcular en
--     cada query de agregados.
--   - latency_ms: para correlacionar costo vs perf por modelo.
--   - error_message: cuando la llamada falla pero igual consumió tokens
--     (timeout post-prompt-eval), o cuando queremos loggear el error.
--
-- Pricing table:
--   Vive en código (apps/api/src/services/tokenAccounting.ts) porque
--   los costos cambian frecuentemente y mantenerlos en código permite
--   versionar el cambio + atribución por commit. La columna materializa
--   el costo al momento del log; un cambio de pricing post-hoc NO
--   re-calcula histórico.
--
-- RLS:
--   service_role puede insert (lo hace el BFF). Lectura admin via los
--   helpers RPC abajo.

alter table ai_call_log add column if not exists model text;
alter table ai_call_log add column if not exists provider text;
alter table ai_call_log add column if not exists cache_read_tokens integer not null default 0;
alter table ai_call_log add column if not exists cache_create_tokens integer not null default 0;
alter table ai_call_log add column if not exists cost_usd_estimated numeric(10, 6) not null default 0;
alter table ai_call_log add column if not exists latency_ms integer;
alter table ai_call_log add column if not exists error_message text;

-- Index para los agregados típicos (por user + ventana de tiempo)
create index if not exists ai_call_log_user_ts_idx
  on ai_call_log (user_id, created_at desc);

create index if not exists ai_call_log_user_provider_ts_idx
  on ai_call_log (user_id, provider, created_at desc);

create index if not exists ai_call_log_route_ts_idx
  on ai_call_log (route, created_at desc);

-- View materialized-friendly: agregados por user en últimos 30 días.
-- No usamos materialized view porque queremos ver el ahora; el index
-- compuesto arriba hace la query sub-second.
create or replace view v_ai_usage_by_user_30d as
select
  user_id,
  count(*)                                  as call_count,
  sum(tokens_in)                            as tokens_in_sum,
  sum(tokens_out)                           as tokens_out_sum,
  sum(cache_read_tokens)                    as cache_read_sum,
  sum(cache_create_tokens)                  as cache_create_sum,
  sum(tokens_in + tokens_out)               as tokens_total_sum,
  sum(cost_usd_estimated)                   as cost_usd_sum,
  max(created_at)                           as last_call_at,
  min(created_at)                           as first_call_at,
  count(distinct date(created_at))          as active_days,
  count(distinct model)                     as models_used,
  count(*) filter (where error_message is not null) as errors_count
from ai_call_log
where created_at >= now() - interval '30 days'
group by user_id;

-- View por user × provider × modelo (para el desglose del frontend).
create or replace view v_ai_usage_by_user_model_30d as
select
  user_id,
  provider,
  model,
  count(*)                          as call_count,
  sum(tokens_in)                    as tokens_in_sum,
  sum(tokens_out)                   as tokens_out_sum,
  sum(cache_read_tokens)            as cache_read_sum,
  sum(cache_create_tokens)          as cache_create_sum,
  sum(cost_usd_estimated)           as cost_usd_sum,
  avg(latency_ms)::integer          as avg_latency_ms,
  max(created_at)                   as last_call_at
from ai_call_log
where created_at >= now() - interval '30 days'
group by user_id, provider, model;

-- Function helper para agregados por ventana custom (días).
create or replace function ai_usage_by_user(p_user_id uuid, p_window_days int default 30)
returns table (
  call_count bigint,
  tokens_in_sum bigint,
  tokens_out_sum bigint,
  cache_read_sum bigint,
  cache_create_sum bigint,
  cost_usd_sum numeric,
  by_model jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select * from ai_call_log
    where user_id = p_user_id
      and created_at >= now() - (p_window_days || ' days')::interval
  ),
  agg as (
    select
      count(*) as call_count,
      sum(tokens_in)::bigint as tokens_in_sum,
      sum(tokens_out)::bigint as tokens_out_sum,
      sum(cache_read_tokens)::bigint as cache_read_sum,
      sum(cache_create_tokens)::bigint as cache_create_sum,
      sum(cost_usd_estimated) as cost_usd_sum
    from rows
  ),
  by_model_agg as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'provider', provider,
      'model', model,
      'call_count', cnt,
      'tokens_total', total_tokens,
      'cost_usd', cost
    ) order by cost desc), '[]'::jsonb) as by_model
    from (
      select provider, model,
        count(*) as cnt,
        sum(tokens_in + tokens_out)::bigint as total_tokens,
        sum(cost_usd_estimated) as cost
      from rows
      group by provider, model
    ) t
  )
  select a.call_count, a.tokens_in_sum, a.tokens_out_sum,
         a.cache_read_sum, a.cache_create_sum, a.cost_usd_sum,
         b.by_model
  from agg a cross join by_model_agg b;
$$;

grant execute on function ai_usage_by_user(uuid, int) to service_role;
grant select on v_ai_usage_by_user_30d to service_role;
grant select on v_ai_usage_by_user_model_30d to service_role;
