-- 0031_sharepoint_raw.sql
--
-- Storage neutro para el crawler genérico de SharePoint OData (Track A, Sprint 1).
--
-- WHY TWO TABLES:
--   `sil_sharepoint_raw` — un row por item del SharePoint, payload jsonb intacto.
--   Permite re-parsear a cualquier tabla tipada sin re-crawlear.
--   La PK es (list_id, item_id) — ambos strings porque el GUID del SharePoint
--   a veces viene con llaves `{GUID}` y a veces sin ellas, y el item_id es int
--   en el SharePoint pero lo guardamos como text para evitar conversion bugs.
--
--   `sharepoint_cursors` — un row por lista, guarda el cursor de la última
--   corrida. El crawler lee `last_modified` para el $filter y lo actualiza
--   con el max(Modified) visto en la corrida. Si se interrumpe a mitad,
--   la próxima corrida arranca desde donde quedó.
--
-- RLS: habilitada en ambas, pero solo service_role accede (es metadata de
-- scraping interna; ningún cliente de la app debe tocar esto directo).
--
-- No hay trigger updated_at porque estos registros no se actualizan
-- directamente por usuarios — el crawler los upserta con timestamp propio.
--
-- Source: pedido 10 + §16i del memo 2026-05-14-reunion-cliente-pedidos-en-vivo.md
-- Jred 2026-05-14.

-- ─── Raw storage ──────────────────────────────────────────────────────────

create table if not exists sil_sharepoint_raw (
  -- GUID de la lista en el SharePoint GLCP (puede tener llaves o no).
  -- No usamos uuid nativo porque el formato varía entre endpoints.
  list_id     text        not null,

  -- Id numérico del item en SharePoint, guardado como text por seguridad
  -- de tipos (SharePoint garantiza unicidad dentro de una lista, no global).
  item_id     text        not null,

  -- Title de la lista, denormalizado para debug sin JOIN.
  list_title  text,

  -- Timestamp de cuando el crawler bajó este item. NOT the SharePoint Modified.
  scraped_at  timestamptz not null default now(),

  -- ETag devuelto por SharePoint en el header (cuando disponible).
  -- Nos permite detectar cambios sin comparar todo el payload.
  -- null si el servidor no lo devuelve.
  etag        text,

  -- Payload completo del item tal como lo devuelve OData verbose o nometadata.
  -- Guardamos todo para poder re-parsear cuando el schema de downstream cambie.
  payload     jsonb       not null,

  primary key (list_id, item_id)
);

-- Índice para queries de "dame los últimos N items de esta lista" sin full scan.
create index if not exists sil_sharepoint_raw_list_scraped
  on sil_sharepoint_raw (list_id, scraped_at desc);

-- RLS on, pero sin políticas públicas: solo service_role (bypasea RLS).
alter table sil_sharepoint_raw enable row level security;

-- ─── Cursores de crawler ───────────────────────────────────────────────────

create table if not exists sharepoint_cursors (
  -- GUID de la lista — misma convención que sil_sharepoint_raw.list_id.
  list_id               text        primary key,

  -- Nombre humano de la lista para logs y UI admin.
  list_title            text,

  -- Timestamp del item más reciente visto en la última corrida exitosa.
  -- Se usa para el $filter=Modified gt datetime'<ts>' del próximo delta.
  -- null = aún no corrió nunca, el crawler hace full backfill.
  last_modified         timestamptz,

  -- Cuándo terminó la última corrida (éxito O fallo).
  last_run_at           timestamptz,

  -- Resultado de la última corrida.
  last_run_status       text check (last_run_status in ('ok', 'failed', 'partial')),

  -- Mensaje de error de la última corrida fallida (truncado a 1000 chars en el crawler).
  last_error            text,

  -- Contador acumulado de items procesados (para dashboards de salud).
  items_processed_lifetime bigint default 0 not null
);

alter table sharepoint_cursors enable row level security;

-- Comentario con las 5 listas top que el crawler arranca monitoreando.
-- Los list_id reales se inyectan por env o por seed; acá solo documentamos.
comment on table sharepoint_cursors is
  'Cursor de polling para cada lista GLCP del SharePoint de la Asamblea Legislativa. '
  'Top 5 listas: Ordenes_dia (8103 items), Actas (7277), Consultas_mociones (1071), '
  'Decretos_Ejecutivos_Ampliacion (201), vetos (30). '
  'Se alimenta via crawler-sharepoint.ts en Cloud Run Jobs cada 30 min.';
