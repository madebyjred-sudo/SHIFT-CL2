-- 0037_fechas_extraidas_tracking.sql
--
-- Pedido 07 + 16g + 16h del cliente (sesión 2026-05-14):
-- "FECHA ESTIMADA DE DICTAMEN SIEMPRE ESTÁ DENTRO DE LOS DOCUMENTOS Y
-- NORMALMENTE ES TENTATIVA NO OFICIAL PERO ES UN PROCESO QUE ELLOS HACEN
-- MANUAL. PARTE DEL TRABAJO DE REPORTE DE ORDEN DEL DÍA ES ESTO."
-- (Jred citando workflow de Donovan + Carlos, 29:17–30:35).
--
-- También cubre 16h ("esa fecha para dictaminar es un aproximado... puede
-- variar... cada cierto tiempo están recalculando").
--
-- Esta tabla guarda CADA EXTRACCIÓN como una fila separada. La fila más
-- reciente vigente para un expediente+campo se identifica con
-- superseded_by IS NULL. Así tenemos:
--   - Estado actual (último row con superseded_by NULL)
--   - Historial completo de los recálculos (linked list)
--   - Trazabilidad: qué documento + página + método de extracción

create table if not exists sil_expediente_fechas_extraidas (
  id            uuid primary key default gen_random_uuid(),
  expediente_id text not null references sil_expedientes(numero) on delete cascade,
  campo         text not null check (campo in (
    'fecha_dictamen_estimada',    -- "Fecha para dictaminar (ESTIMADA): 8 mayo 2026"
    'fecha_dictamen_primer_plazo',-- variante: primera versión 60 días
    'fecha_dictamen_segundo_plazo',-- variante: prórroga 60 días adicionales
    'fecha_cuatrienal',           -- "Fecha cuatrienal: 15 abril 2029"
    'vence_subcomision',          -- "vence el 25/03/2026"
    'fecha_audiencia_proxima'     -- audiencia inminente extraída del orden del día
  )),
  valor_fecha   date not null,
  valor_texto_original text,      -- "8 de mayo de 2026" — frase tal cual aparece (citable)
  fuente_documento_url text,      -- URL del PDF de donde se extrajo
  fuente_pagina int,
  extraction_method text not null check (extraction_method in ('regex','llm','manual')),
  extraction_confidence numeric check (extraction_confidence between 0 and 1),
  visual_marker text,             -- 'bold' / 'highlighted' / 'plain' — pedido 16g (negrita = mayor confianza)
  extracted_at  timestamptz not null default now(),
  superseded_by uuid references sil_expediente_fechas_extraidas(id),
  -- Cuando superseded_by IS NULL, esta fila es la versión vigente.
  -- Cuando se detecta un cambio, se inserta nueva fila y se actualiza la
  -- anterior con superseded_by = nueva.id.
  superseded_reason text          -- "feriado_recalculado" | "mocion_prorroga" | "vacaciones" | "auto"
);

create index if not exists sil_fechas_expediente_idx
  on sil_expediente_fechas_extraidas (expediente_id, campo, extracted_at desc);

create index if not exists sil_fechas_vigente_idx
  on sil_expediente_fechas_extraidas (expediente_id, campo)
  where superseded_by is null;

-- View con SOLO los valores vigentes por (expediente, campo).
-- El frontend lee de aquí; no necesita preocuparse del historial.
create or replace view sil_expediente_fechas_vigentes as
  select distinct on (expediente_id, campo)
    expediente_id, campo, valor_fecha, valor_texto_original,
    fuente_documento_url, fuente_pagina, extraction_method,
    extraction_confidence, visual_marker, extracted_at
  from sil_expediente_fechas_extraidas
  where superseded_by is null
  order by expediente_id, campo, extracted_at desc;

-- RLS
alter table sil_expediente_fechas_extraidas enable row level security;
create policy "read fechas" on sil_expediente_fechas_extraidas
  for select to authenticated using (true);
create policy "service writes fechas" on sil_expediente_fechas_extraidas
  for all to authenticated using (auth.role() = 'service_role');
