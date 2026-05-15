-- 0035_ral_comentado.sql
--
-- Reglamento de la Asamblea Legislativa COMENTADO — Track F, Sprint 1.
--
-- WHY THIS EXISTS:
--   La herramienta search_reglamento ya indexa el RAL plano (texto normativo
--   crudo). El RAL Comentado es cualitativamente diferente: cada artículo e
--   inciso incluye las interpretaciones oficiales de la Presidencia de la
--   Asamblea Legislativa (resoluciones, citas a actas plenarias) y las
--   sentencias de la Sala Constitucional que modulan su aplicación.
--
--   El cliente (CL2 Consultoría, sesión 2026-05-14) pidió explícitamente:
--   "Démosle a la herramienta acceso al RAL Comentado"
--   (pedido 13, min ~47:30 de la transcripción).
--
-- ESTRUCTURA DE TRES TABLAS:
--
--   ral_articulos         — un row por artículo × edición, texto normativo.
--   ral_interpretaciones  — N rows por artículo, cada uno = una interpretación
--                           oficial (resolución de Presidencia, sentencia Sala IV,
--                           criterio de Servicios Técnicos). FK hacia ral_articulos.
--   doctrina_pdfs         — catálogo de los 12 PDFs de doctrina parlamentaria
--                           del Departamento de Servicios Parlamentarios.
--                           Permite trackear re-ingest mensual por hash SHA256.
--
-- RLS:
--   ral_articulos + ral_interpretaciones: lectura para todos los `authenticated`.
--   Escritura solo service_role (el ingest script usa la service role key).
--   doctrina_pdfs: solo service_role (metadata interna de scraping).
--
-- Source: pedidos 13 + 14 del memo 2026-05-14-reunion-cliente-pedidos-en-vivo.md
-- Sprint Design Doc §Track F.
-- Jred 2026-05-14.

-- ─── ral_articulos ─────────────────────────────────────────────────────────────
--
-- Cada fila es un artículo (o un inciso de artículo, cuando se necesita
-- granularidad más fina) del RAL en una edición específica.
--
-- El campo `inciso` es null cuando la fila representa el artículo completo
-- (sin incisos separados o cuando el artículo no tiene incisos).
-- Cuando se populan incisos separados, `numero` = número del artículo padre
-- y `inciso` = '1', '2', '3', etc.
--
-- `edicion` siempre debe ser la edición exacta del PDF de origen ('5ta Edición',
-- '4ta Edición', etc.) para poder deprecar rows cuando salga una nueva edición.
-- `vigente = false` marca artículos reemplazados por edición posterior.

create table if not exists ral_articulos (
  id              uuid        primary key default gen_random_uuid(),

  -- Número del artículo tal como aparece en el RAL. Texto y no int porque
  -- pueden existir artículos con letra (ej. 'TRANSITORIO I').
  numero          text        not null,

  -- Si la fila es un inciso específico, aquí va el ordinal ('1', '2', '3').
  -- null = fila representa el artículo completo sin separación por inciso.
  inciso          text,

  -- Capítulo del RAL al que pertenece el artículo. Texto largo.
  -- Ej: 'Capítulo II — De las sesiones ordinarias y extraordinarias'.
  capitulo        text,

  -- Título de la sección dentro del capítulo (cuando el RAL lo explicita).
  titulo_seccion  text,

  -- Texto normativo completo del artículo o inciso. El extractor del RAL
  -- Comentado saca esto de la sección "ARTÍCULO N.-" del PDF.
  texto_normativo text        not null,

  -- Edición del RAL Comentado. Siempre una de:
  --   '5ta Edición'  ← la más reciente, preferida
  --   '4ta Edición'
  --   'Histórico 1ra Edición'
  --   'Reglamento plano'  (para el RAL plano sin comentarios, si se migra aquí)
  edicion         text        not null,

  -- false cuando una edición más nueva reemplaza este artículo.
  -- El ingest al indexar la 5ta Edición marca como vigente=false
  -- los rows de ediciones anteriores para el mismo numero+inciso.
  vigente         bool        not null default true,

  -- URL pública del PDF de origen (asamblea.go.cr/sd/invest_parlamentarias/...).
  source_pdf      text,

  -- Página del PDF donde aparece este artículo (para la cita con link).
  source_pagina   int,

  -- Estado del proceso de embedding para este artículo.
  -- El continuous embed worker lo pasa de 'pending' → 'embedded'.
  -- 'skipped' = artículo demasiado corto o sin texto útil.
  embed_status    text        not null default 'pending'
                              check (embed_status in ('pending', 'embedded', 'failed', 'skipped')),

  created_at      timestamptz not null default now(),

  -- PK lógica: no puede haber dos rows del mismo artículo+inciso en la misma edición.
  unique (numero, inciso, edicion)
);

