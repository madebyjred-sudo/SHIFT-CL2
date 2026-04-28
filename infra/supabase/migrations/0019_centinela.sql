-- 0019_centinela.sql
--
-- Centinela MVP — full schema substrate.
-- Centinela is the proactive watchdog agent: it monitors legislative entities
-- (expedientes, diputados, topics) and surfaces alerts to users without
-- requiring them to ask.
--
-- DESIGN PHILOSOPHY — three principles drive every table here:
--
--   1. ENTITY-AGNOSTIC CORE: centinela_watchlist and centinela_alerts are
--      deliberately NOT coupled to CL2's expediente/diputado tables. The
--      entity_type+entity_id pattern means the same schema reuses directly
--      in SENTINEL (brand monitoring), where entity_type will be
--      'media_outlet' | 'topic' | 'brand'. No structural migration needed.
--
--   2. ENGINE-POPULATED, UI-READ: The alert engine (cron job / Cloud Run)
--      inserts into centinela_alerts; the page only reads. This means page
--      load is pure SQL — zero AI cost at render time. The "Deep Insight"
--      digest (Opus) is a separate async job, not a per-page call.
--
--   3. SHARED COMPUTED STATE: expediente_plazos and agenda_legislativa are
--      shared (not per-user). Deadlines are computed once from Reglamento
--      rules and cached here. User preferences (centinela_alert_prefs)
--      only control WHICH alerts are surfaced — the underlying data is
--      global, preventing N×M recomputation.
--
-- MIGRATION NOTE: expedientes_watchlist (0010_admin_console.sql) is
-- superseded by centinela_watchlist. Its rows are migrated at the bottom
-- of this file and the old table is dropped.
--
-- RLS pattern (consistent with 0018_transcripts.sql):
--   - User-owned tables: SELECT/INSERT/UPDATE/DELETE guarded by auth.uid() = user_id
--   - Shared/computed tables: SELECT = authenticated, writes = service_role only
--     (service_role bypasses RLS — no separate insert policy needed; we use
--     an explicit deny-write policy for authenticated to make intent clear)
--
-- Idempotency: all DDL uses IF NOT EXISTS. Named constraints allow
-- DROP CONSTRAINT IF EXISTS on re-run. Policies use drop-then-create.

-- =====================================================
-- SECTION 1 — Generic entity-agnostic tables
--             (reusable for SENTINEL brand monitoring)
-- =====================================================

-- ─── centinela_watchlist ────────────────────────────────────────────────────
-- The user's personal subscription list. entity_type is free-form so the
-- same table works for CL2 ('expediente' | 'diputado' | 'tema') and SENTINEL
-- ('media_outlet' | 'topic' | 'brand') without schema changes.
--
-- source distinguishes manual opt-ins from automatic workspace subscriptions.
-- 'auto_workspace:<workspace_id>' lets us bulk-unsubscribe if a workspace is
-- deleted, and lets the UI show "you were auto-subscribed from workspace X".
--
-- The 4-column unique constraint (user_id, entity_type, entity_id, source) is
-- intentional: the same expediente can appear twice with sources 'manual' and
-- 'auto_workspace:abc123', representing two independent subscriptions.
-- Deleting the workspace subscription does not cancel the manual one.

create table if not exists centinela_watchlist (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  entity_type     text not null,
                  -- 'expediente' | 'diputado' | 'tema' (CL2)
                  -- 'media_outlet' | 'topic' | 'brand' (SENTINEL)
  entity_id       text not null,
                  -- '24.429' | '<diputado-uuid>' | 'fintech' (CL2)
                  -- Free-form for SENTINEL. TEXT, not int, to support
                  -- both numeric expediente ids and string slugs.
  source          text not null default 'manual',
                  -- 'manual' | 'auto_workspace:<workspace_id>' |
                  -- 'migrated_from_legacy' (used by the data migration below)
  metadata        jsonb default '{}'::jsonb,
                  -- Arbitrary display context: display_name, url, etc.
                  -- Populated by the app at subscribe time so the alert
                  -- engine doesn't need to re-fetch entity details.
  created_at      timestamptz not null default now(),
  constraint centinela_watchlist_unique_subscription
    unique (user_id, entity_type, entity_id, source)
);

