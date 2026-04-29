-- 0021_user_profile.sql
--
-- Per-user profile captured during the onboarding wizard. Drives:
--   1. Centinela watchlist suggestions (the AI uses this profile to
--      propose expedientes/diputados/temas worth following).
--   2. Atlas brief context (signals + bias for what the user cares about).
--   3. Lexa response calibration (subtle — same persona, but the agent
--      knows the user's role to phrase things appropriately).
--
-- One row per user. RLS forces user_id = auth.uid() — every read/write
-- is scoped, no cross-user leakage even if a token is compromised.

create table if not exists user_profile (
  user_id          uuid primary key references auth.users(id) on delete cascade,

  -- Free-text fields filled during onboarding. The AI helps the user
  -- compose these via "magic help" buttons; final value stored verbatim.
  cargo            text,                   -- "Diputada por Cartago, comisión Hacendarios"
  enfoque          text,                   -- "Reforma fiscal, transparencia, pequeña empresa"
  temas            text[] default '{}',    -- ['fintech', 'pyme', 'transparencia']
  partido          text,                   -- "Partido X" — optional, helps coalition analysis

  -- Onboarding lifecycle
  onboarded_at     timestamptz,            -- NULL until the wizard completes
  onboarding_step  text default 'welcome', -- last completed step (debug/recovery)

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table user_profile enable row level security;

-- Users can read/update their own profile.
drop policy if exists user_profile_read on user_profile;
create policy user_profile_read on user_profile
  for select using (auth.uid() = user_id);

drop policy if exists user_profile_write on user_profile;
create policy user_profile_write on user_profile
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- updated_at trigger
create or replace function set_user_profile_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_profile_updated_at on user_profile;
create trigger user_profile_updated_at
  before update on user_profile
  for each row execute function set_user_profile_updated_at();

comment on table user_profile is
  'Per-user profile captured during onboarding. Drives Centinela watchlist suggestions and gives every agent calibration signals (role, focus areas, themes).';
