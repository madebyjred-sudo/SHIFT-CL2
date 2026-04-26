-- shift-cl2 — admin console persistence layer.
--
-- This migration creates the tables that back the admin console so
-- every button is real, not a stub. Five small tables, each addressing
-- one section's data need:
--
--   1. audit_log              — every admin action lands here, with
--                               actor, verb, resource, outcome.
--   2. transcripciones_review — moderation decisions on auto-transcribed
--                               sessions (independent of the legacy
--                               transcript text store).
--   3. feature_flags          — server-side flags read by both BFF and
--                               Cerebro to gate behaviors at request
--                               time. Replaces local-only toggles.
--   4. agent_overrides        — per-agent enable/disable + (future)
--                               model overrides decided by the operator.
--                               Honored by the chat router.
--   5. expedientes_watchlist  — user opts an expediente in for "alert
--                               me on changes". Per-user + per-exp.
--
-- Naming: snake_case, no plural prefixes. RLS policies are deliberately
-- LIBERAL during the demo period (any authenticated user reads/writes);
-- tighten to role-based when we open up to outside tenants.

-- ─── audit_log ───────────────────────────────────────────────────────
create table if not exists audit_log (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  actor_id     uuid references auth.users(id) on delete set null,
  actor_email  text,
  actor_kind   text not null default 'human' check (actor_kind in ('human','system')),
  verb         text not null,                          -- approved, rejected, invited, toggled, ...
  resource     text not null,                          -- free-form, e.g. "consolidación #214"
  resource_kind text,                                  -- consolidation | pattern | transcription | user | flag | agent
  resource_id  text,                                   -- foreign key surface (uuid or numeric id, stringified)
  ip           inet,
  result       text not null default 'ok' check (result in ('ok','error','retry')),
  metadata     jsonb default '{}'::jsonb               -- arbitrary detail (before/after for toggles, etc.)
);
create index if not exists audit_log_ts_idx on audit_log (ts desc);
create index if not exists audit_log_actor_idx on audit_log (actor_id);
create index if not exists audit_log_resource_kind_idx on audit_log (resource_kind);

alter table audit_log enable row level security;
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select to authenticated using (true);
-- Inserts come from the BFF using the service-role key. No client-side
-- inserts allowed (no insert policy → blocked by default).


-- ─── transcripciones_review ──────────────────────────────────────────
-- One row per (session × decision). The mock UI today shows a static
-- queue; once the legacy worker is rewired to publish events, this
-- table will be the source of truth for both the queue and the join
-- against the chunkstore.
-- session_id here is intentionally `text` and FK-less. The user-facing
-- "session" identity comes from the legacy CL2 MariaDB (integer ids
-- exposed via the BFF), not from Supabase's `sessions` table. Keeping
-- this column loose means the legacy worker can land rows without us
-- having to mirror sessions into Supabase first.
create table if not exists transcripciones_review (
  id              uuid primary key default gen_random_uuid(),
  session_id      text,
  external_id     text unique,                              -- the transcript job id (e.g. tr-1287)
  status          text not null default 'pending'
                    check (status in ('pending','in_progress','approved','rejected')),
  confidence      numeric(5,2),                             -- 0..100
  flagged_segments int default 0,
  source          text default 'whisper-large-v3',
  speaker         text,
  excerpt_text    text,
  excerpt_ts      text,
  payload         jsonb,                                    -- full segments + diarization blob
  reviewed_by     uuid references auth.users(id) on delete set null,
  reviewed_at     timestamptz,
  reviewer_note   text,
  created_at      timestamptz not null default now()
);
create index if not exists trans_review_status_idx on transcripciones_review (status);
create index if not exists trans_review_created_idx on transcripciones_review (created_at desc);

alter table transcripciones_review enable row level security;
drop policy if exists trans_review_read on transcripciones_review;
create policy trans_review_read on transcripciones_review for select to authenticated using (true);


-- ─── feature_flags ───────────────────────────────────────────────────
-- One row per flag. Values are jsonb to support boolean | string |
-- numeric | structured config (e.g. routing thresholds).
create table if not exists feature_flags (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);

alter table feature_flags enable row level security;
drop policy if exists feature_flags_read on feature_flags;
create policy feature_flags_read on feature_flags for select to authenticated using (true);

-- Seed the canonical flags so the UI shows something on first paint.
-- ON CONFLICT DO NOTHING — safe to re-run.
insert into feature_flags (key, value, description) values
  ('deep_insight',     'true'::jsonb,  'Botón Deep Insight visible en el composer (cuesta más)'),
  ('voice_query',      'false'::jsonb, 'Captura de voz (Whisper en navegador). Beta'),
  ('exp_extract',      'true'::jsonb,  'Atlas detecta Exp. NN.NNN y los pre-carga'),
  ('citations_force',  'true'::jsonb,  'Bloquea respuestas sin al menos una cita'),
  ('hybrid_retrieval', 'true'::jsonb,  'BM25 + dense + RRF en match_chunks_hybrid'),
  ('graph_rag',        'false'::jsonb, 'Tool query_legislative_graph activa (requiere LightRAG instalado)')
on conflict (key) do nothing;


-- ─── agent_overrides ─────────────────────────────────────────────────
-- One row per agent_id known to the BFF. Drives the chat router's
-- enable/disable check and (future) per-agent model overrides.
create table if not exists agent_overrides (
  agent_id     text primary key,
  enabled      boolean not null default true,
  model        text,                          -- when set, overrides the YAML default
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);

alter table agent_overrides enable row level security;
drop policy if exists agent_overrides_read on agent_overrides;
create policy agent_overrides_read on agent_overrides for select to authenticated using (true);

insert into agent_overrides (agent_id, enabled) values
  ('lexa',      true),
  ('atlas',     true),
  ('centinela', true)
on conflict (agent_id) do nothing;


-- ─── expedientes_watchlist ──────────────────────────────────────────
-- Per-user opt-in for change alerts on a given expediente. Composite
-- PK so a user can only watch each expediente once.
create table if not exists expedientes_watchlist (
  user_id        uuid not null references auth.users(id) on delete cascade,
  expediente_id  bigint not null references sil_expedientes(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, expediente_id)
);
create index if not exists watchlist_expediente_idx on expedientes_watchlist (expediente_id);

alter table expedientes_watchlist enable row level security;
drop policy if exists watchlist_self on expedientes_watchlist;
create policy watchlist_self on expedientes_watchlist
  for all to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
