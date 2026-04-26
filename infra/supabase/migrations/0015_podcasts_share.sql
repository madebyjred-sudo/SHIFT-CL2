-- shift-cl2 — Podcast share links.
--
-- Lets the user post a podcast to a colleague (or to a journalist's
-- inbox) without forcing the recipient to log in. The share token is
-- the auth: anyone with the URL can play the audio until expiration.
--
-- Surface (apps/api/src/routes/podcasts.ts):
--   POST /api/podcasts/:id/share        → mint token (idempotent)
--   GET  /api/public/podcasts/share/:t  → 302 to short-lived signed URL
--
-- Defaults: 30-day expiration, indefinite views. Owner can rotate.

alter table podcasts add column if not exists share_token uuid;
alter table podcasts add column if not exists share_expires_at timestamptz;
alter table podcasts add column if not exists share_views int not null default 0;

-- One token per podcast — index allows fast lookup on /share/:token.
-- Partial uniqueness: only enforce when token IS NOT NULL (rotating
-- nulls the old, mints fresh).
create unique index if not exists podcasts_share_token_uidx
  on podcasts(share_token)
  where share_token is not null;
