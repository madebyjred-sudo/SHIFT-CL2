-- 0020_workspace_pptx_cache.sql
--
-- Cache the most-recent Gamma generation per workspace so we don't burn
-- credits on duplicate clicks.
--
-- Why a cache: each Gamma generation costs ~3-7 credits and takes 30-60s.
-- Users hit the export button multiple times — to verify the result, to
-- show a colleague, to re-share — and each click should NOT trigger a new
-- generation. Gamma's signed exportUrl is good for ~1 week, so the cache
-- TTL is at most 7 days. We also cap at 1 hour by default so iterations
-- pick up content edits quickly.
--
-- last_pptx shape:
-- {
--   "generationId": "string",
--   "gammaUrl":     "https://gamma.app/docs/...",
--   "exportUrl":    "https://assets.api.gamma.app/...",
--   "generatedAt":  "ISO timestamp",
--   "creditsUsed":  number  -- optional, when Gamma reports it
-- }

alter table if exists workspaces
  add column if not exists last_pptx jsonb;

comment on column workspaces.last_pptx is
  'Most-recent Gamma PPTX generation for this workspace. NULL when never generated. Gamma exportUrl is signed and valid ~7 days; consumers should regenerate if older.';
