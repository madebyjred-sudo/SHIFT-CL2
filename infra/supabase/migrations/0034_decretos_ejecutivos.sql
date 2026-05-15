-- 0034_decretos_ejecutivos.sql
--
-- Decretos ejecutivos de la Presidencia que amplían o retiran expedientes
-- de la convocatoria del Plenario durante sesiones extraordinarias.
--
-- CONTEXTO POLÍTICO (Carlos Villalobos, sesión 2026-05-14, min 38:35):
--   Durante sesiones extraordinarias (mayo-jul + nov-ene = 6 meses al año),
--   la Presidenta de la República tiene discrecionalidad total para convocar
--   o retirar expedientes de la agenda del Plenario vía decreto ejecutivo.
--   De los ~3,500 expedientes activos en la Asamblea, solo los incluidos en
--   decretos de ampliación vigentes pueden discutirse en cada período.
--   La lista puede cambiar varias veces por día hábil.
--
-- FUENTE SharePoint GLCP:
--   Lista: /glcp/Decretos_Ejecutivos_Ampliacion/Forms/AllDocs.aspx
--   ListId: 39be6869-1d4a-4c78-9efd-b495ef45322e
--   201 items (a 2026-05-14). Organizada en carpetas por Legislatura + Período.
--   Cada item es un PDF del decreto.
--
-- WHY TWO TABLES:
--   `decretos_ejecutivos` — un row por decreto. Contiene el PDF source +
--   metadata extraída por el parser. Tipo puede ser ampliacion, retiro, o mixto.
--
--   `sil_expediente_convocatoria` — tabla de hechos: qué decretos afectaron
--   a qué expedientes. Permite reconstruir el historial completo de
--   convocatorias + calcular quién está vivo HOY con una view materializada.
--
-- View `estado_plenario_actual` — snapshot del estado vigente de cada
--   expediente: el estado es el de su ÚLTIMO decreto. Útil para el
--   dashboard "Estado del Plenario" y para que Lexa filtre el catálogo
--   a solo los expedientes que PUEDEN discutirse ahora.
--
-- RLS: autenticados pueden leer. Escritura solo service_role (crawler + parser).
--
-- Source: Track D Sprint 1, §16i reunión cliente 2026-05-14.
-- Jred 2026-05-14.

-- ─── Tabla principal: decretos ──────────────────────────────────────────────

create table if not exists decretos_ejecutivos (
  id                    uuid        primary key default gen_random_uuid(),

  -- Número oficial del decreto (ej: "DE-40-2026" o "Nro. 14518-MP").
  -- null cuando el parser no pudo extraerlo (manual_review flag se activa).
  numero_decreto        text,

  -- Fecha de emisión del decreto (campo obligatorio — siempre extraíble).
  fecha                 date        not null,

  -- Tipo de acción:
  --   'ampliacion' → agrega expedientes a la convocatoria activa
  --   'retiro'     → saca expedientes de la convocatoria
  --   'mixto'      → hace ambas en el mismo decreto (infrecuente pero válido)
  tipo                  text        not null
    check (tipo in ('ampliacion', 'retiro', 'mixto')),

  -- Período legislativo al que aplica el decreto.
  -- Ejemplo: 'PRIMERA LEGISLATURA 2026-2027, PRIMER PERÍODO SESIONES EXTRAORDINARIAS'
  -- null cuando el decreto no especifica período (poco frecuente en decretos CR).
  periodo_legislativo   text,

  -- URL pública del PDF en el SharePoint GLCP (FileRef del item OData).
  -- Siempre presente (es la fuente primaria del decreto).
  documento_url         text        not null,

  -- Path en el storage de Supabase si copiamos el PDF (opcional — futuro).
  documento_storage_path text,

  -- Id del item en SharePoint (itemId de sil_sharepoint_raw). Unique constraint
  -- evita duplicar decretos si el crawler corre varias veces.
  sharepoint_item_id    text        unique,

  -- Payload jsonb completo del item SharePoint (para re-parsear si cambia el schema).
  raw                   jsonb,

  -- Cuándo se procesó con el parser (null = aún pendiente).
  procesado_at          timestamptz,

  -- Estado del parser:
  --   'pending'         → no procesado aún
  --   'in_progress'     → procesando ahora (lock optimista)
  --   'done'            → parseado correctamente
  --   'failed'          → error duro (ver parser_error)
  --   'manual_review'   → baja confianza, requiere revisión humana
  parser_status         text        not null default 'pending'
    check (parser_status in ('pending', 'in_progress', 'done', 'failed', 'manual_review')),

  -- Mensaje de error del parser (truncado a 2000 chars). null si parser_status != 'failed'.
  parser_error          text,

  created_at            timestamptz not null default now()
);

-- Índice principal para queries de "decretos recientes" (dashboard, crawler delta).
create index if not exists decretos_ejecutivos_fecha_idx
  on decretos_ejecutivos (fecha desc);

