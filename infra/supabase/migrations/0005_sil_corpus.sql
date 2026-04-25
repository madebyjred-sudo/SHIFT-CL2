-- shift-cl2 — SIL (Sistema de Información Legislativa) corpus tables.
--
-- Source-of-truth: https://consultassil3.asamblea.go.cr (ASP.NET WebForms,
-- ~25k expedientes) + https://www.asamblea.go.cr/glcp/_api/web/lists(...)/items
-- (SharePoint OData, ~60k structural records: iniciativas, mociones,
-- dictámenes, votaciones, actas, leyes aprobadas).
--
-- Two ingest paths:
--   1. SharePoint REST → fast JSON pull (~30 min full backfill).
--   2. WebForms scraper → expediente-by-expediente metadata + PDF links
--      (~3-4h with concurrency).
--
-- Embeddings flow into legislative_chunks with source_type='sil_*' so the
-- existing RAG (match_chunks) picks them up unchanged.
--
-- License: SIL data published CC BY 4.0; we attribute "Asamblea Legislativa
-- de Costa Rica" in the citation card metadata.

-- =====================================================
-- Extend legislative_chunks.source_type to allow SIL flavors
-- =====================================================
-- Original constraint (0001) only allowed: 'transcript','pdf','web','metadata'.
-- We need 'sil_expediente', 'sil_dictamen', 'sil_mocion', 'sil_votacion',
-- 'sil_acta', 'sil_ley'. Drop and recreate the check.
alter table legislative_chunks
  drop constraint if exists legislative_chunks_source_type_check;

alter table legislative_chunks
  add constraint legislative_chunks_source_type_check
  check (source_type in (
    'transcript', 'pdf', 'web', 'metadata',
    'sil_expediente', 'sil_dictamen', 'sil_mocion',
    'sil_votacion', 'sil_acta', 'sil_ley'
  ));

-- =====================================================
-- sil_expedientes — main legislative file (proyecto de ley, reforma, etc.)
-- =====================================================
create table if not exists sil_expedientes (
  id integer primary key,                     -- the expediente number itself (1..~25500)
  numero text not null,                       -- "22.293" formatted
  titulo text,
  proponente text,
  comision text,
  fecha_presentacion date,
  estado text,                                -- "En estudio", "Aprobado", "Archivado", etc.
  tipo text,                                  -- "Proyecto de ley", "Reforma constitucional", etc.
  legislatura text,                           -- "2022-2026" cuatrienio
  url_detalle text not null,                  -- canonical SIL URL for citations
  metadata jsonb,                             -- raw scraped fields (forward-compat)
  scraped_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sil_exp_numero_idx on sil_expedientes(numero);
create index if not exists sil_exp_fecha_idx on sil_expedientes(fecha_presentacion desc nulls last);
create index if not exists sil_exp_comision_idx on sil_expedientes(comision);
create index if not exists sil_exp_estado_idx on sil_expedientes(estado);
-- Full-text search on titulo + proponente (Spanish dictionary) — lets Lexa
-- cover keyword queries instantly without a vector lookup for trivial cases.
create index if not exists sil_exp_tsv_idx
  on sil_expedientes using gin (
    to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(proponente, ''))
  );

