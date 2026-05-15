-- 0033_centinela_eventos_priority.sql
--
-- Track C: Centinela con prioridades estructuradas.
--
-- Crea la tabla `centinela_eventos` — fuente de verdad del crawler único.
-- Cada evento entra aquí una sola vez; el match engine lo cruza contra
-- todas las watchlists y genera alertas por-user en `centinela_alerts_v2`.
--
-- IMPORTANTE: `centinela_alerts` (de 0019_centinela.sql) YA TIENE DATOS
-- y su schema no es compatible con el modelo evento×watchlist (falta event_id
-- y watch_id; usa `severity` en lugar de `priority`; usa dedup_key diferente).
-- Decisión: NO se toca `centinela_alerts`. Se crea `centinela_alerts_v2` como
-- tabla paralela para los eventos del nuevo pipeline.
--
-- TODO (sprint siguiente): migrar datos de centinela_alerts a centinela_alerts_v2
-- si los consultores adoptan el nuevo formato, luego renombrar.
--
-- RLS:
--   centinela_eventos — service_role escribe; authenticated NO puede.
--   centinela_alerts_v2 — service_role escribe; usuario lee/actualiza propias.
--
-- Autor: Jred / Claude Code — 2026-05-14
-- Refs: pedidos 6, 11, 11.bis, §16d del memo 2026-05-14.

-- ═══════════════════════════════════════════════════════════════════════
-- TABLA: centinela_eventos
-- Fuente de verdad compartida (no por-user). Cada evento detectado por el
-- crawler entra acá una sola vez. El match engine lo evalúa contra todos
-- los watches y genera alertas fan-out.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists centinela_eventos (
  id              uuid primary key default gen_random_uuid(),

  event_type      text not null
                  check (event_type in (
                    'orden_dia_publicada',          -- expediente entró a orden del día
                    'cambio_estado',                -- pasó de comisión a plenario, etc.
                    'mocion_fondo_presentada',      -- nueva moción 137/138/177
                    'audiencia_confirmada',          -- alguien va a audiencia técnica
                    'resolucion_sala_constitucional',-- nueva resolución sobre expediente
                    'ley_publicada',                -- salió en La Gaceta
                    'decreto_convocatoria',         -- decreto ejecutivo amplía/retira convocatoria
                    'fecha_dictamen_proxima',       -- N días antes del deadline
                    'plazo_cuatrienal_proximo',     -- expediente cerca de caducar
                    'desviacion_procedimental'      -- regla RAL no cumplida (pedido 14)
                  )),

  -- Prioridad según regla explícita del cliente (pedido 16d):
  --   critical: audiencias confirmadas en exp vigilado
  --   high:     mociones 137/138, decretos ampliación/retiro, votos Sala, ley
  --   medium:   orden del día, cambios estado, fecha_dictamen_proxima
  --   info:     movimientos administrativos
  priority        text not null default 'medium'
                  check (priority in ('critical', 'high', 'medium', 'info')),

  expediente_id   text,
                  -- Número del expediente en formato "24.696".
                  -- Nullable: algunos eventos afectan múltiples (decretos).

  payload         jsonb not null,
                  -- Contenido específico por event_type:
                  --   mocion_fondo_presentada: { articulo: 137|138|177,
                  --     dia_sesion: 'primer'|'segundo'|null,
                  --     fecha_sesion: 'YYYY-MM-DD', documento_url }
                  --   orden_dia_publicada: { organo, fecha_sesion, items[] }
                  --   cambio_estado: { estado_anterior, estado_nuevo, comision }
                  --   audiencia_confirmada: { entidad, fecha, hora, lugar }
                  --   resolucion_sala_constitucional: { por_tanto, decision }
                  --   etc.

  source_url      text,
                  -- URL de origen del evento (para auditoría y cita).

  detected_at     timestamptz not null default now(),

  -- Campos denormalizados para queries rápidas en el match engine.
  -- Evitan JOINs costosos al evaluar contra los ~N watches.
  comision        text,
                  -- 'COMISIÓN DE ASUNTOS JURÍDICOS' etc. Null si no aplica.
  diputado        text,
                  -- Nombre canónico del diputado involucrado (proponente / ponente).
  materia         text
                  -- Materia legislativa (de sil_expedientes.materia si aplica).
);

-- Índices para el match engine y el endpoint de admin
create index if not exists centinela_eventos_expediente_idx
  on centinela_eventos (expediente_id, detected_at desc)
  where expediente_id is not null;

create index if not exists centinela_eventos_priority_idx
  on centinela_eventos (priority, detected_at desc);

create index if not exists centinela_eventos_type_idx
  on centinela_eventos (event_type, detected_at desc);