create index if not exists centinela_watchlist_user_idx
  on centinela_watchlist (user_id);
  -- Primary access pattern: "get all subscriptions for this user"
  -- Used by the /centinela page and the alert engine's fanout query.

create index if not exists centinela_watchlist_entity_idx
  on centinela_watchlist (entity_type, entity_id);
  -- Secondary access pattern: "who is watching this entity?"
  -- Used by the engine when a state change lands: look up all watchers.

alter table centinela_watchlist enable row level security;

drop policy if exists "centinela_watchlist users read own rows" on centinela_watchlist;
create policy "centinela_watchlist users read own rows"
  on centinela_watchlist for select
  using (auth.uid() = user_id);

drop policy if exists "centinela_watchlist users insert own rows" on centinela_watchlist;
create policy "centinela_watchlist users insert own rows"
  on centinela_watchlist for insert
  with check (auth.uid() = user_id);

drop policy if exists "centinela_watchlist users update own rows" on centinela_watchlist;
create policy "centinela_watchlist users update own rows"
  on centinela_watchlist for update
  using (auth.uid() = user_id);

drop policy if exists "centinela_watchlist users delete own rows" on centinela_watchlist;
create policy "centinela_watchlist users delete own rows"
  on centinela_watchlist for delete
  using (auth.uid() = user_id);

comment on table centinela_watchlist is
  'Entity-agnostic subscription list. Works for CL2 (expedientes/diputados) '
  'and SENTINEL (media_outlet/brand/topic) without schema changes. '
  'source distinguishes manual opt-ins from workspace auto-subscriptions.';


-- ─── centinela_alerts ───────────────────────────────────────────────────────
-- Generated by the alert engine; read by the /centinela page.
-- NEVER inserted from the frontend — only the engine (service_role) writes here.
--
-- dedup_key is a deterministic hash produced by the engine:
--   sha256(user_id || entity_type || entity_id || alert_type || <content-fingerprint>)
-- This prevents alert spam when the cron fires multiple times before the
-- user reads: (user_id, dedup_key) is unique, so the same logical alert
-- can only land once per user.
--
-- read_at is nullable: NULL = unread. The user marks alerts read via an RPC
-- (or direct UPDATE — see policy below). We do NOT use a status enum because
-- the only meaningful state transition is unread → read, and a nullable
-- timestamp is simpler than an enum for filtering ("unread" = WHERE read_at IS NULL).
--
-- delivered_via tracks which channels have already sent this alert
-- (in_app, telegram, slack, email). The engine appends to this array when
-- a delivery succeeds. This prevents double-delivery if the engine retries.

create table if not exists centinela_alerts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  entity_type     text not null,
  entity_id       text not null,
  alert_type      text not null
                  check (alert_type in (
                    'state_change',   -- expediente moved to new state/comision
                    'deadline',       -- Reglamento deadline approaching
                    'mention',        -- entity mentioned in session/agenda
                    'similar',        -- semantically similar new expediente detected
                    'agenda',         -- entity appears on tomorrow's order of business
                    'digest_weekly'   -- weekly Opus digest (Pro tier)
                  )),
  severity        text not null default 'info'
                  check (severity in ('info', 'warning', 'critical')),
                  -- 'info'     → FYI, expediente appeared on agenda
                  -- 'warning'  → deadline in 7 days
                  -- 'critical' → deadline in 1 day or state regressed
  payload         jsonb not null,
                  -- Type-specific detail — see spec §3.
                  -- state_change: { from, to, comision, fecha }
                  -- deadline:     { tipo_plazo, articulo_ref, dias_restantes, fecha_vencimiento }
                  -- mention:      { session_id, segment_ids[], excerpt }
                  -- similar:      { similar_expediente_id, similarity_score, titulo }
                  -- agenda:       { fecha, comision, hora_inicio }
                  -- digest_weekly: { period_start, period_end, summary_text, model }
  detected_at     timestamptz not null default now(),
  read_at         timestamptz,
                  -- NULL = unread. Set by the user (or auto-read logic) via
                  -- the mark-as-read RPC or the direct UPDATE policy below.
  delivered_via   text[] default '{}'::text[],
                  -- Channels that have already received this alert.
                  -- Append-only by the engine. Never reset.
  dedup_key       text not null,
                  -- Deterministic content hash set by the engine.
                  -- Prevents N duplicate alerts if the cron double-fires
                  -- before the underlying data changes again.
  created_at      timestamptz not null default now(),
  constraint centinela_alerts_unique_per_user_dedup
    unique (user_id, dedup_key)
);

