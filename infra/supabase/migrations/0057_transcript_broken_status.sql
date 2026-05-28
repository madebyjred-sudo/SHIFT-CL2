-- Migration: add 'transcript_broken' to sessions.status check constraint
-- Date: 2026-05-28
-- Reason: sessions with unusable transcripts (all sources failed quality gates)
--         need a distinct status so they don't keep retrying indefinitely.

-- Drop the old check constraint (if it exists with the default name)
alter table sessions
  drop constraint if exists sessions_status_check;

-- Recreate with the new 'transcript_broken' value
alter table sessions
  add constraint sessions_status_check
  check (status in ('pending','processing','indexed','error','transcript_broken'));

-- Add a partial index for quick filtering of broken transcripts
-- (useful for the Session Doctor agent and health dashboards)
create index if not exists idx_sessions_transcript_broken
  on sessions(status)
  where status = 'transcript_broken';
