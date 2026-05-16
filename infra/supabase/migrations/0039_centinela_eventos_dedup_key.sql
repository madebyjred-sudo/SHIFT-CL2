-- 0039_centinela_eventos_dedup_key.sql
--
-- Sprint 2 Track I — persistencia de novedades algorítmicas en centinela_eventos.
--
-- Hasta ahora `noveltyDetector.ts` (servicio LLM-free que cruza
-- sil_sharepoint_raw vs sil_expediente_tramite) corría EN VIVO dentro del
-- endpoint /api/expedientes/:numero/full. Eso significa que:
--
--   (a) si nadie visita el expediente, las novedades no se generan;
--   (b) no hay historial — el algoritmo no sabe si ya alertó antes;
--   (c) cada /full request paga ~200ms de cross-check.
--
-- Solución: cron 30 min que itera por watchlist activa y persiste novedades
-- a `centinela_eventos`. El endpoint /full pasa a leer de la tabla y el
-- detector live queda como fallback de compatibilidad.
--
-- Esta migración hace cuatro cosas:
--
--   1. Agrega `dedup_key text` (nullable) — clave compuesta opcional para
--      deduplicar eventos generados por jobs. Patrón:
--        <tipo>:<expediente_numero>:<fuente_item_id>
--
--   2. Crea índice UNIQUE parcial (user_id, dedup_key) WHERE dedup_key IS NOT NULL,
--      de modo que las inserciones legacy (decretos, agenda, match engine) que
--      escriben sin dedup_key NO se vean afectadas, y los re-runs del cron
--      noveltyScan no inserten duplicados.
--
--   3. Agrega columna `user_id` (nullable, FK a auth.users) — los novedad
--      eventos son PER-USER (un mismo cruce SharePoint vs SIL puede ser una
--      novedad para Carlos y no para Wendy si Wendy ya la marcó como vista).
--      Eventos legacy (decretos, agenda) NO setean user_id → siguen siendo
--      shared, fan-out vía match engine.
--
--   4. Extiende el CHECK de event_type para aceptar los 4 tipos del
--      noveltyDetector ('mocion_137_no_reflejada_en_tramite',
--      'consulta_177_no_reflejada_en_tramite', 'acta_sin_evento_tramite',
--      'mocion_segundo_dia_sin_primer_dia').
--
-- IMMUTABLE constraint warning: NO usamos `current_date` ni `now()` en
-- predicados de índice. El WHERE del unique index es `dedup_key is not null`,
-- que es IMMUTABLE.
--
-- Idempotente: todas las sentencias `add column if not exists` /
-- `create unique index if not exists` / `drop policy if exists`. Re-ejecutar
-- es un no-op.
--
-- Autor: Jred / Claude Code — 2026-05-16

-- ─── 1. dedup_key (nullable) ────────────────────────────────────────────
alter table centinela_eventos
  add column if not exists dedup_key text;

comment on column centinela_eventos.dedup_key is
  'Key compuesta opcional para deduplicar eventos generados por jobs. '
  'Formato: <tipo>:<expediente_numero>:<fuente_item_id>. Si el cron '
  'noveltyScan corre 2x con el mismo input, el segundo run no inserta '
  'gracias al unique index parcial (user_id, dedup_key).';

-- ─── 2. user_id (nullable, FK a auth.users) ─────────────────────────────
-- Cuando user_id es NULL → evento shared (decreto, agenda, match engine).
-- Cuando user_id está set → evento per-user del cron noveltyScan.
alter table centinela_eventos
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists centinela_eventos_user_detected_idx
  on centinela_eventos (user_id, detected_at desc)
  where user_id is not null;

comment on column centinela_eventos.user_id is
  'NULL = evento shared (legacy: decretos, agenda, match engine fan-out). '
  'NOT NULL = evento generado por job per-user (noveltyScan). El feed del '
  'expediente filtra por (expediente_id, user_id IN (NULL, current_user_id)).';

-- ─── 3. unique (user_id, dedup_key) parcial ─────────────────────────────
-- Sólo aplica cuando dedup_key NOT NULL. Inserciones legacy sin dedup_key
-- no contan contra esta restricción.
--
-- Nota: el unique sobre (user_id, dedup_key) cubre tanto el caso per-user
-- (user_id NOT NULL) como el caso shared (user_id NULL pero dedup_key set,
-- por si en el futuro el match engine quiere idempotencia explícita).
create unique index if not exists centinela_eventos_dedup_idx
  on centinela_eventos (user_id, dedup_key)
  where dedup_key is not null;

-- ─── 4. Extender CHECK de event_type ────────────────────────────────────
-- Postgres no permite alterar una check constraint in-place; hay que drop +
-- re-add. Es seguro porque los valores actuales son un subset del nuevo set.
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
    'mocion_segundo_dia_sin_primer_dia'
  ));

-- ─── 5. RLS: usuarios leen sus propias novedades + las shared ───────────
-- La policy SELECT existente (0033) cubre "authenticated puede leer todo".
-- La dejamos: los eventos shared (decreto, agenda) los puede ver cualquiera,
-- y los per-user no son sensibles (sólo cruzan datos públicos del SIL). Pero
-- si quisiéramos endurecer en el futuro, basta con:
--   USING (user_id IS NULL OR user_id = auth.uid())
-- Por ahora dejamos la policy permisiva ya existente.

drop policy if exists "centinela_eventos authenticated read" on centinela_eventos;
create policy "centinela_eventos authenticated read"
  on centinela_eventos for select
  using (auth.role() = 'authenticated');
