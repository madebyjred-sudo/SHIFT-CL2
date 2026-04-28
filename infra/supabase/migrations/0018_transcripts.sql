-- 0018_transcripts.sql
--
-- Schema substrate for the YouTube transcript pipeline (Fase 0).
-- Replaces the ElevenLabs JSON-in-GCS pipeline with a zero-cost YouTube
-- native-transcript source + an LLM correction pass (Sonnet 4.6).
--
-- WHY three changes, not one big table:
--
--   1. sessions gets four new columns so the pipeline can track provenance
--      (source), the YouTube video ID (for re-fetching / deduplication),
--      and when the LLM review finished (for SLA monitoring).
--
--   2. transcript_segments is an IMMUTABLE log of exactly what YouTube
--      returned. It is NEVER updated after insert — it is the legal
--      source of truth (equivalent to ElevenLabs' raw JSONs in GCS).
--      Downstream jobs read from it; they never touch it.
--
--   3. transcript_corrections is a pure ANNOTATION LAYER. The LLM suggests
--      edits; a human (or auto-accept logic) approves/rejects them.
--      The indexer applies accepted corrections inline to the chunk text
--      before embedding, but the raw segments remain untouched. This
--      preserves auditability: you can always reconstruct "what YouTube
--      said" vs "what we published to the RAG corpus".
--
-- RLS pattern (same as sessions + legislative_chunks in 0001/0004):
--   - SELECT: any authenticated user (transcript data is public legislative record)
--   - INSERT/UPDATE: service_role only (pipeline jobs run with the service key)
--   - Explicit deny-write policies for authenticated role so intent is
--     self-documenting, instead of relying on "no policy = deny".
--
-- This migration is idempotent (all CREATE/ALTER use IF NOT EXISTS).

-- =====================================================
-- 1. sessions — add pipeline provenance columns
-- =====================================================
-- Only adds columns; never drops. Existing rows will have
-- source='youtube' (the default) which is a reasonable fallback
-- since most active sessions will be YouTube-sourced going forward.
-- ElevenLabs legacy sessions should be back-filled manually via the
-- admin endpoint if needed — not automated here.

alter table sessions
  add column if not exists source text default 'youtube';
  -- 'youtube' | 'elevenlabs_legacy'
  -- Distinguishes new YouTube pipeline sessions from the March/April
  -- ElevenLabs batch. Used by the admin UI to filter and by the
  -- indexer to route chunking logic.

-- Add the check separately so we can use a named constraint with idempotency.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_source_check'
  ) then
    alter table sessions
      add constraint sessions_source_check
      check (source in ('youtube', 'elevenlabs_legacy'));
  end if;
end $$;

alter table sessions
  add column if not exists youtube_video_id text;
  -- Nullable. Set by the youtube-sync job when a session is created
  -- from a YouTube video. Used for deduplication (if this id already
  -- has a session row, skip) and for re-fetch on force-reprocess.

alter table sessions
  add column if not exists llm_reviewed_at timestamptz;
  -- Nullable. Stamped by the transcript-process job when the LLM
  -- review pass completes successfully. NULL means either the session
  -- hasn't been reviewed yet, or it's an elevenlabs_legacy session
  -- that predates the pipeline.

alter table sessions
  add column if not exists llm_review_model text;
  -- Nullable. Records which model ran the review (e.g.
  -- 'anthropic/claude-sonnet-4-6'). Useful when we A/B different
  -- models and need to filter corrections by model quality in evals.

-- =====================================================
-- 2. transcript_segments — raw YouTube transcript
-- =====================================================
-- One row per time-coded chunk from the YouTube transcript API.
-- Typically 3-8 seconds per segment for legislative sessions.
--
-- IMMUTABILITY CONTRACT: once inserted, this table is never modified.
-- Updates belong in transcript_corrections. This is enforced at the
-- RLS level (deny UPDATE for authenticated) and should also be
-- enforced at the application level in the Cloud Run job.
--
-- segment_idx is the sequential position within the session's
-- transcript, 0-based. (session_id, segment_idx) is the natural
-- composite key used by the LLM review job to reference segments.

create table if not exists transcript_segments (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
                  -- Cascade delete: if a session is purged, its raw
                  -- transcript goes with it. Segment data without a
                  -- session is meaningless.
  segment_idx     int not null,                    -- 0-based sequential order within session
  start_seconds   numeric(10,3) not null,          -- timecode from YouTube (e.g. 1234.567)
  end_seconds     numeric(10,3) not null,          -- timecode from YouTube
  text            text not null,                   -- raw transcript text, exactly as YouTube returned it
  source          text not null default 'youtube_auto',
                  -- 'youtube_auto' = YouTube auto-generated caption
                  -- Extensible if we ever add manual or ASR sources
  created_at      timestamptz not null default now()
);

-- Unique composite index: (session_id, segment_idx) is the natural
-- composite key used by the LLM review job to reference segments.
-- The unique index covers range scans and lookups, making a separate
-- non-unique index redundant.
create unique index if not exists transcript_segments_session_segment_unique
  on transcript_segments (session_id, segment_idx);

-- RLS
alter table transcript_segments enable row level security;

drop policy if exists "authed users read transcript_segments" on transcript_segments;
create policy "authed users read transcript_segments"
  on transcript_segments for select
  using (auth.role() = 'authenticated');
  -- Transcripts are public legislative record; any logged-in user can read.

drop policy if exists "deny direct writes on transcript_segments" on transcript_segments;
create policy "deny direct writes on transcript_segments"
  on transcript_segments for insert
  with check (false);
  -- Service role bypasses RLS. Authenticated users should never insert
  -- directly — writes come only from the Cloud Run pipeline job.