create index if not exists centinela_alerts_user_recent_idx
  on centinela_alerts (user_id, detected_at desc);
  -- Primary read path: /centinela page loads latest N alerts for the user.

create index if not exists centinela_alerts_unread_idx
  on centinela_alerts (user_id, read_at)
  where read_at is null;
  -- Partial index — only unread rows. Used by the badge counter query
  -- (SELECT count(*) WHERE user_id = $1 AND read_at IS NULL) and by
  -- notification delivery jobs that want only fresh alerts.

alter table centinela_alerts enable row level security;

drop policy if exists "centinela_alerts users read own rows" on centinela_alerts;
create policy "centinela_alerts users read own rows"
  on centinela_alerts for select
  using (auth.uid() = user_id);
  -- Users can only see their own alerts. The engine inserts with service_role
  -- which bypasses RLS, so no insert policy is needed for that path.

drop policy if exists "centinela_alerts deny authenticated insert" on centinela_alerts;
create policy "centinela_alerts deny authenticated insert"
  on centinela_alerts for insert
  with check (false);
  -- Explicit deny: frontend must never insert directly into this table.
  -- Only the alert engine (service_role key) should write alerts.
  -- This makes the intent self-documenting rather than relying on
  -- "no policy = blocked by default" which is harder to audit.

drop policy if exists "centinela_alerts users mark read" on centinela_alerts;
create policy "centinela_alerts users mark read"
  on centinela_alerts for update
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
  -- Users may update their own alert rows. In practice the frontend only
  -- touches read_at (mark as read / unread). If stricter column-level
  -- control is needed later, this can be replaced with a SECURITY DEFINER
  -- RPC function (mark_alert_read(alert_id uuid)) that sets only read_at.
  -- For MVP, full-row update by owner is acceptable.

comment on table centinela_alerts is
  'Alert rows generated by the Centinela engine. Engine writes via service_role; '
  'frontend is read-only except for setting read_at. '
  'dedup_key prevents duplicate alerts if the cron fires multiple times.';


-- ─── centinela_alert_prefs ──────────────────────────────────────────────────
-- One row per user. Controls which alert types are active, notification
-- channels, and deadline thresholds. Upserted by the settings page.
-- Primary key is user_id (one row per user, not one per setting).
--
-- alert_types_on: the user can disable specific alert types globally.
-- deadline_thresholds: days-before-deadline triggers (default [1, 3, 7]).
-- channels: where to deliver ('in_app', 'email', 'telegram', 'slack').
-- digest_enabled: weekly Opus summary (Pro tier gate enforced in the app layer).

create table if not exists centinela_alert_prefs (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  alert_types_on      text[] default array['state_change','deadline','mention','similar','agenda']::text[],
                      -- Subset of alert_type values from centinela_alerts.
                      -- Engine checks this before inserting an alert for the user.
  deadline_thresholds int[] default array[1, 3, 7]::int[],
                      -- Days-before-deadline to trigger deadline alerts.
                      -- [1, 3, 7] = alert at T-7, T-3, and T-1.
  channels            text[] default array['in_app']::text[],
                      -- Active delivery channels for this user.
  digest_enabled      bool default false,
                      -- Weekly Opus digest. Gated to Pro tier in app logic.
  digest_cadence      text default 'weekly'
                      check (digest_cadence in ('daily', 'weekly')),
  updated_at          timestamptz not null default now()
);

alter table centinela_alert_prefs enable row level security;

drop policy if exists "centinela_alert_prefs users read own row" on centinela_alert_prefs;
create policy "centinela_alert_prefs users read own row"
  on centinela_alert_prefs for select
  using (auth.uid() = user_id);

