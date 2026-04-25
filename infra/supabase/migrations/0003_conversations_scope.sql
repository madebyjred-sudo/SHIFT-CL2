-- shift-cl2 — conversations scope
--
-- Adds an optional binding from a conversation to a legacy plenaria id
-- (the integer `id` from agentescl2.com/api/users/transcripciones).
--
-- Why: when the user starts a chat from /sesiones/:id, we want every
-- subsequent turn in that thread to know which session it's about — so
-- the BFF can inject session metadata as a system message instead of
-- stuffing it into messages.content (the duct-tape we're replacing).
--
-- See docs/issues/001-session-scoped-chat-production.md.

alter table conversations
  add column if not exists scope_legacy_session_id integer;

-- Sidebar groups "scoped" chats above "general" chats; this index supports
-- the per-user, per-session lookups used to render those groups.
create index if not exists conversations_scope_idx
  on conversations(user_id, scope_legacy_session_id, updated_at desc)
  where scope_legacy_session_id is not null;