-- Índice para filtrar por período legislativo (útil para sesiones extraordinarias actuales).
create index if not exists decretos_ejecutivos_periodo_idx
  on decretos_ejecutivos (periodo_legislativo)
  where periodo_legislativo is not null;

-- Índice para el worker que busca decretos pendientes de procesar.
create index if not exists decretos_ejecutivos_parser_status_idx
  on decretos_ejecutivos (parser_status)
  where parser_status in ('pending', 'failed');

comment on table decretos_ejecutivos is
  'Decretos ejecutivos de la Presidencia que amplían o retiran expedientes de la '
  'agenda del Plenario durante sesiones extraordinarias (mayo-jul + nov-ene). '
  'Source: SharePoint GLCP, lista Decretos_Ejecutivos_Ampliacion (ListId: 39be6869-1d4a-4c78-9efd-b495ef45322e). '
  'Crawler corre cada 30 min; parser extrae expedientes del PDF vía regex + LLM fallback.';

-- ─── Tabla de hechos: qué expedientes afectó cada decreto ──────────────────

create table if not exists sil_expediente_convocatoria (
  id               uuid        primary key default gen_random_uuid(),

  -- Número del expediente (FK a sil_expedientes.numero que es text en ese schema).
  -- No usamos FK con on delete cascade porque sil_expedientes puede tener gaps
  -- y no queremos que un expediente no-importado aún bloquee la inserción.
  expediente_id    text        not null,

  -- El decreto que generó este evento de convocatoria/retiro.
  decreto_id       uuid        not null references decretos_ejecutivos (id) on delete cascade,

  -- Fecha del decreto (denormalizada para queries sin JOIN a decretos_ejecutivos).
  fecha_decreto    date        not null,

  -- Acción específica para este expediente en este decreto.
  --   'convocado' → el decreto lo agrega a la agenda activa
  --   'retirado'  → el decreto lo saca de la agenda activa
  accion           text        not null
    check (accion in ('convocado', 'retirado')),

  -- Estado calculado: ¿este expediente sigue vigente en la convocatoria AHORA?
  -- true  → la última acción registrada es 'convocado' Y estamos en el período.
  -- false → fue retirado por un decreto posterior, o venció el período.
  -- El ingestor actualiza este campo en cada decreto nuevo:
  --   1. Marca sigue_vigente=false en todos los rows anteriores del mismo expediente.
  --   2. Inserta el nuevo row con sigue_vigente=true (o false si accion='retirado').
  sigue_vigente    bool        not null default true,

  created_at       timestamptz not null default now()
);

-- Índice principal: historial de convocatoria por expediente (más reciente primero).
create index if not exists sil_expediente_convocatoria_expediente_idx
  on sil_expediente_convocatoria (expediente_id, fecha_decreto desc);

-- Índice para el dashboard: expedientes vivos HOY (filtered index — solo sigue_vigente=true).
create index if not exists sil_expediente_convocatoria_vigentes_idx
  on sil_expediente_convocatoria (fecha_decreto desc)
  where sigue_vigente = true;

-- Índice compuesto para match engine: ¿este expediente está vivo y fue convocado?
create index if not exists sil_expediente_convocatoria_vivos_accion_idx
  on sil_expediente_convocatoria (expediente_id)
  where sigue_vigente = true and accion = 'convocado';

comment on table sil_expediente_convocatoria is
  'Registro histórico de qué decretos ejecutivos afectaron a qué expedientes (convocado / retirado). '
  'sigue_vigente=true en el row más reciente indica que el expediente está en la agenda activa del Plenario. '
  'Actualizado por decretoIngestor.ts con cada decreto nuevo procesado.';

-- ─── View: estado actual del Plenario ──────────────────────────────────────

-- DISTINCT ON (expediente_id) ordered by fecha_decreto desc → el último decreto
-- que afectó a cada expediente. Si sigue_vigente=true Y accion='convocado' → vivo.
create or replace view estado_plenario_actual as
  select distinct on (expediente_id)
    expediente_id,
    decreto_id,
    fecha_decreto,
    accion,
    sigue_vigente,
    created_at
  from sil_expediente_convocatoria
  order by expediente_id, fecha_decreto desc, created_at desc;

comment on view estado_plenario_actual is
  'Snapshot del estado de convocatoria actual por expediente: muestra el resultado '
  'del último decreto que lo mencionó. Consultar WHERE sigue_vigente=true AND accion=''convocado'' '
  'para obtener los expedientes que PUEDEN discutirse HOY en el Plenario.';

-- ─── RLS ────────────────────────────────────────────────────────────────────

alter table decretos_ejecutivos          enable row level security;
alter table sil_expediente_convocatoria  enable row level security;

-- Usuarios autenticados pueden leer (read-only — escritura solo service_role).
create policy "authenticated users can read decretos"
  on decretos_ejecutivos for select
  to authenticated
  using (true);

create policy "authenticated users can read convocatoria"
  on sil_expediente_convocatoria for select
  to authenticated
  using (true);

-- service_role bypasea RLS para el crawler + parser (sin políticas explícitas
-- necesarias — Postgres service_role bypass es automático).
