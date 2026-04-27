-- shift-cl2 — Workspace "Hojas" (Phase 0).
--
-- Production surface so users can CREATE work (not just consume).
-- Two tables for the canvas model + citations carry-over:
--
--   1. workspaces        — canvas container. One per "proyecto de análisis".
--                          Archived flag for soft-delete; hard delete cascades.
--   2. workspace_nodes   — individual "hojas" (pages) positioned on the canvas.
--                          type=hoja is the primary type; note/expediente_ref
--                          reserved for Phase 1. content JSONB starts as
--                          {md:"..."} for MVP — opaque shape so TipTap JSON
--                          swap lands with zero migration cost.
--   3. workspace_citations — chunks saved from chat or SIL browse, optionally
--                          pinned to a specific node. No FK on chunk_id (allows
--                          future non-corpus citations).
--
-- RLS: owner-only for all three tables. Share tokens = Phase 1.

-- ─── workspaces ──────────────────────────────────────────────────────
create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Mi espacio',
  description text not null default '',
  archived    bool not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists workspaces_user_idx
  on workspaces (user_id, updated_at desc);

-- ─── workspace_nodes ─────────────────────────────────────────────────
create table if not exists workspace_nodes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type         text not null default 'hoja'
               check (type in ('hoja', 'note', 'cite', 'expediente_ref')),
  -- Canvas position (ReactFlow coordinates)
  x            float not null default 0,
  y            float not null default 0,
  width        float not null default 640,
  height       float not null default 420,
  z_index      int  not null default 0,
  -- Content
  title        text not null default 'Sin título',
  subtitle     text not null default '',
  content      jsonb not null default '{}'::jsonb,
  -- Visual theme
  color        text not null default 'default'
               check (color in ('default','burgundy','ink','sage','amber')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists workspace_nodes_ws_idx
  on workspace_nodes (workspace_id, created_at asc);

-- ─── workspace_citations ─────────────────────────────────────────────
create table if not exists workspace_citations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Optional pin to a specific node (null = inbox / unattached)
  node_id       uuid references workspace_nodes(id) on delete set null,
  chunk_id      uuid not null,       -- legislative_chunks.id — no FK intentional
  source_label  text,                -- "Exp. 23.456" denormalized
  excerpt       text,                -- snippet for fast render
  note          text,                -- user annotation
  created_at    timestamptz not null default now()
);
create index if not exists workspace_citations_user_idx
  on workspace_citations (user_id, created_at desc);
create unique index if not exists workspace_citations_dedup
  on workspace_citations (user_id, chunk_id);

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table workspaces enable row level security;
drop policy if exists "ws_owner" on workspaces;
create policy "ws_owner" on workspaces
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table workspace_nodes enable row level security;
drop policy if exists "wsn_owner" on workspace_nodes;
create policy "wsn_owner" on workspace_nodes
  for all using (
    auth.uid() = (select user_id from workspaces where id = workspace_id)
  )
  with check (
    auth.uid() = (select user_id from workspaces where id = workspace_id)
  );

alter table workspace_citations enable row level security;
drop policy if exists "wsc_owner" on workspace_citations;
create policy "wsc_owner" on workspace_citations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── updated_at triggers ─────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists ws_touch on workspaces;
create trigger ws_touch before update on workspaces
  for each row execute function touch_updated_at();

drop trigger if exists wsn_touch on workspace_nodes;
create trigger wsn_touch before update on workspace_nodes
  for each row execute function touch_updated_at();
