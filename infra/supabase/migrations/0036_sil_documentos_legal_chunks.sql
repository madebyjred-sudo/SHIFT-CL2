-- =====================================================================
-- 0036_sil_documentos_legal_chunks.sql
-- Track G — Heurística "POR TANTO" (Sprint 1 CL2 v3, 2026-05-14)
--
-- Agrega campos a sil_documentos para soportar el chunking inteligente
-- de documentos jurídicos. El chunker extrae encabezado + sección
-- dispositiva, ahorrando ~85% de tokens vs el doc completo.
--
-- Campos nuevos:
--   doc_class         → tipo de documento detectado
--   chunks_strategy   → algoritmo usado (por_tanto | standard | paragrafo)
--   text_resumido     → encabezado + sección dispositiva (skip considerandos)
--   por_tanto_text    → solo la sección dispositiva (POR TANTO / CONCLUSIONES)
--   decision_inferida → sentido inferido de la decisión
-- =====================================================================

alter table sil_documentos
  add column if not exists doc_class text
    default 'generico'
    check (doc_class in (
      'resolucion_sala_constitucional',
      'resolucion_procuraduria',
      'dictamen_comision',
      'sentencia_tribunal',
      'generico'
    )),

  add column if not exists chunks_strategy text
    default 'standard'
    check (chunks_strategy in ('por_tanto', 'standard', 'paragrafo')),

  add column if not exists text_resumido text,

  add column if not exists por_tanto_text text,

  add column if not exists decision_inferida text
    check (decision_inferida in (
      'con_lugar',
      'sin_lugar',
      'parcial',
      'desestimada',
      'evacuada',
      'rechazada',
      'inconstitucional',
      'inconstitucional_parcial',
      'constitucional'
    ));

-- Índice para filtrar por estrategia (útil en re-ingest selectivo)
create index if not exists sil_doc_chunks_strategy_idx
  on sil_documentos(chunks_strategy);

-- Índice para filtrar por clase de documento
create index if not exists sil_doc_class_idx
  on sil_documentos(doc_class);

-- Índice para búsqueda por decisión inferida
create index if not exists sil_doc_decision_idx
  on sil_documentos(decision_inferida)
  where decision_inferida is not null;

comment on column sil_documentos.doc_class is
  'Tipo de documento jurídico detectado por legalDocChunker. generico = no es un documento jurídico con estructura reconocida.';

comment on column sil_documentos.chunks_strategy is
  'Estrategia de chunking aplicada: por_tanto (encabezado + dispositiva), standard (fixed size), paragrafo (por párrafo).';

comment on column sil_documentos.text_resumido is
  'Versión resumida: encabezado + sección dispositiva (POR TANTO / CONCLUSIONES). Omite los considerandos. Ahorra ~85% de tokens.';

comment on column sil_documentos.por_tanto_text is
  'Solo la sección dispositiva del documento (desde el marker POR TANTO / CONCLUSIONES / FALLO hasta el fin). Nulo si no se encontró marker.';

comment on column sil_documentos.decision_inferida is
  'Sentido inferido de la decisión. Nulo si el patrón no fue reconocido.';
