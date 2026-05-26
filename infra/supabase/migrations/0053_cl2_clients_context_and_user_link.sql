-- 0053_cl2_clients_context_and_user_link.sql
--
-- Ronald F2 — Personalización del cliente.
--
-- Agrega contexto narrativo + keywords a cl2_clients, y vincula
-- user_access ↔ cl2_clients para que el chat pueda inyectar el contexto
-- automáticamente cuando un user 'cliente' (rol F1) loguea.
--
-- Decision sobre formato del contexto:
--   El correo a Carlos respondiendo (2026-05-26) recomendó híbrido:
--   prosa rica (narrativa con expedientes seed, actores políticos,
--   eventos recientes) + bloque de keywords explícitas. La prosa va al
--   chat de Lexa/Atlas; los keywords alimentan el matcher de Centinela.
--
-- Lo que NO incluye este migration (defer a F2 Phase 2E o F3):
--   - uploaded_docs jsonb (pipeline embed → legislative_chunks)
--   - whatsapp_priorities (F3)
--   - Ingest scripts para docs adjuntos
--
-- Idempotencia: ADD COLUMN IF NOT EXISTS. Si se re-corre, no falla.

begin;

-- Contexto narrativo: prosa rica (~3-5 párrafos) que Lexa consume como
-- system prefix cuando el user asociado a este cliente chatea.
alter table cl2_clients
  add column if not exists context_prompt text;

-- Keywords explícitas: complementa la prosa, sirve al matcher de Centinela
-- para alertas de coincidencia directa con expedientes nuevos.
-- text[] permite GIN index si se hace masivo después; ahora <100 clients.
alter table cl2_clients
  add column if not exists context_keywords text[] default array[]::text[];

-- Placeholder para Phase 2E (post-Friday): docs subidos por admin que
-- van por pipeline de embed → legislative_chunks. Cada elemento:
--   { file_name: text, gcs_path: text, uploaded_at: timestamptz,
--     embed_status: 'pending' | 'embedded' | 'failed' }
alter table cl2_clients
  add column if not exists uploaded_docs jsonb not null default '[]'::jsonb;

-- Link user → cliente. Cada user puede estar asociado a EXACTAMENTE un
-- cliente (un asesor de FEDEFARMA es persona; FEDEFARMA es el cliente).
-- Si un asesor maneja varios clientes, debe loguear con cuentas separadas.
-- Trade-off conocido: simplifica F2; futura migración a M:N si hace falta.
alter table user_access
  add column if not exists cliente_id uuid references cl2_clients(id) on delete set null;

create index if not exists user_access_cliente_id_idx
  on user_access (cliente_id)
  where cliente_id is not null;

commit;