drop policy if exists "centinela_alert_prefs users insert own row" on centinela_alert_prefs;
create policy "centinela_alert_prefs users insert own row"
  on centinela_alert_prefs for insert
  with check (auth.uid() = user_id);

drop policy if exists "centinela_alert_prefs users update own row" on centinela_alert_prefs;
create policy "centinela_alert_prefs users update own row"
  on centinela_alert_prefs for update
  using (auth.uid() = user_id);

comment on table centinela_alert_prefs is
  'Per-user Centinela preferences. One row per user. Upserted by the '
  'settings/profile page. Engine reads this before fanout to skip '
  'alert types the user has turned off.';


-- =====================================================
-- SECTION 2 — CL2-specific domain tables
--             (legislative deadlines + agenda)
-- =====================================================

-- ─── expediente_plazos ──────────────────────────────────────────────────────
-- Cached deadline calculations for each tracked expediente.
-- Deadlines are SHARED — not per-user. They are derived from:
--   (a) the expediente's current state in sil_expedientes
--   (b) the matching rule in reglamento_plazos
-- and cached here so the alert engine doesn't recompute on every cron run.
--
-- dias_restantes is a GENERATED STORED column so it stays current with
-- current_date without needing a cron update. Postgres recomputes it
-- on every read.
--
-- expediente_id is int (not uuid) to match sil_expedientes.id. We use a
-- logical FK (comment-documented) rather than a hard FK so this table can
-- be populated by the scraper before the expediente row exists in Supabase
-- (the canonical expediente data lives in the MariaDB replica).
--
-- PRIMARY KEY (expediente_id, tipo_plazo): one plazo per type per expediente.
-- If the expediente transitions and the deadline resets, the engine does
-- an UPSERT (ON CONFLICT UPDATE fecha_inicio, fecha_vencimiento, calculado_en).

create table if not exists expediente_plazos (
  expediente_id        int not null,
                       -- Logical FK to sil_expedientes.id (MariaDB replica mirror).
                       -- Hard FK omitted intentionally: allows the deadline engine
                       -- to pre-populate before the Supabase mirror is updated.
  tipo_plazo           text not null,
                       -- 'dictamen_comision' | 'discusion_plenario' |
                       -- 'consulta_publica' | etc.
                       -- Matches reglamento_plazos.tipo_plazo.
  articulo_ref         text not null,
                       -- 'Art. 81' — snapshot from reglamento_plazos at
                       -- calculation time. Stored here so the UI can cite
                       -- the legal basis without joining.
  fecha_inicio         date not null,
                       -- The event that started the clock (e.g. date the
                       -- expediente was assigned to comision).
  fecha_vencimiento    date not null,
                       -- fecha_inicio + dias_habiles (business days),
                       -- computed by the engine using the Costa Rica calendar.
  dias_restantes       int generated always as (
                         (fecha_vencimiento - current_date)::int
                       ) stored,
                       -- Auto-updated by Postgres on every read — no cron needed.
                       -- Negative = past due. The alert engine filters WHERE
                       -- dias_restantes = ANY(user_prefs.deadline_thresholds).
  calculado_en         timestamptz not null default now(),
                       -- When this row was last computed by the engine.
                       -- Used for cache invalidation: if calculado_en > 24h
                       -- and expediente state hasn't changed, skip recompute.
  primary key (expediente_id, tipo_plazo)
);

create index if not exists expediente_plazos_dias_idx
  on expediente_plazos (dias_restantes)
  where dias_restantes >= 0;
  -- Partial index on non-past deadlines.
  -- Alert engine query: SELECT ... WHERE dias_restantes = ANY($thresholds)
  -- Only future/today deadlines are alertable; negatives are ignored.

alter table expediente_plazos enable row level security;

drop policy if exists "expediente_plazos authenticated read" on expediente_plazos;
create policy "expediente_plazos authenticated read"
  on expediente_plazos for select
  using (auth.role() = 'authenticated');
  -- Deadline data is public legislative record. Any logged-in user can read.

drop policy if exists "expediente_plazos deny authenticated write" on expediente_plazos;
create policy "expediente_plazos deny authenticated write"
  on expediente_plazos for insert
  with check (false);
  -- Only the deadline engine (service_role) inserts/updates.

