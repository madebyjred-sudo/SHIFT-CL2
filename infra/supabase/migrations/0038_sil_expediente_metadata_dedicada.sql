-- 0038_sil_expediente_metadata_dedicada.sql
--
-- Sprint 2 Track H — Cierre deuda CRITICAL-DEBT #8.
--
-- Las features del Sprint v3 (audiencias, actas con speakers, consultas Sala
-- Constitucional, apariciones en orden del día) viven hoy en
-- `sil_expedientes.metadata` jsonb como workaround "para no bloquear demo".
-- Esta migración les da tablas dedicadas con FK + tipo + RLS + índices,
-- siguiendo el patrón de 0037_fechas_extraidas_tracking.sql.
--
-- Cobertura por tabla:
--   sil_expediente_audiencias              → pedido 16e (audiencias con
--                                              asistente + cargo + organización)
--   sil_expediente_actas_indexadas         → pedido 08  (actas con "quién dijo
--                                              qué" — speakers)
--   sil_expediente_consultas_sala          → pedido 12a (consultas Sala IV con
--                                              POR TANTO extracto + decisión)
--   sil_expediente_orden_dia_apariciones   → pedido 16c (apariciones por capítulo
--                                              + debate + PDF orden día)
--
-- NO se crea aquí tabla para `novedades_detectadas` — esa entidad ya vive en
-- `centinela_eventos` (migration 0033). El servicio noveltyDetector persiste
-- ahí en Sprint 2 Track I.
--
-- Patrón RLS: lectura authenticated, write service_role (los datos vienen del
-- crawler + parsers, no de input directo del usuario).
--
-- Source: Sprint 2 Track H Design Doc, AGENTS/CL2/sprints/2026-05-16-sprint-2-3-design-doc.md

-- ─── 1. AUDIENCIAS ────────────────────────────────────────────────────────

create table if not exists sil_expediente_audiencias (
  id                     uuid primary key default gen_random_uuid(),
  expediente_id          text not null references sil_expedientes(numero) on delete cascade,
  fecha                  date not null,
  hora                   text,                       -- "10:00", "15:30" — string libre
  comision               text not null,              -- "AMBIENTE (ÁREA IV)", "Hacendarios", etc.
  asistente_nombre       text not null,
  asistente_cargo        text,                       -- "Presidenta Ejecutiva", "Director Jurídico"
  asistente_organizacion text,                       -- "Instituto Nacional de Seguros (INS)"
  posicion_estimada      text check (posicion_estimada in (
    'a_favor', 'en_contra', 'condicional', 'sin_observaciones', 'desconocida'
  )),
  fuente_orden_dia_url   text,                       -- PDF de donde se extrajo la audiencia
  detectada_at           timestamptz not null default now(),
  -- Para deduplicar al re-correr el parser
  unique (expediente_id, fecha, comision, asistente_nombre)
);

create index if not exists sil_audiencias_expediente_idx
  on sil_expediente_audiencias (expediente_id, fecha desc);

create index if not exists sil_audiencias_proximas_idx
  on sil_expediente_audiencias (fecha)
  where fecha >= current_date;

alter table sil_expediente_audiencias enable row level security;
drop policy if exists "read audiencias" on sil_expediente_audiencias;
drop policy if exists "service writes audiencias" on sil_expediente_audiencias;
create policy "read audiencias" on sil_expediente_audiencias
  for select to authenticated using (true);
create policy "service writes audiencias" on sil_expediente_audiencias
  for all to authenticated using (auth.role() = 'service_role');


-- ─── 2. ACTAS INDEXADAS CON SPEAKERS ──────────────────────────────────────

create table if not exists sil_expediente_actas_indexadas (
  id              uuid primary key default gen_random_uuid(),
  expediente_id   text not null references sil_expedientes(numero) on delete cascade,
  acta_numero     int not null,                       -- "Sesión #14"
  comision        text not null,                      -- "AMBIENTE (ÁREA IV)"
  fecha_sesion    date not null,
  acta_pdf_url    text not null,                      -- PDF oficial del acta
  -- Speakers identificados en el acta como JSONB:
  --   [{ role, nombre, timestamp_aprox, texto }, ...]
  -- Cada speaker es una intervención individual. El array se ordena por
  -- timestamp_aprox. El texto va con cita textual.
  speakers        jsonb not null default '[]'::jsonb,
  speakers_count  int generated always as (jsonb_array_length(speakers)) stored,
  indexed_at      timestamptz not null default now(),
  unique (expediente_id, acta_numero, comision)
);

create index if not exists sil_actas_expediente_idx
  on sil_expediente_actas_indexadas (expediente_id, fecha_sesion desc);

alter table sil_expediente_actas_indexadas enable row level security;
drop policy if exists "read actas" on sil_expediente_actas_indexadas;
drop policy if exists "service writes actas" on sil_expediente_actas_indexadas;
create policy "read actas" on sil_expediente_actas_indexadas
  for select to authenticated using (true);
create policy "service writes actas" on sil_expediente_actas_indexadas
  for all to authenticated using (auth.role() = 'service_role');


-- ─── 3. CONSULTAS A SALA CONSTITUCIONAL ───────────────────────────────────

create table if not exists sil_expediente_consultas_sala (
  id                    uuid primary key default gen_random_uuid(),
  expediente_id         text not null references sil_expedientes(numero) on delete cascade,
  numero_resolucion     text not null,                -- "2024-009856"
  fecha_resolucion      date not null,
  fecha_consulta        date,
  decision              text not null check (decision in (
    'con_lugar', 'sin_lugar', 'parcial', 'inconstitucional',
    'inconstitucional_parcial', 'evacuada', 'rechazada', 'desestimada',
    'sin_clasificar'
  )),
  por_tanto_extracto    text not null,                -- texto del POR TANTO citable
  magistrados           text[] not null default array[]::text[], -- array de nombres
  voto_completo_url     text,                         -- link al voto oficial PDF
  tipo_consulta         text check (tipo_consulta in (
    'consulta_facultativa', 'consulta_preceptiva', 'recurso_inconstitucionalidad', 'otro'
  )),
  ingresada_at          timestamptz not null default now(),
  unique (expediente_id, numero_resolucion)
);

create index if not exists sil_consultas_sala_expediente_idx
  on sil_expediente_consultas_sala (expediente_id, fecha_resolucion desc);

create index if not exists sil_consultas_sala_decision_idx
  on sil_expediente_consultas_sala (decision)
  where decision in ('inconstitucional', 'inconstitucional_parcial', 'con_lugar');

alter table sil_expediente_consultas_sala enable row level security;
drop policy if exists "read consultas sala" on sil_expediente_consultas_sala;
drop policy if exists "service writes consultas sala" on sil_expediente_consultas_sala;
create policy "read consultas sala" on sil_expediente_consultas_sala
  for select to authenticated using (true);
create policy "service writes consultas sala" on sil_expediente_consultas_sala
  for all to authenticated using (auth.role() = 'service_role');


-- ─── 4. APARICIONES EN ORDEN DEL DÍA (CAPÍTULO + DEBATE) ──────────────────

create table if not exists sil_expediente_orden_dia_apariciones (
  id                    uuid primary key default gen_random_uuid(),
  expediente_id         text not null references sil_expedientes(numero) on delete cascade,
  fecha_sesion          date not null,
  hora                  text,
  numero_sesion         int,                          -- "Sesión ordinaria #147"
  tipo_sesion           text check (tipo_sesion in (
    'ordinaria', 'extraordinaria', 'mixta'
  )),
  capitulo              text not null check (capitulo in (
    'capitulo_primero', 'capitulo_segundo', 'capitulo_tercero', 'sin_clasificar'
  )),
  capitulo_titulo       text,                         -- "CAPÍTULO TERCERO"
  debate                text not null check (debate in (
    'primer_debate', 'segundo_debate', 'tercer_debate',
    'mocion_orden', 'sin_clasificar'
  )),
  orden_pdf_url         text,                         -- PDF oficial del orden día
  contexto_extracto     text,                         -- snippet de texto donde aparece
  detectada_at          timestamptz not null default now(),
  unique (expediente_id, fecha_sesion, capitulo, debate)
);

create index if not exists sil_orden_dia_expediente_idx
  on sil_expediente_orden_dia_apariciones (expediente_id, fecha_sesion desc);

create index if not exists sil_orden_dia_futuras_idx
  on sil_expediente_orden_dia_apariciones (fecha_sesion)
  where fecha_sesion >= current_date;

alter table sil_expediente_orden_dia_apariciones enable row level security;
create policy "read orden dia apariciones" on sil_expediente_orden_dia_apariciones
  for select to authenticated using (true);
create policy "service writes orden dia apariciones" on sil_expediente_orden_dia_apariciones
  for all to authenticated using (auth.role() = 'service_role');


-- ─── 5. Comentario en la tabla padre para flagear el move ─────────────────

comment on column sil_expedientes.metadata is
  'JSONB flexible para datos efímeros. Los datos canónicos del Sprint v3
  (fechas extraídas, audiencias, actas, consultas sala, orden_dia_apariciones)
  viven en tablas dedicadas a partir de migration 0037 y 0038. Cualquier dato
  nuevo aquí debe tener justificación de por qué NO va a tabla dedicada.';