-- Para lookup directo por número de artículo ('137', '138', etc.).
create index if not exists ral_articulos_numero_idx
  on ral_articulos (numero);

-- Para queries "dame todos los artículos vigentes" sin full scan.
-- Partial index — solo las filas vigentes — mantiene el índice pequeño.
create index if not exists ral_articulos_vigente_idx
  on ral_articulos (vigente)
  where vigente = true;

-- ─── ral_interpretaciones ──────────────────────────────────────────────────────
--
-- Cada fila es una interpretación oficial adherida a un artículo / inciso.
-- En el RAL Comentado, bajo cada inciso aparecen una o más subsecciones como:
--   "Resoluciones de la Presidencia de la Asamblea Legislativa"
--   "Sala Constitucional"
--   "Departamento de Servicios Técnicos"
-- cada una con una o más resoluciones/sentencias citadas.
--
-- La FK articulo_id -> ral_articulos permite JOIN para el tool de búsqueda.
-- Los campos articulo_numero + articulo_inciso están denormalizados para
-- queries rápidas sin JOIN cuando solo se necesita filtrar por número.

create table if not exists ral_interpretaciones (
  id                    uuid        primary key default gen_random_uuid(),

  -- FK al artículo padre. ON DELETE CASCADE para limpiar automáticamente
  -- cuando se borra/reemplaza una edición del artículo.
  articulo_id           uuid        not null
                          references ral_articulos(id)
                          on delete cascade,

  -- Denormalizados para queries rápidas.
  articulo_numero       text        not null,
  articulo_inciso       text,

  -- Texto completo de la interpretación. Puede ser una o varias oraciones
  -- extraídas del comentario oficial del RAL Comentado.
  texto_interpretacion  text        not null,

  -- Tipo de fuente que emite esta interpretación.
  -- resolucion_presidencia     : resolución de la Presidencia de la Asamblea
  -- sentencia_sala_constitucional: sentencia de la Sala Constitucional (Sala IV)
  -- criterio_servicios_tecnicos: criterio del Departamento de Servicios Técnicos
  -- otro                        : otras fuentes (Procuraduría, doctrina, etc.)
  fuente_tipo           text        not null
                          check (fuente_tipo in (
                            'resolucion_presidencia',
                            'sentencia_sala_constitucional',
                            'criterio_servicios_tecnicos',
                            'otro'
                          )),

  -- Cita textual de la fuente como aparece en el RAL Comentado.
  -- Ej: 'Acta Sesión Plenaria Ordinaria 091 del 01-11-2012, pág. 44'
  -- Ej: 'Voto N° 2019-012345 de la Sala Constitucional'
  fuente_cita           text,

  -- Fecha de la fuente (cuando se puede extraer de la cita).
  fuente_fecha          date,

  -- URL al PDF donde se publicó originalmente la resolución/sentencia.
  -- Puede ser el mismo PDF del RAL Comentado (source_pdf del artículo) o
  -- un PDF separado de la biblioteca de doctrina.
  fuente_pdf            text,

  -- false si la interpretación fue superada por una posterior
  -- (ej. una resolución de la Sala que contradice una anterior de la Presidencia).
  -- El ingest no marca automáticamente esto — lo hace el DRI manualmente
  -- o un futuro validador semántico.
  vigente               bool        not null default true,

  -- Edición del RAL Comentado de la cual se extrajo esta interpretación.
  edicion               text,

  created_at            timestamptz not null default now()
);