drop policy if exists "expediente_plazos deny authenticated update" on expediente_plazos;
create policy "expediente_plazos deny authenticated update"
  on expediente_plazos for update
  using (false);

comment on table expediente_plazos is
  'Cached Reglamento deadline calculations per expediente. Shared, not per-user. '
  'dias_restantes is a generated column that stays fresh without cron updates. '
  'Engine upserts when expediente state changes.';


-- ─── reglamento_plazos ──────────────────────────────────────────────────────
-- Hardcoded rules from the Reglamento de la Asamblea Legislativa.
-- MVP covers ~5-7 most common deadline types. In the roadmap, a parser
-- can auto-populate this from the Reglamento PDF, but for now human-curated
-- rules are safer and more auditable.
--
-- tipo_plazo is UNIQUE — there is one canonical rule per deadline type.
-- The engine uses estado_disparador to know which sil_expediente state
-- activates the clock, and dias_habiles for the calculation.

create table if not exists reglamento_plazos (
  id                  uuid primary key default gen_random_uuid(),
  tipo_plazo          text not null,
                      -- Human-readable slug: 'dictamen_comision',
                      -- 'discusion_plenario', 'consulta_publica', etc.
                      -- Joins with expediente_plazos.tipo_plazo.
  articulo_ref        text not null,
                      -- 'Art. 81', 'Art. 115', etc. Cited in alert payloads.
  estado_disparador   text not null,
                      -- The sil_expedientes.estado value that starts the clock.
                      -- e.g. 'en_comision', 'aprobado_primer_debate'.
  dias_habiles        int not null,
                      -- Business days (Costa Rica calendar) from fecha_inicio.
                      -- The engine converts to calendar days using a holiday table.
  descripcion         text,
                      -- Human-readable explanation for the admin UI.
  activo              bool default true,
                      -- Soft-disable a rule without deleting it (e.g. if the
                      -- Asamblea suspends a specific deadline during recess).
  constraint reglamento_plazos_tipo_unique unique (tipo_plazo)
);

alter table reglamento_plazos enable row level security;

drop policy if exists "reglamento_plazos authenticated read" on reglamento_plazos;
create policy "reglamento_plazos authenticated read"
  on reglamento_plazos for select
  using (auth.role() = 'authenticated');
  -- Reglamento rules are public reference data.

drop policy if exists "reglamento_plazos deny authenticated write" on reglamento_plazos;
create policy "reglamento_plazos deny authenticated write"
  on reglamento_plazos for insert
  with check (false);

drop policy if exists "reglamento_plazos deny authenticated update" on reglamento_plazos;
create policy "reglamento_plazos deny authenticated update"
  on reglamento_plazos for update
  using (false);

comment on table reglamento_plazos is
  'Curated deadline rules from the Reglamento de la Asamblea Legislativa. '
  'MVP: ~7 rules. Roadmap: replace with auto-parser. '
  'Engine reads this to compute expediente_plazos.';

-- Seed the initial Reglamento rules (safe to re-run — ON CONFLICT DO NOTHING)
insert into reglamento_plazos (tipo_plazo, articulo_ref, estado_disparador, dias_habiles, descripcion) values
  ('dictamen_comision',        'Art. 81',  'en_comision',              22, 'Plazo máximo para que la comisión emita dictamen desde asignación'),
  ('discusion_plenario',       'Art. 115', 'aprobado_primer_debate',   30, 'Plazo para discusión en plenario después del primer debate'),
  ('consulta_publica',         'Art. 157', 'en_consulta_publica',      15, 'Plazo de consulta pública obligatoria antes de dictamen'),
  ('audiencias_comision',      'Art. 88',  'en_comision',              10, 'Plazo para celebrar audiencias desde convocatoria'),
  ('respuesta_poder_ejecutivo','Art. 194', 'enviado_ejecutivo',        30, 'Plazo del Poder Ejecutivo para responder a la Asamblea'),
  ('sancion_promulgacion',     'Art. 124', 'aprobado_segundo_debate',  20, 'Plazo del ejecutivo para sancionar/vetar ley aprobada'),
  ('recurso_amparo_comision',  'Art. 102', 'recurso_planteado',         8, 'Plazo de comisión para resolver recurso de amparo interno')
