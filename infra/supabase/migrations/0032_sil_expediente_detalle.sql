-- 0032_sil_expediente_detalle.sql
--
-- Biblioteca de expediente unificada — Track B del Sprint 1 (2026-05-14).
--
-- Por qué: el SIL divide la información de un expediente en 12 pestañas
-- separadas. El cliente (CL2 Consultoría) pidió explícitamente poder ver
-- "al menos en un mismo tab la mayoría de esta información, de una forma
-- mucho más dinámica que el SIL." Estas tablas almacenan las cinco
-- secciones principales que hoy exigen N clicks en el SIL:
--
--   1. sil_expediente_tramite      → pestaña "Tramitación" (timeline procesal)
--   2. sil_expediente_proponentes  → pestaña "Proponentes" (orden de firma)
--   3. sil_expediente_consultas    → pestaña "Consultas" (entidades + PDFs)
--   4. sil_leyes                   → pestaña "Información de Ley" (solo si llegó a ley)
--   5. sil_leyes_afectaciones      → sub-pestaña "Afectaciones" (grafo de leyes)
--   6. sil_expediente_documentos   → documentos descargables por tipo
--
-- Sprint target: endpoint GET /api/expediente/:numero/full retorna todo
-- en un solo round-trip, permitiendo renderizar el dashboard sin tabs.
--
-- Backfill: scraper `services/silDetailScraper.ts` (Sprint 1) corre
-- expediente por expediente sobre los ~21k activos 2022-2026. El scraper
-- llena estas tablas vía `persistExpedienteDetalle()`.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. sil_expediente_tramite — Timeline de tramitación procesal
-- ─────────────────────────────────────────────────────────────────────────────
-- Cada fila es un evento del SIL pestaña "Tramitación": ingreso a comisión,
-- votación, recepción en archivo, etc. Ordered por fecha_inicio ASC da el
-- timeline cronológico del proyecto.
create table if not exists sil_expediente_tramite (
  id           uuid primary key default gen_random_uuid(),
  expediente_id text not null references sil_expedientes(numero) on delete cascade,
  organo_legislativo text not null, -- 'PLENARIO', 'AMBIENTE (ÁREA IV)', 'ARCHIVO', etc.
  descripcion        text not null, -- 'INGRESO EN EL ORDEN DEL DÍA (PLENARIO)'
  fecha_inicio       date not null,
  fecha_termino      date,          -- null si el evento no tiene cierre
  orden              int,           -- posición explícita si viene del SIL (fallback: sort por fecha)
  raw                jsonb,         -- payload original del scrape para re-parseo posterior
  created_at         timestamptz default now()
);

create index if not exists sil_tramite_expediente_idx
  on sil_expediente_tramite (expediente_id, fecha_inicio);

-- RLS: solo service_role escribe; usuarios autenticados leen.
alter table sil_expediente_tramite enable row level security;

create policy "service_role_write_tramite" on sil_expediente_tramite
  for all to service_role using (true) with check (true);

create policy "authenticated_read_tramite" on sil_expediente_tramite
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sil_expediente_proponentes — Orden de firma (pestaña Proponentes)
-- ─────────────────────────────────────────────────────────────────────────────
-- firma_orden=1 es el proponente principal (quien puso el proyecto).
-- Resto son co-firmantes. Permite búsqueda inversa "todos los proyectos
-- de diputado X" y mapas de afinidad entre firmantes.
create table if not exists sil_expediente_proponentes (
  expediente_id text not null references sil_expedientes(numero) on delete cascade,
  firma_orden   int  not null,
  diputado_nombre text not null,
  administracion  text,  -- '2022-2026'
  fraccion        text,  -- a veces no viene en el SIL
  primary key (expediente_id, firma_orden)
);

create index if not exists sil_proponentes_diputado_idx
  on sil_expediente_proponentes (diputado_nombre);

alter table sil_expediente_proponentes enable row level security;

create policy "service_role_write_proponentes" on sil_expediente_proponentes
  for all to service_role using (true) with check (true);

create policy "authenticated_read_proponentes" on sil_expediente_proponentes
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. sil_expediente_consultas — Consultas a entidades (pestaña Consultas)
-- ─────────────────────────────────────────────────────────────────────────────
-- Los expedientes consultan formalmente a entidades técnicas (BCCR,
-- Procuraduría, ministerios, Contraloría, gremios). Las entidades responden
-- con PDFs firmados. Esta tabla captura consulta + respuesta con link al PDF.
-- Es "inteligencia previa al voto" — clave para los consultores de lobby.
create table if not exists sil_expediente_consultas (
  id                     uuid primary key default gen_random_uuid(),
  expediente_id          text not null references sil_expedientes(numero) on delete cascade,
  entidad_consultada     text not null,
  fecha_consulta         date,
  fecha_respuesta        date,              -- null si no han respondido
  documento_url          text,              -- URL al PDF de la respuesta
  documento_storage_path text,             -- path en GCS si ya lo bajamos
  tipo_respuesta         text,             -- 'a_favor' | 'en_contra' | 'condicional'
                                           -- | 'sin_observaciones' | null (pendiente)
  resumen_por_tanto      text,             -- extracto del POR TANTO / conclusiones del PDF
  raw                    jsonb,
  created_at             timestamptz default now()
);