-- Índice compuesto para "dame todas las interpretaciones del art. 137, inciso 3".
-- Cubre el 99% de queries del tool search_ral_comentado.
create index if not exists ral_interpretaciones_articulo_idx
  on ral_interpretaciones (articulo_numero, articulo_inciso);

-- Índice para "dame solo las vigentes" cuando se filtra vigente=true.
create index if not exists ral_interpretaciones_vigente_idx
  on ral_interpretaciones (vigente)
  where vigente = true;

-- ─── doctrina_pdfs ─────────────────────────────────────────────────────────────
--
-- Catálogo de los 12 PDFs de doctrina parlamentaria del Departamento de
-- Servicios Parlamentarios de la Asamblea Legislativa.
--
-- Todos son públicos y accesibles sin autenticación desde:
--   https://www.asamblea.go.cr/sd/invest_parlamentarias/
--
-- El campo content_hash (SHA256 del PDF descargado) permite al script de
-- re-ingest detectar si el archivo cambió sin re-descargar y re-parsear
-- todo. Si Last-Modified header coincide Y hash coincide → skip.
--
-- estado:
--   pending    — registrado pero nunca descargado
--   downloaded — descargado, aún no indexado
--   indexed    — parseado, chunkeado e insertado en ral_articulos
--   failed     — falló en algún step (ver notas)
--   stale      — el hash remoto cambió, necesita re-ingest

create table if not exists doctrina_pdfs (
  id                      uuid        primary key default gen_random_uuid(),

  -- Nombre del archivo tal como aparece en la URL (sin path).
  -- Ej: 'Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf'
  nombre_archivo          text        not null unique,

  -- URL pública completa del PDF.
  url_publica             text        not null,

  -- Path en el bucket GCS donde se guarda el PDF descargado.
  -- Ej: 'shift-cl2-sil/doctrina/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf'
  storage_path            text,

  -- SHA256 del binario del PDF, en hex. Para detectar cambios entre runs.
  content_hash            text,

  -- Last-Modified del servidor (header HTTP) en el momento de la última descarga.
  last_modified_remoto    timestamptz,

  -- Cuándo lo descargamos por última vez.
  last_downloaded_at      timestamptz,

  -- Cuándo terminó de indexarse (último update a ral_articulos / ral_interpretaciones).
  last_indexed_at         timestamptz,

  -- Número de páginas del PDF (de pdfjs-dist numPages, para estimaciones).
  paginas                 int,

  -- Estado del procesamiento (ver comentario de tabla).
  estado                  text        not null default 'pending'
                            check (estado in ('pending', 'downloaded', 'indexed', 'failed', 'stale')),

  -- Notas libres: error messages, razones de skip, observaciones del DRI.
  notas                   text,

  created_at              timestamptz not null default now()
);

-- ─── RLS ───────────────────────────────────────────────────────────────────────

alter table ral_articulos       enable row level security;
alter table ral_interpretaciones enable row level security;
alter table doctrina_pdfs       enable row level security;

-- Los consultores de CL2 (authenticated) pueden leer artículos e interpretaciones.
-- El tool search_ral_comentado corre con la clave anon del frontend — necesita select.
create policy "all read ral_articulos"
  on ral_articulos
  for select
  to authenticated
  using (true);

create policy "all read ral_interpretaciones"
  on ral_interpretaciones
  for select
  to authenticated
  using (true);

-- Solo el ingest script (service_role, bypasea RLS) escribe en estas tablas.
-- La policy explícita es defensiva: si alguien llama con un token de usuario,
-- el insert/update/delete falla aunque el script no use RLS check.
create policy "service writes ral_articulos"
  on ral_articulos
  for all
  to authenticated
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service writes ral_interpretaciones"
  on ral_interpretaciones
  for all
  to authenticated
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- doctrina_pdfs es solo metadata de scraping — users no la ven.
-- Sin policy pública de select → solo service_role accede (bypasea RLS).

-- ─── Seed del catálogo de PDFs ─────────────────────────────────────────────────
--
-- Los 12 PDFs de doctrina parlamentaria se registran en doctrina_pdfs al
-- aplicar esta migración. El ingest script los lee de esta tabla para
-- saber qué descargar. Estado inicial = 'pending'.
--
-- BASE URL: https://www.asamblea.go.cr/sd/invest_parlamentarias/

