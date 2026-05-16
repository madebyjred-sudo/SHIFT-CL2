-- 0025_user_access_gate.sql
--
-- Gate de aprobación de usuarios — cualquier persona que entra a CL2 con
-- Google se registra automáticamente en auth.users (Supabase), pero no
-- puede usar la app hasta que un admin de CL2 Consultoría apruebe su
-- acceso desde /admin/usuarios. Hasta entonces ven la pantalla "Acceso
-- pendiente de aprobación".
--
-- Diseño:
--   • `user_access` mantiene status (pending|active|rejected|suspended) +
--     role (lector|editor|operador|admin). Status y role están separados:
--     el status decide si entrá; el role decide qué puede hacer una vez
--     dentro. Cambios de role no requieren re-aprobación.
--   • Trigger en auth.users INSERT: crea row 'pending' automático. El
--     email/avatar quedan denormalizados acá para que el admin vea la
--     lista sin tener que tocar el schema 'auth'.
--   • Bootstrap: madebyjred@gmail.com queda como admin activo desde la
--     migration. Cualquier email @cl2consultoria.com (Ronald + equipo) se
--     auto-aprueba como 'lector' al entrar — el admin puede cambiar role
--     después.

-- ── Tabla principal ──────────────────────────────────────────────────
create table if not exists user_access (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  status      text not null default 'pending'
              check (status in ('pending','active','rejected','suspended')),
  role        text default null
              check (role is null or role in ('lector','editor','operador','admin')),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  last_seen_at timestamptz,
  notes       text
);

create index if not exists user_access_status_idx on user_access (status);
create index if not exists user_access_email_idx on user_access (email);

-- ── RLS ─────────────────────────────────────────────────────────────
-- El BFF lee/escribe con service_role (bypass RLS). Habilitamos RLS para
-- prevenir lecturas directas desde el cliente — un user nunca debería
-- pedir esta tabla salvo a través del BFF que valida quién pregunta.
alter table user_access enable row level security;

-- Política mínima: cada user puede ver SU PROPIO row (para que el
-- frontend chequee su propio status sin tener que ir al BFF). Nadie
-- puede ver rows ajenos vía el cliente.
drop policy if exists user_access_select_own on user_access;
create policy user_access_select_own on user_access
  for select using (auth.uid() = user_id);

-- ── Bootstrap: dominios + emails auto-aprobados ──────────────────────
-- madebyjred@gmail.com es el admin inicial. Cualquier @cl2consultoria.com
-- entra como lector. Resto: pending.
create or replace function _user_access_decide_status(p_email text)
returns table (status text, role text) language plpgsql immutable as $$
begin
  -- Admin bootstrap — Jred
  if p_email = 'madebyjred@gmail.com' then
    return query select 'active'::text, 'admin'::text;
    return;
  end if;
  -- Dominio CL2 Consultoría — equipo del cliente
  if p_email like '%@cl2consultoria.com' then
    return query select 'active'::text, 'lector'::text;
    return;
  end if;
  -- Dominio shift — equipo interno
  if p_email like '%@shiftlabdev.space' or p_email like '%@shiftlab%' then
    return query select 'active'::text, 'lector'::text;
    return;
  end if;
  -- Default: pending, sin role hasta aprobación
  return query select 'pending'::text, null::text;
end;
$$;

-- ── Trigger en auth.users INSERT ─────────────────────────────────────
-- Cuando Supabase crea un row nuevo en auth.users (sign-in con Google
-- por primera vez), automáticamente populamos user_access. El status
-- inicial depende del email (ver _user_access_decide_status).
create or replace function _user_access_handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  v_status text;
  v_role text;
  v_email text;
  v_full_name text;
  v_avatar_url text;
begin
  v_email := lower(coalesce(new.email, ''));
  v_full_name := coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    null
  );
  v_avatar_url := coalesce(
    new.raw_user_meta_data->>'avatar_url',
    new.raw_user_meta_data->>'picture',
    null
  );

  select s.status, s.role into v_status, v_role
    from _user_access_decide_status(v_email) s;

  insert into user_access (user_id, email, full_name, avatar_url, status, role, approved_at)
  values (new.id, v_email, v_full_name, v_avatar_url, v_status, v_role,
          case when v_status = 'active' then now() else null end)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_user_access on auth.users;
create trigger on_auth_user_created_user_access
  after insert on auth.users
  for each row execute function _user_access_handle_new_user();

-- ── Trigger en auth.users UPDATE (metadata refresh) ──────────────────
-- Si el user actualiza su avatar/nombre (Google profile sync), copiamos
-- a user_access para que el admin vea data fresca sin tener que hacer
-- JOIN con auth.users.
create or replace function _user_access_handle_user_update()
returns trigger language plpgsql security definer as $$
begin
  update user_access set
    email = lower(coalesce(new.email, email)),
    full_name = coalesce(new.raw_user_meta_data->>'full_name',
                         new.raw_user_meta_data->>'name',
                         full_name),
    avatar_url = coalesce(new.raw_user_meta_data->>'avatar_url',
                          new.raw_user_meta_data->>'picture',
                          avatar_url)
    where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated_user_access on auth.users;
create trigger on_auth_user_updated_user_access
  after update on auth.users
  for each row execute function _user_access_handle_user_update();

-- ── Backfill: meter en user_access los users que ya existían ─────────
-- Si esta migration corre sobre una DB con users pre-existentes en
-- auth.users, los incluimos con el mismo criterio de auto-aprobación.
insert into user_access (user_id, email, full_name, avatar_url, status, role, approved_at)
select
  u.id,
  lower(coalesce(u.email, '')),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'),
  s.status,
  s.role,
  case when s.status = 'active' then now() else null end
from auth.users u
cross join lateral _user_access_decide_status(lower(coalesce(u.email, ''))) s
on conflict (user_id) do nothing;

-- ── Updated_at trigger ───────────────────────────────────────────────
-- Para que el admin sepa cuándo fue la última edición del row.
alter table user_access add column if not exists updated_at timestamptz not null default now();

create or replace function _user_access_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_access_touch_updated_at on user_access;
create trigger user_access_touch_updated_at
  before update on user_access
  for each row execute function _user_access_touch_updated_at();
