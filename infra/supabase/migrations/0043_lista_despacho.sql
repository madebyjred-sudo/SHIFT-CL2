-- 0043_lista_despacho.sql
--
-- Sprint 3 Track R — Lista de despacho como entidad de primera clase.
--
-- Cliente: Donovan 38:17 sesión 14-may:
--   "si vos le pidieras un proyecto puesto a despacho, aunque esté
--    desactualizado en la Asamblea, que tenga la capacidad de hacerlo."
--
-- "Lista de despacho" = expedientes que la asesoría legal puso "a despacho"
-- para que el Presidente de la Asamblea (o el plenario) decida si los recibe.
-- Hoy NO existe como entidad. El consultor tiene que ir al SIL a chequear
-- cada expediente uno por uno para saber si está "a despacho".
--
-- Esta migración crea `lista_despacho_items`: una entrada por evento de
-- ingreso/salida a la lista. El historial completo queda persistido —
-- un expediente puede entrar, salir, volver a entrar, etc.
--
-- INVARIANTES:
--   * Idempotencia: UNIQUE (expediente_id, fecha_entrada). Re-correr el
--     crawler NO duplica items.
--   * FK con cascade: si se borra el expediente del SIL, se borran los
--     items asociados (lo cual no debería pasar nunca pero queda
--     consistente con 0037/0038).
--   * status canónico cerrado vía CHECK: agregar status nuevos requiere
--     migration explícita (no string libre).
--   * RLS idempotente: drop policy if exists antes de create.
--
-- INDEXES:
--   1. (expediente_id, fecha_entrada desc) — query principal por expediente.
--   2. (status, fecha_entrada desc) WHERE status='a_despacho' — barrido
--      global de "qué está activamente a despacho ahora mismo".
--      NO se usa current_date en el predicate del index — current_date
--      no es IMMUTABLE en PostgreSQL y rompe la creación (mismo bug que
--      0038 resolvió).
--
-- Source: AGENTS/CL2/sprints/2026-05-16-sprint-2-3-design-doc.md Track R.

create table if not exists lista_despacho_items (
  id                  uuid primary key default gen_random_uuid(),
  expediente_id       text not null references sil_expedientes(numero) on delete cascade,
  fecha_entrada       date not null,                  -- cuándo entró a despacho
  fecha_salida        date,                            -- null si todavía está a despacho
  status              text not null check (status in (
    'a_despacho',           -- está esperando decisión del Presidente / plenario
    'devuelto_a_comision',  -- el Presidente lo devolvió a la comisión de origen
    'remitido_plenario',    -- pasó a plenario para discusión
    'archivado',            -- el Presidente lo archivó
    'caduca_cuatrienal'     -- venció su plazo de 4 años en despacho
  )),
  fuente_pdf_url      text,                            -- PDF de la decisión si aplica
  comentario_diputado text,                            -- texto libre del consultor o anotación oficial
  raw                 jsonb,                           -- payload original del scrape (si fue automático)
  detectado_at        timestamptz not null default now(),
  unique (expediente_id, fecha_entrada)
);

-- Index principal: query por expediente (historial completo, más reciente primero).
create index if not exists lista_despacho_expediente_idx
  on lista_despacho_items (expediente_id, fecha_entrada desc);

-- Index secundario: barrido global de items actualmente "a despacho".
-- Partial index sobre status='a_despacho' para minimizar tamaño (la mayoría
-- de filas históricas estarán en otros status). NO usamos current_date en
-- el predicate — PostgreSQL exige funciones IMMUTABLE para predicates de
-- index y current_date no lo es (mismo motivo que sil_audiencias_fecha_idx
-- en 0038).
create index if not exists lista_despacho_activos_idx
  on lista_despacho_items (status, fecha_entrada desc)
  where status = 'a_despacho';

-- ─── RLS idempotente ────────────────────────────────────────────────────────

alter table lista_despacho_items enable row level security;

drop policy if exists "read despacho" on lista_despacho_items;
drop policy if exists "service writes despacho" on lista_despacho_items;

create policy "read despacho" on lista_despacho_items
  for select to authenticated using (true);

create policy "service writes despacho" on lista_despacho_items
  for all to authenticated using (auth.role() = 'service_role');

-- ─── Comentarios para discoverability ───────────────────────────────────────

comment on table lista_despacho_items is
  'Lista de despacho de la Asamblea Legislativa CR. Una fila por evento de '
  'entrada/salida del expediente a la lista. El historial se preserva — un '
  'expediente puede entrar a despacho, ser devuelto a comisión, y volver a '
  'entrar. Sprint 3 Track R, pedido Donovan 38:17 sesión 14-may.';

comment on column lista_despacho_items.status is
  'a_despacho: esperando decisión. devuelto_a_comision: regresó a comisión. '
  'remitido_plenario: pasó a plenario. archivado: el Presidente lo archivó. '
  'caduca_cuatrienal: venció plazo de 4 años.';

comment on column lista_despacho_items.fecha_salida is
  'Null si status=a_despacho (todavía está). Se completa cuando cambia de '
  'estado a cualquier otro valor.';

-- ─── Centinela: ampliar CHECK constraint de event_type ──────────────────────
--
-- Track R agrega 2 tipos nuevos al pipeline de Centinela:
--   * entro_lista_despacho  → priority=high   (watched exp entró a despacho)
--   * salio_lista_despacho  → priority=medium (watched exp salió de despacho)
--
-- 0039 ya extendió el CHECK con los 4 tipos de novedades (Track I). Ahora
-- repetimos el patrón: drop + re-add con el set ampliado. Idempotente con
-- `drop constraint if exists`.

alter table centinela_eventos
  drop constraint if exists centinela_eventos_event_type_check;

alter table centinela_eventos
  add constraint centinela_eventos_event_type_check
  check (event_type in (
    -- Legacy (0033)
    'orden_dia_publicada',
    'cambio_estado',
    'mocion_fondo_presentada',
    'audiencia_confirmada',
    'resolucion_sala_constitucional',
    'ley_publicada',
    'decreto_convocatoria',
    'fecha_dictamen_proxima',
    'plazo_cuatrienal_proximo',
    'desviacion_procedimental',
    -- Track I (Sprint 2 — noveltyDetector)
    'mocion_137_no_reflejada_en_tramite',
    'consulta_177_no_reflejada_en_tramite',
    'acta_sin_evento_tramite',
    'mocion_segundo_dia_sin_primer_dia',
    -- Sprint 3 Track R — Lista de despacho
    'entro_lista_despacho',
    'salio_lista_despacho'
  ));