insert into doctrina_pdfs (nombre_archivo, url_publica, notas) values
  (
    'Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
    '5ta Edición — la más reciente. Indexar primero. Chunker: por artículo + inciso con interpretaciones.'
  ),
  (
    'Reglamento_Asamblea_Legislativa_Comentado.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado.pdf',
    'Edición anterior (~9.7 MB, ~295 págs, modificado 12-03-2026). Indexar después de la 5ta Edición.'
  ),
  (
    'ResolucionesPresidencia_2022_2026.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/ResolucionesPresidencia_2022_2026.pdf',
    'Resoluciones de la Presidencia de la Asamblea durante la administración 2022-2026. Chunker: por resolución.'
  ),
  (
    'Inv_03_2026_ResolucionesPresidencia_Abril2026.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv_03_2026_ResolucionesPresidencia_Abril2026.pdf',
    'Resoluciones de la Presidencia — Abril 2026. La más reciente disponible.'
  ),
  (
    'Inv_05_2026_Sentencias_ProcedimientoLegislativo.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv_05_2026_Sentencias_ProcedimientoLegislativo.pdf',
    'Sentencias de la Sala Constitucional sobre procedimiento legislativo. Chunker: heurística POR TANTO.'
  ),
  (
    'Inv_07_2024_ResolucionesPresidencia_Dic2024.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv_07_2024_ResolucionesPresidencia_Dic2024.pdf',
    'Resoluciones de la Presidencia — Diciembre 2024.'
  ),
  (
    'Inv_02_2024Resoluciones.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv_02_2024Resoluciones.pdf',
    'Resoluciones 2024 — compilación del año.'
  ),
  (
    'Inv01_2012_Resoluciones2010_2012.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv01_2012_Resoluciones2010_2012.pdf',
    'Resoluciones históricas 2010-2012. Baja prioridad de ingest.'
  ),
  (
    'Inv01_2014_Resoluciones2010_2014.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Inv01_2014_Resoluciones2010_2014.pdf',
    'Resoluciones históricas 2010-2014 (compilación ampliada). Baja prioridad de ingest.'
  ),
  (
    'TA_01_2019_ResumenReformaRAL.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/TA_01_2019_ResumenReformaRAL.pdf',
    'Resumen de la reforma al RAL de 2019. Chunker: genérico.'
  ),
  (
    'Reglamento_Asamblea_Legislativa_Historico_IEdicion.pdf',
    'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Historico_IEdicion.pdf',
    'RAL Histórico — Primera Edición. Solo relevancia histórica, no normativo hoy.'
  )
on conflict (nombre_archivo) do nothing;

-- ─── Comentarios de tabla ──────────────────────────────────────────────────────

comment on table ral_articulos is
  'Artículos e incisos del Reglamento de la Asamblea Legislativa (RAL) extraídos '
  'del RAL Comentado. Cada fila incluye el texto normativo + referencia a la edición. '
  'La 5ta Edición es la vigente (vigente=true). Las ediciones anteriores se mantienen '
  'como contexto histórico (vigente=false). '
  'Source: Track F, Sprint 1, 2026-05-14.';

comment on table ral_interpretaciones is
  'Interpretaciones oficiales de cada artículo / inciso del RAL. Provienen del '
  'RAL Comentado donde se citan resoluciones de la Presidencia, sentencias de la '
  'Sala Constitucional y criterios de Servicios Técnicos. Cada fila incluye la cita '
  'textual a la fuente (acta plenaria, voto, etc.) para que Lexa pueda citar con '
  'precisión académica. '
  'Source: Track F, Sprint 1, 2026-05-14.';

comment on table doctrina_pdfs is
  'Catálogo de los 12 PDFs de doctrina parlamentaria del Departamento de Servicios '
  'Parlamentarios de la Asamblea Legislativa de Costa Rica. '
  'Todos son públicos y accesibles desde: '
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/ '
  'El campo content_hash (SHA256) permite al re-ingest mensual detectar cambios '
  'sin re-descargar todo (comparar con Last-Modified header + hash local). '
  'Source: pedido 14 (re-ingest mensual), Track F, Sprint 1, 2026-05-14.';
