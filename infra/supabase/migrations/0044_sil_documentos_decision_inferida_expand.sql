-- 0044_sil_documentos_decision_inferida_expand.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Expande el CHECK constraint de `sil_documentos.decision_inferida` para
-- incluir el vocab que pide el cliente sobre dictamenes / resoluciones de
-- proyectos de ley (pedido 12b / 16k):
--
--   • aprobado     — dictamen positivo, recomendación de aprobación.
--   • rechazado    — dictamen negativo, rechazo, inconstitucional al fondo.
--   • archivado    — orden de archivar el expediente sin resolver al fondo.
--   • en_tramite   — devolución a comisión, continuar trámite, audiencias.
--   • indeterminado— LLM no pudo clasificar con confianza.
--
-- El set original (Sala IV: con_lugar, sin_lugar, parcial, etc.) se conserva
-- para no romper backfills históricos. La capa de consumo (Lexa) puede
-- mapear ambos sets en su prompt.
--
-- Origen: pedido cliente — extracción LLM de POR TANTO en 22.427 docs SIL.
-- Job: apps/api/src/jobs/llmEnrichDocs.ts
-- Author: Jred (via Claude Code) — 2026-05-17

alter table sil_documentos
  drop constraint if exists sil_documentos_decision_inferida_check;

alter table sil_documentos
  add constraint sil_documentos_decision_inferida_check
  check (decision_inferida in (
    -- Vocab Sala IV / Procuraduría (legacy, legalDocChunker.ts.inferDecision)
    'con_lugar',
    'sin_lugar',
    'parcial',
    'desestimada',
    'evacuada',
    'rechazada',
    'inconstitucional',
    'inconstitucional_parcial',
    'constitucional',
    -- Vocab proyectos de ley / dictámenes (LLM-classified, pedido 12b/16k)
    'aprobado',
    'rechazado',
    'archivado',
    'en_tramite',
    'indeterminado'
  ));

comment on column sil_documentos.decision_inferida is
  'Sentido inferido de la sección dispositiva. Dos taxonomías conviven: (1) Sala IV/Procuraduría — extraído por regex en legalDocChunker.ts; (2) Dictámenes de proyectos de ley — clasificación LLM en llmEnrichDocs.ts (vocab: aprobado/rechazado/archivado/en_tramite/indeterminado).';
