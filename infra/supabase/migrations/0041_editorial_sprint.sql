-- 0041_editorial_sprint.sql
--
-- Sprint 3 Track P — Sprint editorial diferido.
--
-- Construye la infraestructura del motor editorial de CL2 — taxonomía
-- canónica de 51 categorías de asuntos públicos, clasificación N:N
-- expediente↔categoria, resúmenes mixtos por expediente, e informe semanal
-- por consultor.
--
-- Contexto producto:
--   CL2 Consultoría mantiene mentalmente (Excel interno) una taxonomía de
--   ~51 categorías para clasificar expedientes a sus clientes. Donovan +
--   Carlos (sesión 14-may) pidieron que el sistema:
--     1. Clasifique cada expediente en N categorías CL2 (auto, con confidence).
--     2. Genere resúmenes mixtos por expediente (texto sustitutivo + dictamen
--        + Sala IV + actas, con cita).
--     3. Mande un informe semanal automático cada lunes 6am con novedades +
--        nuevos expedientes en watchlist + alertas críticas + acciones.
--
-- Doctrina LLM-vs-Algoritmo (cl2-brain):
--   - Clasificación de 51 cats (criterios subjetivos) → LLM con confidence.
--   - Resumen mixto (voz humana, citas) → LLM.
--   - Cron scheduling + dedup + agregación SQL del informe → algoritmo.
--   - Cuerpo del informe (narrativa) → LLM sobre data agregada.
--
-- Esta migración crea:
--
--   • cl2_categorias              — 51 categorías canónicas (seed inline).
--   • cl2_expediente_categorias   — N:N expediente↔categoria con confidence.
--   • cl2_resumenes               — un resumen mixto por expediente.
--   • cl2_informes_semanales      — informe weekly por consultor (user).
--   • cl2_expediente_editorial    — VIEW que junta resumen + categorías.
--
-- RLS:
--   - cl2_categorias y cl2_expediente_categorias y cl2_resumenes:
--     authenticated read, service_role write (los datos vienen del LLM job).
--   - cl2_informes_semanales: el user lee SOLO los suyos (auth.uid()),
--     service_role escribe (job de informe).
--
-- Idempotente: every drop policy if exists + create policy + create table
-- if not exists. Re-correr es no-op.
--
-- IMMUTABLE guard: no current_date / now() en predicados de índice.
--
-- Author: Jred / Claude Code — 2026-05-16