on conflict (tipo_plazo) do nothing;


-- ─── agenda_legislativa ─────────────────────────────────────────────────────
-- Order-of-business rows scraped from the Asamblea's SharePoint/portal.
-- Shared table — not per-user. The Centinela engine queries this to
-- generate 'agenda' type alerts for each user's watchlist entries.
--
-- expediente_id is nullable: not every agenda item is an expediente
-- (e.g. "Presentación del Informe del Defensor del Pueblo").
-- expediente_numero stores the human-readable snapshot ('24.429') so the
-- UI can render without joining to sil_expedientes.
--
-- UNIQUE (fecha, comision, titulo): deduplicates repeated scrapes.
-- The scraper should use INSERT ... ON CONFLICT DO NOTHING.

create table if not exists agenda_legislativa (
  id                  uuid primary key default gen_random_uuid(),
  fecha               date not null,
  comision            text,
                      -- NULL = plenario (full chamber). Named comision otherwise.
  expediente_id       int,
                      -- Nullable logical FK to sil_expedientes.id.
  expediente_numero   text,
                      -- Human-readable snapshot: '24.429'. Stored to avoid
                      -- a join on every alert payload render.
  titulo              text not null,
  hora_inicio         time,
                      -- Nullable: some agenda items don't have a fixed time.
  scraped_at          timestamptz not null default now(),
  constraint agenda_legislativa_unique_item
    unique (fecha, comision, titulo)
);

create index if not exists agenda_fecha_idx
  on agenda_legislativa (fecha desc);
  -- Primary query: "what's on the agenda for fecha X and the next N days?"
  -- The alert engine runs this query nightly to find watchlist matches.

alter table agenda_legislativa enable row level security;

drop policy if exists "agenda_legislativa authenticated read" on agenda_legislativa;
create policy "agenda_legislativa authenticated read"
  on agenda_legislativa for select
  using (auth.role() = 'authenticated');

drop policy if exists "agenda_legislativa deny authenticated write" on agenda_legislativa;
create policy "agenda_legislativa deny authenticated write"
  on agenda_legislativa for insert
  with check (false);
  -- Only the agenda scraper job (service_role) inserts.

drop policy if exists "agenda_legislativa deny authenticated update" on agenda_legislativa;
create policy "agenda_legislativa deny authenticated update"
  on agenda_legislativa for update
  using (false);

comment on table agenda_legislativa is
  'Scraped order-of-business from the Asamblea Legislativa portal. Shared. '
  'Centinela engine queries this nightly to generate agenda alerts for watchers. '
  'Scraper uses ON CONFLICT DO NOTHING on the (fecha, comision, titulo) unique key.';


-- =====================================================
-- SECTION 3 — Migration from legacy expedientes_watchlist
-- =====================================================
-- The 0010_admin_console.sql migration created expedientes_watchlist with
-- a simple (user_id, expediente_id bigint) composite PK. That table is now
-- superseded by the entity-agnostic centinela_watchlist.
--
-- Migration strategy:
--   - Copy all rows into centinela_watchlist with entity_type='expediente',
--     entity_id = expediente_id::text, source='migrated_from_legacy'.
--   - ON CONFLICT DO NOTHING makes this idempotent: safe to re-run if the
--     migration is applied more than once (e.g. during staging resets).
--   - Drop the old table after migration.
--
-- NOTE: expediente_id in the old table is bigint (FK to sil_expedientes.id).
-- centinela_watchlist.entity_id is text — the cast is safe and reversible.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'expedientes_watchlist'
  ) then

    insert into centinela_watchlist
      (user_id, entity_type, entity_id, source, metadata)
    select
      user_id,
      'expediente',
      expediente_id::text,
      'migrated_from_legacy',
      '{}'::jsonb
    from expedientes_watchlist
    on conflict (user_id, entity_type, entity_id, source) do nothing;

    drop table if exists expedientes_watchlist;

  end if;
end $$;

-- If the old table doesn't exist (fresh environment / already migrated),
-- the DO block is a no-op. No error, no side effects.
