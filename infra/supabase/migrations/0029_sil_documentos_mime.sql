-- shift-cl2 — Agregar mime_type a sil_documentos
--
-- WHY (2026-05-12):
--   El SIL expone para muchos expedientes el texto base SOLO en PDF
--   (no genera DOCX). Nuestro pipeline original asumía DOCX único y
--   tiraba `null` silencioso cuando no había DOCX → 162+ expedientes
--   marcados como "sin doc" cuando en realidad sí tenían texto en PDF.
--
--   A partir de 0029, sil_documentos guarda el mime_type real. La UI
--   y el LLM pueden distinguir formato (informativo). Filas históricas
--   quedan con mime_type=null → asumir DOCX si gcs_path termina en .docx.
--
-- IDEMPOTENT.

alter table sil_documentos
  add column if not exists mime_type text;

comment on column sil_documentos.mime_type is
  'MIME type del documento original. Valores esperados: '
  '"application/vnd.openxmlformats-officedocument.wordprocessingml.document" (DOCX) '
  'o "application/pdf" (PDF). Filas pre-0029 quedan NULL — el pipeline '
  'asume DOCX cuando el gcs_path termina en .docx. Nuevas filas siempre '
  'deben setear este campo desde el bulk downloader.';