comment on table centinela_eventos is
  'Fuente de verdad del crawler único. Un row por evento detectado. '
  'El match engine evalúa cada row contra centinela_watchlist y genera '
  'alertas fan-out en centinela_alerts_v2. Shared, no por-user.';


-- ═══════════════════════════════════════════════════════════════════════
-- TABLA: centinela_alerts_v2
-- Materialización por-user del cruce evento×watchlist.
-- El modelo es: un evento → N alertas (una por user que tiene watch match).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists centinela_alerts_v2 (
  id              uuid primary key default gen_random_uuid(),

  user_id         uuid not null references auth.users(id) on delete cascade,

  event_id        uuid not null references centinela_eventos(id) on delete cascade,
                  -- FK al evento que originó esta alerta.

  watch_id        uuid references centinela_watchlist(id) on delete set null,
                  -- FK al watch que matcheó. Nullable: si el watch se borra,
                  -- la alerta se mantiene (set null) para historial.

  priority        text not null
                  check (priority in ('critical', 'high', 'medium', 'info')),
                  -- Copia del evento.priority al momento de inserción.
                  -- Denormalizado para queries rápidas del badge.

  title           text not null,
                  -- e.g. "🔴 Audiencia confirmada — exp 23.511"
                  -- Generado por centinelaMatchEngine.buildAlertTitle()

  body            text not null,
                  -- Descripción legible del evento.

  delivered_at    timestamptz not null default now(),

  read_at         timestamptz,
                  -- NULL = no leída.

  snoozed_until   timestamptz,
                  -- Si está snoozeada, no se muestra hasta esta hora.

  channel         text not null default 'in_app'
                  check (channel in ('in_app', 'email', 'both')),
                  -- Canal de entrega. Expandible sin migración (agregar check).

  -- Dedup: un user no recibe la misma alerta dos veces por el mismo evento.
  -- Necesario porque el match engine puede correr varias veces antes de que
  -- el estado cambie.
  constraint centinela_alerts_v2_user_event_unique
    unique (user_id, event_id)
);

-- Índice primario: badge de no leídas (conteo rápido)
create index if not exists centinela_alerts_v2_unread_idx
  on centinela_alerts_v2 (user_id, delivered_at desc)
  where read_at is null;

-- Índice para la lista completa (incluyendo leídas)
create index if not exists centinela_alerts_v2_all_idx
  on centinela_alerts_v2 (user_id, delivered_at desc);

-- Índice por priority para filtro
create index if not exists centinela_alerts_v2_priority_idx
  on centinela_alerts_v2 (user_id, priority, delivered_at desc)
  where read_at is null;

comment on table centinela_alerts_v2 is
  'Alertas por-user generadas por el match engine al cruzar centinela_eventos '
  'contra centinela_watchlist. Un evento → N alertas (una por usuario afectado). '
  'Dedup por (user_id, event_id). Engine escribe con service_role. '
  'Usuario solo lee y actualiza read_at / snoozed_until.';


-- ═══════════════════════════════════════════════════════════════════════
-- RLS
-- Misma filosofía que 0019_centinela.sql:
--   - service_role bypasses RLS → escribe sin policy.
--   - authenticated: lee y actualiza sus propias filas.
--   - INSERT explícitamente denegado para usuarios normales.
-- ═══════════════════════════════════════════════════════════════════════

alter table centinela_eventos enable row level security;

-- Service_role escribe eventos — no se necesita una policy de insert para
-- service_role (bypasses RLS). La policy para authenticated deniega explícitamente.
drop policy if exists "centinela_eventos deny authenticated write" on centinela_eventos;
create policy "centinela_eventos deny authenticated write"
  on centinela_eventos for insert
  with check (false);

drop policy if exists "centinela_eventos authenticated read" on centinela_eventos;
create policy "centinela_eventos authenticated read"
  on centinela_eventos for select
  using (auth.role() = 'authenticated');
  -- Eventos son datos públicos legislativos. Cualquier user logueado puede leerlos.

alter table centinela_alerts_v2 enable row level security;

drop policy if exists "centinela_alerts_v2 users read own rows" on centinela_alerts_v2;
create policy "centinela_alerts_v2 users read own rows"
  on centinela_alerts_v2 for select
  using (auth.uid() = user_id);

drop policy if exists "centinela_alerts_v2 deny authenticated insert" on centinela_alerts_v2;
create policy "centinela_alerts_v2 deny authenticated insert"
  on centinela_alerts_v2 for insert
  with check (false);

drop policy if exists "centinela_alerts_v2 users update own rows" on centinela_alerts_v2;
create policy "centinela_alerts_v2 users update own rows"
  on centinela_alerts_v2 for update
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
  -- Solo permite actualizar read_at / snoozed_until. Si se necesita granularidad
  -- de columna, reemplazar con SECURITY DEFINER RPC (ver 0019 comentario).