-- ═══════════════════════════════════════════════════════════════════════
-- 1. TAXONOMÍA — 51 categorías canónicas
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists cl2_categorias (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  nombre      text not null,
  area        text not null check (area in (
    'productivo', 'social', 'institucional', 'ambiental', 'fiscal',
    'internacional', 'seguridad', 'derechos'
  )),
  descripcion text,
  vigente     bool not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists cl2_categorias_area_idx
  on cl2_categorias (area)
  where vigente;

comment on table cl2_categorias is
  'Taxonomía canónica CL2. 51 categorías de asuntos públicos de Costa Rica
   distribuidas en 8 áreas. Slug es el identificador estable que usa el LLM
   al clasificar. Vigente=false saca la categoría del set disponible sin
   romper FKs históricos en cl2_expediente_categorias.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. CLASIFICACIÓN N:N — expediente ↔ categoria
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists cl2_expediente_categorias (
  id              uuid primary key default gen_random_uuid(),
  expediente_id   text not null references sil_expedientes(numero) on delete cascade,
  categoria_id    uuid not null references cl2_categorias(id) on delete cascade,
  confidence      numeric not null check (confidence between 0 and 1),
  razon_llm       text,
  metodo          text not null default 'llm' check (metodo in (
    'llm', 'manual', 'manual_override'
  )),
  classified_at   timestamptz not null default now(),
  unique (expediente_id, categoria_id)
);

create index if not exists cl2_expediente_categorias_exp_idx
  on cl2_expediente_categorias (expediente_id, confidence desc);

create index if not exists cl2_expediente_categorias_cat_idx
  on cl2_expediente_categorias (categoria_id, classified_at desc);

create index if not exists cl2_expediente_categorias_freshness_idx
  on cl2_expediente_categorias (expediente_id, classified_at);

comment on table cl2_expediente_categorias is
  'Clasificación N:N expediente↔categoria con confidence (0..1) + razón
   corta del LLM. Un expediente típicamente lleva 2-3 categorías. Idempotente
   por (expediente_id, categoria_id). metodo=llm es el default; manual_override
   permite a un consultor pin una clasificación que el LLM no detectaría.';


-- ═══════════════════════════════════════════════════════════════════════
-- 3. RESÚMENES MIXTOS — uno por expediente
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists cl2_resumenes (
  id                uuid primary key default gen_random_uuid(),
  expediente_id     text not null references sil_expedientes(numero) on delete cascade unique,
  resumen_md        text not null,
  fuentes_citadas   jsonb not null default '[]'::jsonb,
  modelo            text not null,
  prompt_version    text not null default 'v1',
  tokens_in         int,
  tokens_out        int,
  generated_at      timestamptz not null default now(),
  refresh_after     timestamptz
);

create index if not exists cl2_resumenes_freshness_idx
  on cl2_resumenes (refresh_after);

create index if not exists cl2_resumenes_generated_idx
  on cl2_resumenes (generated_at desc);

comment on table cl2_resumenes is
  'Resumen editorial 3 párrafos por expediente (markdown). Combina texto
   sustitutivo + dictamen + Sala IV + actas con cita por bloque.
   fuentes_citadas es array de { tipo, fecha, url, fragmento_citado }.
   refresh_after es el timestamp tras el cual el job de regeneración debe
   re-generar el resumen (por defecto +7 días).';


-- ═══════════════════════════════════════════════════════════════════════
-- 4. INFORMES SEMANALES — uno por (user, semana_iso)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists cl2_informes_semanales (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  semana_iso          text not null,
  cuerpo_md           text not null,
  novedades_count     int not null default 0,
  alertas_criticas    int not null default 0,
  expedientes_nuevos  int not null default 0,
  acciones_propuestas jsonb,
  generated_at        timestamptz not null default now(),
  enviado_email       bool not null default false,
  unique (user_id, semana_iso)
);

create index if not exists cl2_informes_user_idx
  on cl2_informes_semanales (user_id, generated_at desc);

comment on table cl2_informes_semanales is
  'Informe editorial semanal por consultor. semana_iso formato "2026-W20"
   (year + ISO week). Generado los lunes 6am por job. cuerpo_md es markdown
   con título + resumen ejecutivo + novedades agrupadas + alertas críticas
   + expedientes nuevos + acciones propuestas. acciones_propuestas es array
   { tipo, expediente, urgencia, sugerencia }.';


-- ═══════════════════════════════════════════════════════════════════════
-- 5. VIEW unificada — resumen + categorías para el frontend
-- ═══════════════════════════════════════════════════════════════════════
create or replace view cl2_expediente_editorial as
  select
    r.expediente_id,
    r.resumen_md,
    r.modelo                  as resumen_modelo,
    r.prompt_version          as resumen_prompt_version,
    r.fuentes_citadas         as resumen_fuentes,
    r.generated_at            as resumen_generated_at,
    r.refresh_after           as resumen_refresh_after,
    coalesce(
      array_agg(c.nombre order by ec.confidence desc)
        filter (where c.nombre is not null),
      array[]::text[]
    )                         as categorias_nombres,
    coalesce(
      array_agg(c.slug order by ec.confidence desc)
        filter (where c.slug is not null),
      array[]::text[]
    )                         as categorias_slugs,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slug', c.slug,
          'nombre', c.nombre,
          'area', c.area,
          'confidence', ec.confidence,
          'razon_llm', ec.razon_llm,
          'metodo', ec.metodo
        )
        order by ec.confidence desc
      ) filter (where c.id is not null),
      '[]'::jsonb
    )                         as categorias_detalle
  from cl2_resumenes r
  left join cl2_expediente_categorias ec on ec.expediente_id = r.expediente_id
  left join cl2_categorias c on c.id = ec.categoria_id and c.vigente
  group by r.expediente_id, r.resumen_md, r.modelo, r.prompt_version,
           r.fuentes_citadas, r.generated_at, r.refresh_after;