drop policy if exists "deny direct updates on transcript_segments" on transcript_segments;
create policy "deny direct updates on transcript_segments"
  on transcript_segments for update
  using (false);
  -- Enforces the immutability contract at the DB level. Corrections
  -- live in transcript_corrections, not here.

comment on table transcript_segments is
  'Immutable raw transcript from YouTube, one row per time-coded segment. '
  'Never modified after insert — legal source of truth for what YouTube '
  'returned. Corrections are stored separately in transcript_corrections.';

-- =====================================================
-- 3. transcript_corrections — LLM annotation layer
-- =====================================================
-- One row per correction suggested by the LLM review pass.
-- Corrections reference a specific character span within
-- transcript_segments.text (span_start..span_end, 0-based char offsets).
--
-- The indexer applies accepted corrections inline when building
-- legislative_chunks — but it always reads from transcript_segments
-- as the base text, patches accepted corrections, and embeds the
-- result. This means corrections are reversible at any time without
-- touching the raw transcript.
--
-- human_review default is 'pending'. The admin UI lets Jred accept/
-- reject individual corrections before (or after) embedding. The
-- pipeline can be configured to auto-accept high-confidence
-- corrections (confidence >= 0.90) without waiting for human review.

create table if not exists transcript_corrections (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
  segment_id      uuid not null references transcript_segments(id) on delete cascade,

  -- What kind of correction this is. Drives UI highlighting color and
  -- downstream logic (e.g. expediente corrections trigger extra
  -- validation against the known expediente registry).
  kind            text not null check (kind in (
    'typo_diputado',        -- Diputado name misspelled by YouTube ASR
    'typo_expediente',      -- Expediente number malformatted (e.g. "veinticuatro mil" → "24.429")
    'typo_legislativo',     -- Legislative term misspelled (e.g. "discamen" → "dictamen")
    'gap_filled',           -- Inaudible gap inferred from context (only when confidence is high)
    'punctuation',          -- Missing punctuation that changes readability
    'speaker_attribution'   -- (future) attributes a segment to a specific diputado
  )),

  -- Character offsets within transcript_segments.text (0-based, exclusive end).
  -- span_start == span_end means an insertion (no original text replaced).
  span_start      int not null,
  span_end        int not null,

  original_text   text not null,     -- exactly what YouTube transcribed in this span
  suggested_text  text not null,     -- what the LLM recommends instead

  confidence      numeric(3,2) not null
                  check (confidence >= 0.00 and confidence <= 1.00),
                  -- 0.00–1.00. The indexer auto-accepts if >= configured threshold.
                  -- Low-confidence corrections are held for human review.

  reasoning       text,              -- LLM's explanation of why this correction is warranted.
                                     -- Nullable; some corrections are mechanical (punctuation).

  -- Human review state. Default 'pending' means the correction exists
  -- but hasn't been acted on yet. The indexer can be configured to
  -- treat 'pending' high-confidence corrections as implicitly accepted.
  human_review    text not null default 'pending'
                  check (human_review in ('pending', 'accepted', 'rejected')),

  reviewed_by     uuid references auth.users(id),
                  -- Nullable: set when a human explicitly accepts/rejects.
                  -- NULL if auto-accepted by the pipeline.
  reviewed_at     timestamptz,       -- When the review decision was made.

  -- Provenance: which model created this correction, and which batch run.
  model           text not null,     -- e.g. 'anthropic/claude-sonnet-4-6'
  llm_run_id      uuid not null,     -- Groups all corrections from a single LLM call.
                                     -- Useful for "revert entire run" operations.
                                     -- Pipeline always sets this; nullable would silently
                                     -- break the revert-by-run feature on manual imports.

  created_at      timestamptz not null default now()
);
-- Note: no updated_at column / trigger. The only update path is human
-- review (accept/reject), which writes reviewed_at + reviewed_by
-- explicitly. That doubles as the "last touched" timestamp.

-- session_id index: admin UI queries all corrections for a session,
-- and the indexer reads all accepted corrections per session for chunking.
create index if not exists transcript_corrections_session_idx
  on transcript_corrections (session_id);

-- llm_run_id index: supports "show me everything from run X" and
-- bulk-accept / bulk-reject operations in the admin UI.
create index if not exists transcript_corrections_run_idx
  on transcript_corrections (llm_run_id);

-- RLS
alter table transcript_corrections enable row level security;

drop policy if exists "authed users read transcript_corrections" on transcript_corrections;
create policy "authed users read transcript_corrections"
  on transcript_corrections for select
  using (auth.role() = 'authenticated');
  -- Corrections are part of the public legislative record annotation layer.
  -- Any logged-in user can read them (admin UI, future public diff view).

drop policy if exists "deny direct writes on transcript_corrections" on transcript_corrections;
create policy "deny direct writes on transcript_corrections"
  on transcript_corrections for insert
  with check (false);
  -- Service role bypasses RLS. Only the LLM review Cloud Run job inserts.

drop policy if exists "deny direct updates on transcript_corrections" on transcript_corrections;
create policy "deny direct updates on transcript_corrections"
  on transcript_corrections for update
  using (false);
  -- Updates (accept/reject) go through a service-role RPC / admin endpoint,
  -- not direct table writes from the client. This prevents the UI from
  -- accidentally bulk-updating rows without going through validation logic.

comment on table transcript_corrections is
  'LLM-suggested corrections over transcript_segments. Pure annotation layer — '
  'never rewrites segments. The indexer applies accepted corrections inline '
  'when building legislative_chunks. human_review tracks Jred accept/reject '
  'decisions from the admin UI.';
