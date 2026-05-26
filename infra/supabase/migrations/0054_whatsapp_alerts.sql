-- 0054_whatsapp_alerts.sql
--
-- Ronald F3 — Alertas WhatsApp (MVP mocked).
--
-- Scope MVP: schema + service layer + seed data + endpoint API list.
-- DEFER post-Friday: integración real con Twilio WhatsApp Business
-- (requiere ~24-48h de approval del template + sandbox preview).
--
-- Mientras Twilio aprueba, el sender es un mock que loguea + marca
-- status='sent' en DB. La UI muestra alertas como si se hubieran
-- enviado — válido para demo Jueves/Viernes y para que Ronald valide
-- el contenido de los templates antes del go-live real.

begin;

-- ─── cl2_clients: opt-in WhatsApp + lista de triggers ─────────────────
-- whatsapp_priorities jsonb: estructura abierta para que el admin defina
-- qué eventos disparan alerta. Ejemplo:
--   {
--     "expedientes_seguir": ["23.496", "24.819", "25.136"],
--     "comisiones_seguir": ["JURIDICOS (ÁREA VII)"],
--     "keywords_extra": ["medicamentos", "patentes farmacéuticas"],
--     "tipos_alerta": ["expediente_nuevo", "votacion_proxima",
--                      "ley_publicada", "alerta_critica"]
--   }
-- El scanner usa esto + cl2_clients.context_keywords (de F2) como matcher.
alter table cl2_clients
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists whatsapp_priorities jsonb not null default '{}'::jsonb;

-- ─── whatsapp_alerts: cola de alertas ─────────────────────────────────
-- Cada row = una alerta encolada/enviada/fallida.
-- status states:
--   pending  → encolada, esperando que el worker la envíe
--   sent     → enviada exitosamente (mock: con sid sintético; real: Twilio sid)
--   failed   → Twilio rechazó (template inválido, número inválido, etc.)
--   skipped  → opt_out del cliente o expediente ya enviado (dedup)
create table if not exists whatsapp_alerts (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references cl2_clients(id) on delete cascade,
  -- Evento que disparó la alerta. NULL para alertas manuales (admin → "envía esto").
  evento_id        uuid references centinela_eventos(id) on delete set null,
  -- Categoría del template Twilio que se va a usar.
  template_name    text not null,
  -- Variables del template ya renderizadas como mensaje final (lo que el
  -- cliente verá en WhatsApp). Almacenado para auditoría.
  body_text        text not null,
  -- Número destino. Snapshot al momento de encolar (cl2_clients.contact_whatsapp
  -- puede cambiar después).
  contact_whatsapp text not null,
  -- Status del ciclo de vida.
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed', 'skipped')),
  -- Cuándo se debe enviar (default ahora). Permite scheduling futuro.
  scheduled_for    timestamptz not null default now(),
  sent_at          timestamptz,
  -- Twilio Message SID (real) o "mock-<uuid>" (cuando sender mock).
  twilio_sid       text,
  error_message    text,
  -- Dedup key — evita enviar dos alertas idénticas del mismo evento.
  -- Convención: <cliente_id>:<template_name>:<evento_id|context_hash>.
  dedup_key        text not null,
  created_at       timestamptz not null default now()
);

-- Idempotencia: misma dedup_key → no insertamos dos veces.
create unique index if not exists whatsapp_alerts_dedup_idx
  on whatsapp_alerts (dedup_key);

create index if not exists whatsapp_alerts_pending_idx
  on whatsapp_alerts (scheduled_for, status)
  where status = 'pending';

create index if not exists whatsapp_alerts_cliente_idx
  on whatsapp_alerts (cliente_id, created_at desc);

-- RLS: solo admin/operador puede leer la cola completa. cliente (rol F1)
-- puede leer SOLO las alertas de su propio cliente_id.
alter table whatsapp_alerts enable row level security;

create policy "whatsapp_alerts admin select"
  on whatsapp_alerts for select
  using (
    exists (
      select 1 from user_access ua
      where ua.user_id = auth.uid()
        and ua.role in ('admin', 'operador')
    )
  );

create policy "whatsapp_alerts cliente select own"
  on whatsapp_alerts for select
  using (
    exists (
      select 1 from user_access ua
      where ua.user_id = auth.uid()
        and ua.cliente_id = whatsapp_alerts.cliente_id
    )
  );

-- INSERTs solo via service-role (worker/admin) — no policy de INSERT
-- intencional. Igual UPDATE/DELETE (queremos auditoría inmutable).

commit;