-- =====================================================
-- sil_documentos — PDFs/HTMLs attached to an expediente
-- (texto base, dictámenes, mociones, votaciones)
-- =====================================================
create table if not exists sil_documentos (
  id uuid primary key default gen_random_uuid(),
  expediente_id integer references sil_expedientes(id) on delete cascade,
  tipo text not null check (tipo in (
    'texto_base', 'dictamen_mayoria', 'dictamen_minoria',
    'mocion', 'votacion', 'acta', 'enmienda', 'otro'
  )),
  titulo text,
  fecha date,
  source_url text not null,                   -- direct PDF/HTML URL on asamblea.go.cr
  gcs_path text,                              -- gs://shift-cl2-sil/... once mirrored
  text_extracted text,                        -- raw text after pdf-parse
  text_chars integer,
  status text not null default 'pending'
    check (status in ('pending', 'downloaded', 'parsed', 'embedded', 'error')),
  error_message text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sil_doc_exp_idx on sil_documentos(expediente_id);
create index if not exists sil_doc_status_idx on sil_documentos(status, created_at);
create index if not exists sil_doc_tipo_idx on sil_documentos(tipo);

-- =====================================================
-- sil_iniciativas — SharePoint List "Todas las iniciativas" (current cuatrienio)
-- This shadows the canonical sil_expedientes view but with the SharePoint
-- structure (different field names, faster to backfill).
-- =====================================================
create table if not exists sil_iniciativas (
  id uuid primary key default gen_random_uuid(),
  sharepoint_id integer not null,             -- "ID" field from SharePoint
  list_guid uuid not null,                    -- which List this came from
  expediente_numero text,                     -- denormalized link to sil_expedientes.numero
  titulo text,
  tipo_iniciativa text,
  fecha_recibido date,
  asunto text,
  recibido_por text,
  raw jsonb not null,                         -- full SharePoint OData object
  created_at_sp timestamptz,                  -- "Created" SP field
  modified_at_sp timestamptz,                 -- "Modified" SP field — used for delta crawls
  scraped_at timestamptz not null default now(),
  unique (list_guid, sharepoint_id)
);

create index if not exists sil_ini_modified_idx on sil_iniciativas(modified_at_sp desc);
create index if not exists sil_ini_exp_idx on sil_iniciativas(expediente_numero);

-- =====================================================
-- sil_mociones — moción individual (procedural votes inside a session)
-- =====================================================
create table if not exists sil_mociones (
  id uuid primary key default gen_random_uuid(),
  sharepoint_id integer,
  expediente_numero text,
  titulo text,
  proponente text,
  fecha date,
  tipo_mocion text,
  resultado text,                             -- "Aprobada", "Rechazada", "Retirada"
  raw jsonb not null,
  scraped_at timestamptz not null default now()
);

create index if not exists sil_moc_fecha_idx on sil_mociones(fecha desc);
create index if not exists sil_moc_exp_idx on sil_mociones(expediente_numero);

-- =====================================================
-- sil_votaciones — plenary votes (a vote casts on a moción / dictamen)
-- =====================================================
create table if not exists sil_votaciones (
  id uuid primary key default gen_random_uuid(),
  sharepoint_id integer,
  expediente_numero text,
  fecha date,
  resultado text,                             -- "Aprobado", "Rechazado"
  votos_a_favor integer,
  votos_en_contra integer,
  abstenciones integer,
  ausentes integer,
  votos_jsonb jsonb,                          -- per-diputado breakdown if available
  raw jsonb not null,
  scraped_at timestamptz not null default now()
);

create index if not exists sil_vot_fecha_idx on sil_votaciones(fecha desc);
create index if not exists sil_vot_exp_idx on sil_votaciones(expediente_numero);

-- =====================================================
-- sil_leyes_aprobadas — final approved laws (subset of expedientes)
-- =====================================================
create table if not exists sil_leyes_aprobadas (
  id uuid primary key default gen_random_uuid(),
  sharepoint_id integer,
  numero_ley text,                            -- "Ley N.º 10.234"
  expediente_numero text,
  titulo text,
  fecha_publicacion date,
  gaceta text,                                -- La Gaceta reference
  raw jsonb not null,
  scraped_at timestamptz not null default now()
);

create index if not exists sil_ley_fecha_idx on sil_leyes_aprobadas(fecha_publicacion desc);
create index if not exists sil_ley_exp_idx on sil_leyes_aprobadas(expediente_numero);

-- =====================================================
-- sil_crawl_runs — observability for backfills + delta crawls
-- =====================================================
create table if not exists sil_crawl_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('sharepoint_odata', 'webforms_consultassil3')),
  list_or_target text,                        -- which List GUID or "expedientes" range
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_in integer not null default 0,
  rows_out integer not null default 0,
  errors integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),
  detail jsonb
);

create index if not exists sil_crawl_started_idx on sil_crawl_runs(started_at desc);

-- =====================================================
-- RLS: SIL data is read-shared across authenticated users (same model as
-- sessions / legislative_chunks). Writes are service-role only (workers).
-- =====================================================
alter table sil_expedientes enable row level security;
alter table sil_documentos enable row level security;
alter table sil_iniciativas enable row level security;
alter table sil_mociones enable row level security;
alter table sil_votaciones enable row level security;
alter table sil_leyes_aprobadas enable row level security;
alter table sil_crawl_runs enable row level security;

-- Helper to define read-shared + deny-direct-writes in one go.
-- (Postgres has no DO loops in pure SQL files cleanly; we just repeat.)
drop policy if exists "authed read sil_expedientes" on sil_expedientes;
create policy "authed read sil_expedientes" on sil_expedientes for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_expedientes" on sil_expedientes;
create policy "deny writes sil_expedientes" on sil_expedientes for insert with check (false);
drop policy if exists "deny updates sil_expedientes" on sil_expedientes;
create policy "deny updates sil_expedientes" on sil_expedientes for update using (false);

drop policy if exists "authed read sil_documentos" on sil_documentos;
create policy "authed read sil_documentos" on sil_documentos for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_documentos" on sil_documentos;
create policy "deny writes sil_documentos" on sil_documentos for insert with check (false);
drop policy if exists "deny updates sil_documentos" on sil_documentos;
create policy "deny updates sil_documentos" on sil_documentos for update using (false);

drop policy if exists "authed read sil_iniciativas" on sil_iniciativas;
create policy "authed read sil_iniciativas" on sil_iniciativas for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_iniciativas" on sil_iniciativas;
create policy "deny writes sil_iniciativas" on sil_iniciativas for insert with check (false);
drop policy if exists "deny updates sil_iniciativas" on sil_iniciativas;
create policy "deny updates sil_iniciativas" on sil_iniciativas for update using (false);

drop policy if exists "authed read sil_mociones" on sil_mociones;
create policy "authed read sil_mociones" on sil_mociones for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_mociones" on sil_mociones;
create policy "deny writes sil_mociones" on sil_mociones for insert with check (false);

drop policy if exists "authed read sil_votaciones" on sil_votaciones;
create policy "authed read sil_votaciones" on sil_votaciones for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_votaciones" on sil_votaciones;
create policy "deny writes sil_votaciones" on sil_votaciones for insert with check (false);

drop policy if exists "authed read sil_leyes" on sil_leyes_aprobadas;
create policy "authed read sil_leyes" on sil_leyes_aprobadas for select using (auth.role() = 'authenticated');
drop policy if exists "deny writes sil_leyes" on sil_leyes_aprobadas;
create policy "deny writes sil_leyes" on sil_leyes_aprobadas for insert with check (false);

-- crawl_runs is ops-internal; no read access for regular users.
drop policy if exists "service role only crawl runs" on sil_crawl_runs;
create policy "service role only crawl runs" on sil_crawl_runs for select using (false);
