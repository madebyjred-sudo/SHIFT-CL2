-- 0017_ai_call_log.sql
--
-- Per-user daily-quota substrate. Every billable AI call (LLM
-- transform, architect, voice STT, etc.) writes one row here. The BFF
-- checks the count before dispatching to OpenRouter / ElevenLabs and
-- 429s if the user is over budget.
--
-- Why a single table vs per-feature counters: generic = one place to
-- audit cost, one place to bump limits, simpler to reason about. Each
-- row is ~80 bytes, 5-10 users * 100 calls/day = ≤1MB/year — trivial.
--
-- Counters never delete; the cap function counts last 24h. A nightly
-- vacuum / 90-day archive job is cheap to add later.

create table if not exists ai_call_log (
  id          bigserial primary key,
  user_id     uuid not null,
  route       text not null,                  -- 'workspace.chat' | 'workspace.architect' | 'workspace.transform' | 'voice.transcribe'
  tokens_in   integer default 0,
  tokens_out  integer default 0,
  meta        jsonb default '{}'::jsonb,      -- model, scope_kind, etc.
  created_at  timestamptz not null default now()
);

create index if not exists ai_call_log_user_day
  on ai_call_log (user_id, created_at desc);

create index if not exists ai_call_log_route_day
  on ai_call_log (route, created_at desc);

-- RLS: users see their own rows. The service-role key inserts/reads
-- across all rows for cap checks.
alter table ai_call_log enable row level security;

create policy ai_call_log_select_own on ai_call_log
  for select using (auth.uid() = user_id);

-- Daily-count helper. Pass `route_prefix` to scope (e.g.
-- 'workspace.' to count workspace ops only) or null for total.
create or replace function ai_calls_user_daily_count(uid uuid, route_prefix text default null)
returns int
language sql
stable
as $$
  select count(*)::int
  from ai_call_log
  where user_id = uid
    and created_at > now() - interval '24 hours'
    and (route_prefix is null or route like route_prefix || '%');
$$;

comment on table ai_call_log is
  'One row per billable AI call. Drives per-user daily quota checks '
  'and cost auditing. Service-role inserts; RLS shows own rows only.';
