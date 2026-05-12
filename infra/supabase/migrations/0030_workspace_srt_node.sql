-- 0030_workspace_srt_node.sql
--
-- Agrega tipo 'srt' al CHECK constraint de workspace_nodes.type.
--
-- Pedido por Jred 2026-05-12: al enviar una sesión plenaria al workspace,
-- crear un nodo dedicado tipo='srt' (en lugar de una hoja con HTML formateado).
-- El componente frontend renderiza una lista fija con scroll interno, donde
-- el usuario puede:
--   • Ver toda la transcripción sin que crezca el nodo.
--   • Seleccionar segmentos individuales (click) o múltiples (Alt+click).
--   • Copiar la selección al clipboard.
--   • Mandar la selección a Lexa como contexto para preguntar.
--
-- Schema del content:
--   { session_id: "uuid", session_title: "...", session_fecha: "...",
--     youtube_id: "...", session_duration_s: 22074 }
-- Los segments NO se embeben — el frontend los pide al endpoint
-- /api/sessions/:id/transcript al montarse el componente. Esto evita
-- jsonb gigantes (plenarios de 6h tienen 7,900 segments).

alter table workspace_nodes drop constraint if exists workspace_nodes_type_check;

alter table workspace_nodes
  add constraint workspace_nodes_type_check
  check (type in (
    'hoja',
    'note',
    'cite',
    'expediente_ref',
    'image',
    'document',
    'audio',
    'carousel',
    'pptx_asset',
    'docx_asset',
    'podcast_asset',
    'srt'             -- nuevo (2026-05-12)
  ));
