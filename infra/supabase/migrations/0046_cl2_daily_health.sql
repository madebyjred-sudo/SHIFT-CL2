-- 0046_cl2_daily_health.sql
--
-- Tabla de health-check diario. Cada corrida del cron de health
-- escribe una fila aquí con un snapshot del estado del backend.
--
-- Por qué existe:
--   Antes de este cron, detectar que un cron había muerto silenciosamente
--   o que el catálogo había dejado de actualizarse requería que un humano
--   abriera Cloud Logging y revisara cada job. Esta tabla persiste un
--   timeseries de métricas clave + alertas, así un operador puede:
--
--   1. Ver de un golpe qué pasó en los últimos N días con un SELECT.
--   2. Recibir un email/Slack ping cuando `alerts` es no-vacío
--      (alerting hook a futuro — esta migration solo crea la tabla).
--   3. Detectar regresiones (ej. "el cron de transcripts dejó de
--      producir transcript_segments hace 3 días").
--
-- Por qué tabla y no logs estructurados:
--   Los logs en Cloud Logging tienen TTL de 30 días en el free tier y
--   el query language (jsonPayload.field=value) es engorroso para
--   timeseries. Una tabla relacional permite WHERE + ORDER BY trivial
--   y deja una historia inmutable para auditorías.

create table if not exists cl2_daily_health (
  id uuid primary key default gen_random_uuid(),
  taken_at timestamptz not null default now(),

  -- Contadores de tablas principales (snapshot del momento)
  sil_expedientes_count integer,
  sil_documentos_count integer,
  sil_documentos_embedded_count integer,
  sil_proponentes_count integer,
  sil_proponentes_with_fraccion integer,
  sessions_indexed_count integer,
  sessions_pending_count integer,
  sessions_rejected_count integer,
  transcript_segments_count integer,
  legislative_chunks_count integer,
  centinela_eventos_count integer,
  centinela_eventos_last_24h integer,
  diputados_count integer,
  messages_last_24h integer,
  ai_call_log_last_24h integer,

  -- Freshness — última fecha en cada tabla relevante
  sil_expedientes_last_scrape timestamptz,
  sil_documentos_last_create timestamptz,
  sil_proponentes_last_update timestamptz,
  sessions_last_create timestamptz,
  transcript_segments_last_create timestamptz,
  centinela_eventos_last_detect timestamptz,

  -- Cron state (qué crons están enabled vs paused, último run + status)
  cron_state jsonb default '[]'::jsonb,

  -- Alertas detectadas en esta corrida (cada item: {level, code, message, table?, value?})
  -- level: 'info' | 'warning' | 'error'
  alerts jsonb not null default '[]'::jsonb,

  -- Snapshot crudo (todos los counts y freshness en un solo dict para
  -- debugging futuro sin tener que cambiar el schema)
  raw_snapshot jsonb,

  -- Métricas de la propia corrida
  duration_ms integer,
  source text default 'cron'  -- 'cron' | 'manual' | 'test'
);

create index if not exists cl2_daily_health_taken_at_idx
  on cl2_daily_health (taken_at desc);

-- Index sobre alertas no-vacías para queries del estilo "muéstrame los
-- últimos N reportes que tuvieron alertas".
create index if not exists cl2_daily_health_alerts_nonempty_idx
  on cl2_daily_health (taken_at desc)
  where jsonb_array_length(alerts) > 0;

-- RLS: solo service_role escribe; usuarios autenticados leen.
alter table cl2_daily_health enable row level security;

create policy "service_role_write_health" on cl2_daily_health
  for all to service_role using (true) with check (true);

create policy "authenticated_read_health" on cl2_daily_health
  for select to authenticated using (true);
