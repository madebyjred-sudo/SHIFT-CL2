-- shift-cl2 — Clientes de cada consultor (folder-per-client memory).
--
-- CONTEXT (Jred 2026-05-11):
--   CL2 Consultoría no son legisladores; son consultores que asesoran a
--   N clientes. Un usuario puede tener 2-N clientes con intereses
--   posiblemente opuestos. Cada cliente es una unidad operativa con su
--   propia watchlist y, en el futuro, su propio canal de delivery
--   (WhatsApp / email) para alertas directas.
--
--   El modelo se refleja en dos planos:
--     - Plano relacional (este file): `cl2_clients` para joins, RLS,
--       referencias desde centinela_watchlist y alertas.
--     - Plano de memoria (Cerebro neuron): /memories/clientes/<slug>.md
--       Sync via BFF al crear/editar/borrar. La memoria es el contexto
--       que los agentes leen; la tabla es la fuente de verdad para
--       routing y queries agregadas.
--
-- IDEMPOTENT.

-- ─── 1. Tabla principal ───────────────────────────────────────────────
create table if not exists cl2_clients (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
                -- El consultor dueño del cliente. RLS scope key.
  slug          text not null,
                -- URL/path friendly, único por user. Se genera del label
                -- en el BFF (slugifySegment). Usado en /memories/clientes/<slug>.md.
  label         text not null,
                -- Display name humano. Editable. Ej: "Acme S.A.", "Garnier & Asoc."
  description   text default '',
                -- Brief libre. Llena el wizard onboarding (paste-from-LLM)
                -- o edición manual desde /mi-memoria. Se replica a la
                -- neurona como /memories/clientes/<slug>.md.
  sector        text,
                -- Etiqueta libre de sector económico/práctica. Ayuda
                -- a Centinela a sugerir watchlist. Ej: 'fintech',
                -- 'infraestructura', 'salud', 'fiscal', 'energía'.
  contact_email text,
                -- Futuro: routing de alertas directas. Hoy informativo.
  contact_whatsapp text,
                -- Futuro: idem. Formato libre, normalización en delivery.
  archived      boolean not null default false,
                -- Soft-delete. Los clientes archivados no aparecen en
                -- el sidebar pero sus watchlists históricos preservados.
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cl2_clients_unique_slug_per_user unique (user_id, slug)
);

create index if not exists cl2_clients_user_idx
  on cl2_clients (user_id, archived, created_at desc);
  -- Patrón principal: "dame los clientes activos de este consultor"

-- ─── 2. Vincular watchlist a un cliente (opcional, retro-compatible) ──
-- centinela_watchlist gana una columna client_id NULLABLE. Una entry sin
-- client_id es watchlist "general del consultor" (legacy / hoy). Una con
-- client_id es watchlist específica de un cliente. Cuando aterricen las
-- alertas directas al cliente, el client_id es el routing key.
alter table centinela_watchlist
  add column if not exists client_id uuid references cl2_clients(id) on delete cascade;

create index if not exists centinela_watchlist_client_idx
  on centinela_watchlist (client_id)
  where client_id is not null;

-- Nuevo unique constraint que incluye client_id — el mismo expediente
-- puede estar en watchlist sin cliente Y en watchlist de Cliente A Y
-- en watchlist de Cliente B simultáneamente (intereses opuestos
-- legítimos). Reemplazamos la unique vieja.
alter table centinela_watchlist
  drop constraint if exists centinela_watchlist_unique_subscription;

alter table centinela_watchlist
  add constraint centinela_watchlist_unique_subscription
  unique nulls not distinct (user_id, entity_type, entity_id, source, client_id);
  -- `nulls not distinct` (Postgres 15+) trata NULL == NULL para el unique,
  -- así que entries sin client_id también se previenen duplicadas.

-- ─── 3. RLS ───────────────────────────────────────────────────────────
alter table cl2_clients enable row level security;

drop policy if exists "cl2_clients users read own rows" on cl2_clients;
create policy "cl2_clients users read own rows"
  on cl2_clients for select
  using (auth.uid() = user_id);

drop policy if exists "cl2_clients users insert own rows" on cl2_clients;
create policy "cl2_clients users insert own rows"
  on cl2_clients for insert
  with check (auth.uid() = user_id);

drop policy if exists "cl2_clients users update own rows" on cl2_clients;
create policy "cl2_clients users update own rows"
  on cl2_clients for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "cl2_clients users delete own rows" on cl2_clients;
create policy "cl2_clients users delete own rows"
  on cl2_clients for delete
  using (auth.uid() = user_id);

-- ─── 4. updated_at trigger ────────────────────────────────────────────
create or replace function set_cl2_clients_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cl2_clients_updated_at on cl2_clients;
create trigger cl2_clients_updated_at
  before update on cl2_clients
  for each row execute function set_cl2_clients_updated_at();

-- ─── Comments ─────────────────────────────────────────────────────────
comment on table cl2_clients is
  'Clientes que cada consultor de CL2 asesora. Un usuario tiene 1-N '
  'clientes; cada cliente se materializa también como un archivo de '
  'memoria en Cerebro neuron (/memories/clientes/<slug>.md). Watchlists '
  'de Centinela pueden estar scopeadas a un cliente (centinela_watchlist.client_id).';

comment on column centinela_watchlist.client_id is
  'Si no NULL, esta watchlist es específica de un cliente del consultor. '
  'Permite que un consultor vigile el mismo expediente para clientes con '
  'intereses opuestos sin duplicar entradas confusas. Futuro: routing de '
  'alertas directas al cliente via WhatsApp/email.';
