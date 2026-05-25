-- Migration 0049: centinela_listas + keyword watchlist support
-- ============================================================================
-- 2026-05-25 — Listas de vigilancia por usuario
--
-- Antes: cada user tenía un solo `centinela_watchlist` plano. Si vigilaba
-- "PANI" y "Recurso Hídrico" para distintos clientes, todo entraba al mismo
-- bucket. No había forma de separar.
--
-- Ahora: un user puede tener N listas. Cada lista agrupa watches. Una lista
-- típica de un consultor de asuntos públicos es por cliente ("Empresa X")
-- o por sector ("Energía", "Salud", "Banca").
--
-- Compatibilidad backwards: los watches existentes quedan con lista_id=null
-- (legacy/sin lista). El matcher los sigue procesando.
--
-- Schema:
--   centinela_listas:
--     id           uuid PK
--     user_id      uuid FK -> auth.users (cascade delete)
--     nombre       text NOT NULL
--     descripcion  text default ''
--     color        text default 'default'  -- 'default' | 'burgundy' | 'ink' | 'sage' | 'amber'
--     archivada    boolean default false
--     orden        int default 0           -- para ordenar en UI
--     created_at   timestamptz
--     updated_at   timestamptz
--
--   centinela_watchlist:
--     + lista_id  uuid FK -> centinela_listas (set null delete)
-- ============================================================================

-- Tabla nueva
create table if not exists centinela_listas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  nombre      text not null,
  descripcion text not null default '',
  color       text not null default 'default'
               check (color in ('default','burgundy','ink','sage','amber','cream')),
  archivada   boolean not null default false,
  orden       int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Un user no puede tener dos listas con el mismo nombre (case insensitive)
create unique index if not exists centinela_listas_user_nombre_unique
  on centinela_listas (user_id, lower(nombre))
  where archivada = false;

-- Index para listar las listas de un user rápido
create index if not exists centinela_listas_user_idx
  on centinela_listas (user_id, archivada, orden);

-- Trigger updated_at
create or replace function _centinela_listas_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_centinela_listas_updated_at on centinela_listas;
create trigger trg_centinela_listas_updated_at
  before update on centinela_listas
  for each row execute function _centinela_listas_set_updated_at();

-- ── Agregar lista_id a centinela_watchlist ─────────────────────────────────
alter table centinela_watchlist
  add column if not exists lista_id uuid references centinela_listas(id) on delete set null;

create index if not exists centinela_watchlist_lista_idx
  on centinela_watchlist (lista_id) where lista_id is not null;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table centinela_listas enable row level security;

drop policy if exists centinela_listas_owner_all on centinela_listas;
create policy centinela_listas_owner_all
  on centinela_listas
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- service_role bypass (los jobs/crons)
grant all on centinela_listas to service_role;

-- ── Backfill: crear lista "General" para users con watches existentes ─────
-- Cualquier user que ya tenga watches en centinela_watchlist recibe una
-- lista "General" y todos sus watches sin lista quedan asignados a ella.
do $backfill$
declare
  u record;
  lista_id_new uuid;
begin
  for u in select distinct user_id from centinela_watchlist where lista_id is null
  loop
    -- ¿Ya tiene una lista General?
    select id into lista_id_new
    from centinela_listas
    where user_id = u.user_id and lower(nombre) = 'general'
    limit 1;

    if lista_id_new is null then
      insert into centinela_listas (user_id, nombre, descripcion, color, orden)
      values (u.user_id, 'General', 'Watchlist por defecto', 'default', 0)
      returning id into lista_id_new;
    end if;

    update centinela_watchlist
    set lista_id = lista_id_new
    where user_id = u.user_id and lista_id is null;
  end loop;
end;
$backfill$;
