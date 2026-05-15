-- 0031a_sil_expedientes_numero_unique.sql
--
-- Fix de prerequisito para 0032 y 0034 (Sprint 1 v3, 2026-05-15).
--
-- Las migrations 0032 (biblioteca expediente) y 0034 (decretos ejecutivos)
-- crean tablas con FOREIGN KEY a `sil_expedientes(numero)`:
--
--   expediente_id text not null references sil_expedientes(numero) on delete cascade
--
-- Pero el schema original de `sil_expedientes` (migration 0005, sept 2025)
-- declara `numero text not null` sin UNIQUE constraint — solo un index normal.
-- Postgres rechaza el FK con error 42830 porque exige que la columna
-- referenciada sea PRIMARY KEY o UNIQUE.
--
-- Esta migration agrega la constraint UNIQUE de forma idempotente
-- (vía DO block que verifica si ya existe). Si hay duplicados en `numero`,
-- la creación falla con mensaje claro y NO se aplica — habría que limpiar
-- duplicados primero.
--
-- Decisión de diseño: agregamos UNIQUE a `numero` (mantener `id` como PK
-- numérica interna). Razón: `numero` ES la identidad pública del expediente
-- ("22.293"), usada por el frontend en routes (/expediente/22.293),
-- por el crawler para buscar, y por todos los reports. Que sea UNIQUE
-- formaliza una invariante que ya se cumplía en la práctica.
--
-- Aplicar ANTES de 0032.

do $$
begin
  -- Pre-check: avisar si hay duplicados antes de intentar agregar la constraint.
  -- Si los hay, falla con mensaje útil.
  if exists (
    select numero, count(*)
    from sil_expedientes
    where numero is not null
    group by numero
    having count(*) > 1
    limit 1
  ) then
    raise exception 'sil_expedientes tiene valores duplicados en columna numero. Limpiar antes de aplicar UNIQUE constraint. Query: select numero, count(*) from sil_expedientes group by numero having count(*) > 1';
  end if;

  -- Idempotencia: solo agregar la constraint si aún no existe.
  if not exists (
    select 1 from pg_constraint
    where conname = 'sil_expedientes_numero_unique'
      and conrelid = 'sil_expedientes'::regclass
  ) then
    alter table sil_expedientes
      add constraint sil_expedientes_numero_unique unique (numero);
    raise notice 'Constraint sil_expedientes_numero_unique creada.';
  else
    raise notice 'Constraint sil_expedientes_numero_unique ya existía. No-op.';
  end if;
end $$;