comment on view cl2_expediente_editorial is
  'Join read-only de cl2_resumenes + cl2_expediente_categorias para el
   panel editorial del expediente. Devuelve también categorias_detalle
   como jsonb para que el frontend pinte chips con confidence + razón.';


-- ═══════════════════════════════════════════════════════════════════════
-- RLS — idempotente
-- ═══════════════════════════════════════════════════════════════════════

-- 1. cl2_categorias — todos los authenticated leen; service_role escribe.
alter table cl2_categorias enable row level security;
drop policy if exists "read cl2_categorias"          on cl2_categorias;
drop policy if exists "service writes cl2_categorias" on cl2_categorias;
create policy "read cl2_categorias" on cl2_categorias
  for select to authenticated using (true);
create policy "service writes cl2_categorias" on cl2_categorias
  for all to authenticated using (auth.role() = 'service_role');

-- 2. cl2_expediente_categorias — read authenticated, write service_role.
alter table cl2_expediente_categorias enable row level security;
drop policy if exists "read cl2_expediente_categorias"          on cl2_expediente_categorias;
drop policy if exists "service writes cl2_expediente_categorias" on cl2_expediente_categorias;
create policy "read cl2_expediente_categorias" on cl2_expediente_categorias
  for select to authenticated using (true);
create policy "service writes cl2_expediente_categorias" on cl2_expediente_categorias
  for all to authenticated using (auth.role() = 'service_role');

-- 3. cl2_resumenes — read authenticated, write service_role.
alter table cl2_resumenes enable row level security;
drop policy if exists "read cl2_resumenes"          on cl2_resumenes;
drop policy if exists "service writes cl2_resumenes" on cl2_resumenes;
create policy "read cl2_resumenes" on cl2_resumenes
  for select to authenticated using (true);
create policy "service writes cl2_resumenes" on cl2_resumenes
  for all to authenticated using (auth.role() = 'service_role');

-- 4. cl2_informes_semanales — el user lee SOLO los suyos; service_role escribe.
alter table cl2_informes_semanales enable row level security;
drop policy if exists "read own informes"            on cl2_informes_semanales;
drop policy if exists "service writes informes"      on cl2_informes_semanales;
create policy "read own informes" on cl2_informes_semanales
  for select to authenticated using (user_id = auth.uid());
create policy "service writes informes" on cl2_informes_semanales
  for all to authenticated using (auth.role() = 'service_role');


-- ═══════════════════════════════════════════════════════════════════════
-- SEED — 51 categorías canónicas
-- ═══════════════════════════════════════════════════════════════════════
-- Idempotente: on conflict (slug) do nothing → re-correr no duplica.
-- Si el cliente pide editar el nombre/área de una categoría existente,
-- se hace por update directo (manual), no por re-seed.