create index if not exists sil_consultas_expediente_idx
  on sil_expediente_consultas (expediente_id);
create index if not exists sil_consultas_entidad_idx
  on sil_expediente_consultas (entidad_consultada);

alter table sil_expediente_consultas enable row level security;

create policy "service_role_write_consultas" on sil_expediente_consultas
  for all to service_role using (true) with check (true);

create policy "authenticated_read_consultas" on sil_expediente_consultas
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. sil_leyes — Información de Ley (solo cuando el expediente llegó a ley)
-- ─────────────────────────────────────────────────────────────────────────────
-- Aparece solo cuando el expediente fue aprobado y publicado. Contiene los
-- 12 campos del tab "Información de Ley" del SIL: gaceta, alcance, fechas de
-- aprobación, sanción, publicación, vigencia + datos de veto si hubo.
-- Permite resolver el bug "es ley o no" de forma definitiva: si existe fila
-- aquí → ES LEY.
create table if not exists sil_leyes (
  id                         uuid primary key default gen_random_uuid(),
  expediente_origen_id       text not null unique references sil_expedientes(numero),
  numero_ley                 text,
  numero_gaceta              text,
  alcance                    text,
  fecha_aprobacion_2_3       date,               -- "Aprobado 2/3 debate"
  fecha_emitido_asamblea     date,
  fecha_sancionado           date,
  fecha_devuelto_ejecutivo   date,               -- no null = fue vetado
  fecha_publicacion          date,
  fecha_rige                 date,
  estado                     text default 'Vigente', -- 'Vigente' | 'Derogada' | 'Suspendida'
  veto_texto                 text,               -- texto completo del veto presidencial si hubo
  reselo                     bool default false, -- Asamblea reselló sobre el veto
  raw                        jsonb,
  created_at                 timestamptz default now()
);

alter table sil_leyes enable row level security;

create policy "service_role_write_leyes" on sil_leyes
  for all to service_role using (true) with check (true);

create policy "authenticated_read_leyes" on sil_leyes
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. sil_leyes_afectaciones — Grafo de afectaciones entre leyes
-- ─────────────────────────────────────────────────────────────────────────────
-- Qué leyes anteriores deroga / reforma / adiciona / suspende la ley nueva.
-- ley_id_afectada es nullable porque a veces la ley afectada no está indexada.
create table if not exists sil_leyes_afectaciones (
  id                uuid primary key default gen_random_uuid(),
  ley_id_origen     uuid not null references sil_leyes(id) on delete cascade,
  ley_id_afectada   uuid references sil_leyes(id), -- nullable: ley externa no indexada
  ley_numero_afectada text,                         -- texto crudo si no tenemos ref
  tipo              text not null,                  -- 'deroga' | 'reforma' | 'adiciona' | 'suspende'
  articulos         text                            -- "art. 23, inciso b del art. 5"
);

create index if not exists sil_leyes_afectaciones_origen_idx
  on sil_leyes_afectaciones (ley_id_origen);

alter table sil_leyes_afectaciones enable row level security;

create policy "service_role_write_afectaciones" on sil_leyes_afectaciones
  for all to service_role using (true) with check (true);

create policy "authenticated_read_afectaciones" on sil_leyes_afectaciones
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. sil_expediente_documentos — Documentos descargables por tipo
-- ─────────────────────────────────────────────────────────────────────────────
-- Textos sustitutivos, dictámenes de mayoría/minoría, informes de Servicios
-- Técnicos, mociones 137/138 por expediente. Distinto de sil_documentos
-- (legacy SharePoint) — aquí cubrimos los PDFs que el cliente quiere indexar
-- y clasificar por tipo procesal.
create table if not exists sil_expediente_documentos (
  id            uuid primary key default gen_random_uuid(),
  expediente_id text not null references sil_expedientes(numero) on delete cascade,
  tipo          text not null,
  -- Valores válidos de tipo:
  --   'texto_sustitutivo'          — texto alternativo al proyecto base
  --   'dictamen_mayoria'           — dictamen afirmativo de comisión
  --   'dictamen_minoria'           — dictamen de minoría (negativo)
  --   'informe_servicios_tecnicos' — análisis de la Dirección de Servicios Técnicos
  --   'informe_subcomision'        — informe de subcomisión
  --   'mocion_137_primer_dia'      — moción de fondo art. 137, primer día
  --   'mocion_137_segundo_dia'     — moción de fondo art. 137, segundo día (urgente)
  --   'mocion_138'                 — moción de reiteración
  --   'mocion_177'                 — moción de fondo dispensada de trámite
  --   'otro'                       — catch-all
  titulo        text,
  fecha         date,
  url           text not null,
  storage_path  text,                        -- path en GCS si ya lo bajamos
  embed_status  text default 'pending',      -- 'pending' | 'in_progress' | 'done' | 'failed'
  raw           jsonb,
  created_at    timestamptz default now()
);

create index if not exists sil_expediente_documentos_expediente_idx
  on sil_expediente_documentos (expediente_id, tipo);

alter table sil_expediente_documentos enable row level security;

create policy "service_role_write_exp_documentos" on sil_expediente_documentos
  for all to service_role using (true) with check (true);

create policy "authenticated_read_exp_documentos" on sil_expediente_documentos
  for select to authenticated using (true);
