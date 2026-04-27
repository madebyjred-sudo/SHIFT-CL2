-- 0016_podcasts_user_prompt.sql
--
-- Adds a free-text directive the user can attach to the podcast
-- generation request. Threaded into the script-gen system prompt under
-- a "DIRECTRIZ DEL USUARIO" block. UI gates input at 140 chars; server
-- caps at 280 (allows Lexa-enhanced prompts up to 2× the manual cap).
--
-- Nullable on purpose — most podcasts won't have one. Empty string is
-- normalized to NULL by the route layer before insert.

alter table podcasts
  add column if not exists user_prompt text;

comment on column podcasts.user_prompt is
  'Optional 140-char (manual) / 280-char (Lexa-enhanced) directive '
  'the user attached to the generation request. Empty/null = standard '
  'script generation. Threaded into the model system prompt.';
