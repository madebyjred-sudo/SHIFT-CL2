-- shift-cl2 — RLS hardening for `messages` writes.
--
-- Why: 0001_init only set `using` on the messages policy. For PostgreSQL RLS,
-- `using` filters reads/visibility; INSERT and UPDATE need `with check` to
-- validate the new row state. Without it, a bug or future code path could
-- write a message under a conversation_id the user doesn't own — the FK
-- cascade still works, but RLS doesn't enforce ownership at the row level.
--
-- This migration replaces the all-purpose policy with split SELECT / INSERT /
-- UPDATE / DELETE policies, all anchored on the conversation's user_id.
-- Service-role still bypasses everything (the BFF uses service-role and
-- validates user_id explicitly in conversationStore.ts).
--
-- Apply via Supabase Studio > SQL Editor. Idempotent: safe to re-run.

-- Drop the old all-purpose policy from 0001.
drop policy if exists "users see own messages" on messages;
drop policy if exists "users insert own messages" on messages;
drop policy if exists "users update own messages" on messages;
drop policy if exists "users delete own messages" on messages;

-- SELECT — same join as before.
create policy "users see own messages"
  on messages for select
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- INSERT — validates WHERE the row is going (with check), not WHERE it came from.
create policy "users insert own messages"
  on messages for insert
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- UPDATE — both gates: USING for the visible row, WITH CHECK for the new state.
-- In practice the BFF doesn't update messages, but defense-in-depth.
create policy "users update own messages"
  on messages for update
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- DELETE — explicit, even though `delete cascade` from conversations covers it.
create policy "users delete own messages"
  on messages for delete
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- ── sessions / legislative_chunks ──────────────────────────────────
-- These are read-shared across all authed users (set in 0001). Writes are
-- service-role only by design. Adding explicit deny-write policies makes the
-- intent obvious to anyone reading the schema, instead of relying on
-- "no policy = deny" semantics.

drop policy if exists "deny direct writes on sessions" on sessions;
create policy "deny direct writes on sessions"
  on sessions for insert
  with check (false);

drop policy if exists "deny direct updates on sessions" on sessions;
create policy "deny direct updates on sessions"
  on sessions for update
  using (false);

drop policy if exists "deny direct writes on chunks" on legislative_chunks;
create policy "deny direct writes on chunks"
  on legislative_chunks for insert
  with check (false);

drop policy if exists "deny direct updates on chunks" on legislative_chunks;
create policy "deny direct updates on chunks"
  on legislative_chunks for update
  using (false);