insert into cl2_categorias (slug, nombre, area, descripcion) values
  -- ─── PRODUCTIVO (13) ───────────────────────────────────────────────
  ('agricultura',          'Agricultura',                'productivo', 'Política agropecuaria, agroindustria, granos básicos, café, banano.'),
  ('ganaderia',            'Ganadería',                  'productivo', 'Ganadería bovina, porcina, avícola, sanidad animal.'),
  ('pesca',                'Pesca y acuicultura',        'productivo', 'Pesca artesanal y comercial, acuicultura, INCOPESCA.'),
  ('turismo',              'Turismo',                    'productivo', 'Política turística, ICT, certificaciones, ecoturismo.'),
  ('comercio_interno',     'Comercio interno',           'productivo', 'Comercio interno, MEIC, defensa del consumidor, competencia.'),
  ('banca_finanzas',       'Banca y finanzas',           'productivo', 'Banca pública y privada, SUGEF, SUGEVAL, mercado de valores.'),
  ('comercio_exterior',    'Comercio exterior',          'productivo', 'COMEX, tratados de libre comercio, exportaciones, aduanas.'),
  ('propiedad_intelectual','Propiedad intelectual',      'productivo', 'Patentes, marcas, derechos de autor, registro.'),
  ('telecomunicaciones',   'Telecomunicaciones',         'productivo', 'SUTEL, espectro, banda ancha, telefonía.'),
  ('transporte',           'Transporte e infraestructura','productivo', 'CONAVI, MOPT, concesiones, transporte público, vialidad.'),
  ('energia',              'Energía',                    'productivo', 'ARESEP, ICE, RECOPE, generación, transmisión, tarifas.'),
  ('mineria',              'Minería',                    'productivo', 'Minería metálica y no metálica, concesiones, regulación.'),
  ('vivienda',             'Vivienda',                   'productivo', 'BANHVI, MIVAH, política habitacional general (no vivienda social).'),

  -- ─── SOCIAL (12) ──────────────────────────────────────────────────
  ('salud',                'Salud',                      'social',     'CCSS, Ministerio de Salud, medicamentos, hospitales, salud pública.'),
  ('educacion',            'Educación',                  'social',     'MEP, CONARE, universidades públicas, educación técnica.'),
  ('seguridad_social',     'Seguridad social',           'social',     'Pensiones, IVM, régimen no contributivo, CCSS prestaciones.'),
  ('trabajo',              'Trabajo y empleo',           'social',     'MTSS, salario mínimo, código de trabajo, sindicatos.'),
  ('juventud',             'Juventud',                   'social',     'Consejo Nacional de Política Pública de la Persona Joven, deporte juvenil.'),
  ('mujer_genero',         'Mujer y género',             'social',     'INAMU, violencia de género, paridad, igualdad sustantiva.'),
  ('ninez_adolescencia',   'Niñez y adolescencia',       'social',     'PANI, código de niñez, protección integral.'),
  ('adulto_mayor',         'Adulto mayor',               'social',     'CONAPAM, pensiones no contributivas, derechos del adulto mayor.'),
  ('discapacidad',         'Discapacidad',               'social',     'CONAPDIS, ley 7600, accesibilidad universal.'),
  ('pueblos_indigenas',    'Pueblos indígenas',          'social',     'Territorios indígenas, consulta previa, INDER, ley 6172.'),
  ('vivienda_social',      'Vivienda social',            'social',     'Bono familiar de vivienda, FOSUVI, asentamientos informales.'),
  ('cultura',              'Cultura',                    'social',     'Ministerio de Cultura, teatros nacionales, patrimonio cultural.'),

  -- ─── INSTITUCIONAL (8) ────────────────────────────────────────────
  ('regimen_interno',      'Régimen interno asamblea',   'institucional', 'Reglamento de la Asamblea, comisiones, procedimiento legislativo.'),
  ('poder_judicial',       'Poder judicial',             'institucional', 'Corte Suprema, ley orgánica judicial, jueces, fiscalía.'),
  ('poder_ejecutivo',      'Poder ejecutivo',            'institucional', 'Casa Presidencial, ministerios, descentralización funcional.'),
  ('municipalidades',      'Autonomías municipales',     'institucional', 'Municipalidades, IFAM, código municipal, federaciones.'),
  ('contraloria',          'Contraloría General',        'institucional', 'CGR, ley de control interno, auditorías, hacienda pública.'),
  ('defensoria',           'Defensoría de los Habitantes','institucional', 'Defensoría, derechos humanos, recomendaciones administrativas.'),
  ('sistema_electoral',    'Sistema electoral',          'institucional', 'TSE, código electoral, financiamiento de partidos.'),
  ('reforma_estado',       'Reforma del Estado',         'institucional', 'Modernización institucional, fusión de entidades, empleo público.'),

  -- ─── AMBIENTAL (7) ────────────────────────────────────────────────
  ('ambiente_acuifero',    'Recurso hídrico',            'ambiental',  'AyA, ASADAS, manantiales, contaminación de aguas, ley de aguas.'),
  ('biodiversidad',        'Biodiversidad',              'ambiental',  'CONAGEBIO, áreas silvestres, especies en peligro, bioseguridad.'),
  ('residuos',             'Gestión de residuos',        'ambiental',  'Ley GIR, rellenos sanitarios, reciclaje, economía circular.'),
  ('cambio_climatico',     'Cambio climático',           'ambiental',  'NDC, descarbonización, mitigación, adaptación, FONAFIFO.'),
  ('aire',                 'Contaminación atmosférica',  'ambiental',  'Calidad del aire, emisiones vehiculares, monitoreo atmosférico.'),
  ('areas_protegidas',     'Áreas protegidas',           'ambiental',  'SINAC, parques nacionales, reservas biológicas, refugios.'),
  ('costero_marina',       'Gestión costero-marina',     'ambiental',  'Zona marítimo-terrestre, INCOPESCA, áreas marinas, ZMT.'),

  -- ─── FISCAL (5) ───────────────────────────────────────────────────
  ('hacienda',             'Hacienda pública',           'fiscal',     'Ministerio de Hacienda, regla fiscal, dirección general.'),
  ('presupuesto',          'Presupuesto nacional',       'fiscal',     'Presupuesto de la República, presupuestos extraordinarios, modificaciones.'),
  ('tributaria',           'Política tributaria',        'fiscal',     'IVA, impuesto sobre la renta, ISC, exoneraciones, evasión.'),
  ('deuda_publica',        'Deuda pública',              'fiscal',     'Emisión de eurobonos, créditos externos, sostenibilidad fiscal.'),
  ('transparencia_fiscal', 'Transparencia fiscal',       'fiscal',     'Acceso a información fiscal, beneficiarios finales, paraísos fiscales.'),

  -- ─── INTERNACIONAL (3) ────────────────────────────────────────────
  ('tratados',             'Tratados y convenios',       'internacional', 'Tratados bilaterales y multilaterales, convenciones, protocolos.'),
  ('politica_exterior',    'Política exterior',          'internacional', 'Cancillería, embajadas, política regional.'),
  ('cooperacion',          'Cooperación internacional',  'internacional', 'AECID, JICA, USAID, cooperación técnica y financiera.'),

  -- ─── SEGURIDAD (3) ────────────────────────────────────────────────
  ('seguridad_publica',    'Seguridad pública',          'seguridad',  'Ministerio de Seguridad Pública, Fuerza Pública, OIJ, policía.'),
  ('narcotrafico',         'Narcotráfico y crimen organizado','seguridad','ICD, ley de psicotrópicos, lavado de activos, decomisos.'),
  ('penitenciario',        'Sistema penitenciario',      'seguridad',  'Ministerio de Justicia y Paz, centros penales, política criminal.')
on conflict (slug) do nothing;

-- Sanity check: el seed debe dejar 51 filas vigentes. No bloqueamos la
-- migration si está corto (re-runs preservan estado), pero un raise notice
-- es útil en logs cuando el SQL editor de Supabase lo aplica.
do $$
declare
  cnt int;
begin
  select count(*) into cnt from cl2_categorias where vigente;
  raise notice 'cl2_categorias vigente count: %', cnt;
end $$;
