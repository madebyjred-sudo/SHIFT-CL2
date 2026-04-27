# CL2 Operations Runbook

Audience: solo dev (Jred) running CL2 for 5–10 invited users (Oscar, Rodrigo, despacho staff). Updated 2026-04-27 after the readiness audit.

---

## Hard constraints — read these first

### 1. **Single-replica deployment only.**

The API holds these counters in process memory:
- `apps/api/src/middleware/rateLimit.ts` — per-IP rate limit buckets
- `apps/api/src/routes/publicDemo.ts` — anonymous-demo daily caps
- `apps/api/src/routes/podcasts.ts` — in-flight podcast worker job map

Running 2+ API instances behind a load balancer would split these counters and cap-bypass becomes possible. Until they're moved to Postgres/Redis, **deploy as a single Node process**.

The per-user quotas added in 2026-04-27 (`ai_call_log` table + `aiQuota.ts` service) **do** survive multi-replica because they're DB-backed.

### 2. **CORS env var must be set in production.**

Default: `ALLOWED_ORIGINS=http://localhost:5173`. Override in prod with the real web origin (comma-separated for multiple). Wrong = browser auth requests fail silently. See `apps/api/src/index.ts:39`.

### 3. **OpenRouter + ElevenLabs credentials cap themselves.**

Set tight monthly spend limits on both provider dashboards. Treat these as the **last line of defense** if the per-user quotas break.

---

## Required env vars (production)

### API (`apps/api/.env`)

```bash
# Supabase (DB + auth)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Upstream models
OPENROUTER_API_KEY=sk-or-...
ELEVENLABS_API_KEY=...

# CORS — comma-separated list of allowed web origins
ALLOWED_ORIGINS=https://cl2.shift.cr,https://staging.cl2.shift.cr

# Sentry (recommended for prod, no-op without)
SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENV=production
SENTRY_TRACES_SAMPLE_RATE=0.1

# Per-user daily quotas — override defaults from aiQuota.ts
AI_QUOTA_WORKSPACE_DAILY=200
AI_QUOTA_VOICE_DAILY=60
AI_QUOTA_CHAT_DAILY=200

# Workspace AI model overrides (defaults are MiniMax M2 + Gemini Flash Lite)
TURN_CHAT_MODEL=minimax/minimax-m2
TRANSFORM_EXPAND_MODEL=minimax/minimax-m2

# GCS (for podcasts + transcripts)
GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcp-sa.json
PODCAST_GCS_BUCKET=shift-cl2-podcasts
GCS_BUCKET_AUDIO=sesiones-asamblea-plenario-uc1
GCS_BUCKET_TRANSCRIPTS=sesiones-transcripciones-uc1
GCP_PROJECT_ID=sincere-burner-475520-g7

# Podcast voice IDs (or omit to auto-pick from account)
PODCAST_VOICE_HOST_ID=<id>
PODCAST_VOICE_GUEST_ID=<id>
```

### Web (`apps/web/.env.local`)

```bash
VITE_API_BASE=https://api.cl2.shift.cr
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# Sentry (optional)
VITE_SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
VITE_SENTRY_ENV=production
```

---

## Monitoring

### Health check polling — set up UptimeRobot (or BetterUptime)

The API exposes `/health/deep` which checks Supabase + OpenRouter + ElevenLabs reachability. Wire an uptime monitor:

- **URL**: `https://api.cl2.shift.cr/health/deep`
- **Interval**: 5 min
- **Alert channel**: email/SMS to Jred
- **Expected status**: 200

Without a poll, deep-dependency outages are invisible until a user complains.

### Sentry alerts

- Set up a release on every deploy: `sentry-cli releases new $SHA && sentry-cli releases finalize $SHA`
- Configure alert: any new issue affecting > 1 user in 1 hour → email
- Configure alert: spike of `daily_quota_exhausted` 429s → email (signals we should bump caps OR a user is misbehaving)

### Cost watch — manual until automated

Daily, glance at:
- OpenRouter usage page → spend
- ElevenLabs usage page → characters + minutes
- Supabase project → DB size, egress, function invocations

If you see unexpected spikes, query `ai_call_log`:
```sql
select user_id, route, count(*), date_trunc('hour', created_at) as hr
from ai_call_log
where created_at > now() - interval '24 hours'
group by 1,2,4
order by 3 desc
limit 20;
```

That ranks users by call volume — a runaway client shows up immediately.

---

## Quotas — current defaults

| Route prefix | Daily cap per user | Override env |
|---|---|---|
| `workspace.*` (transform / architect / turn) | 200 | `AI_QUOTA_WORKSPACE_DAILY` |
| `voice.*` (STT) | 60 | `AI_QUOTA_VOICE_DAILY` |
| `chat.*` (`/api/chat/stream`) | 200 | `AI_QUOTA_CHAT_DAILY` |

Counters live in `ai_call_log` (migration 0017). Caps are checked via `requireQuota()` and logged via `logAiCall()` (apps/api/src/services/aiQuota.ts). If the DB read fails the system **fails open** — preferable to locking out legit users on a transient outage.

---

## Recovery scenarios

### "Lexa is silent — chat stream returns nothing"

1. Check `/health/deep` → see which provider is down.
2. Check Sentry → look for `openrouter`, `cerebro`, `elevenlabs` exceptions.
3. If OpenRouter is rate-limiting us globally: bump our priority tier or wait.
4. If ElevenLabs key revoked: re-issue + update env.

### "User says their hojas are gone"

Body content lives in `workspace_nodes.content` JSONB. RLS on the table requires `auth.uid() = user_id`. If a user reports missing data:

1. Confirm they're logged in as the right user (different email = different `user_id`).
2. Query Supabase as service-role:
   ```sql
   select id, title, length(content::text) from workspace_nodes
   where user_id = '<user-uuid>'
   order by updated_at desc limit 20;
   ```
3. If rows are present but the UI shows empty: the content-loading bug from 2026-04-27 (`listNodes` stripping content). Already fixed via `?withContent=1`. Hard-refresh.

### "Podcast stuck at 10% / failed"

- Check `podcasts` table for the row's `status` and `error` columns.
- Check `/tmp/cl2-api.log` for `podcast_worker_*` events.
- Common failures: ElevenLabs rate limit, GCS upload failure, OpenRouter timeout on script gen. Each path logs the upstream message.
- Worst case: `update podcasts set status='cancelled' where id='<id>'` so the user can retry.

### "I need to wipe a user's data"

```sql
-- Hojas + nodes (cascades)
delete from workspaces where user_id = '<uuid>';
-- Podcasts + share tokens (audio in GCS will lifecycle out in 90 days)
delete from podcasts where user_id = '<uuid>';
-- Conversations + messages
delete from conversations where user_id = '<uuid>';
-- AI usage log (optional — keep for billing audit)
-- delete from ai_call_log where user_id = '<uuid>';
```

---

## Backups

Supabase Pro auto-backs up the database daily; 7-day retention. To restore: dashboard → Database → Backups → Restore. Test this **before** you need it.

GCS buckets used by CL2:

| Bucket | Lifecycle | Notes |
|---|---|---|
| `shift-cl2-podcasts` | 90-day TTL on objects | Set via `scripts/setup-podcasts-bucket.sh` |
| `sesiones-asamblea-plenario-uc1` | not set | TODO — apply 365-day archive rule |
| `sesiones-transcripciones-uc1` | not set | TODO — apply 365-day archive rule |
| `workspace-assets` (Supabase Storage) | not set | User-uploaded; consider 1-year |

---

## Deploy checklist

Before bumping the demo URL or inviting more users:

1. ✅ `ALLOWED_ORIGINS` set to real prod web origin (no localhost left over)
2. ✅ `SENTRY_DSN` set in API + web (or accept blind production)
3. ✅ Apply migrations 0001–0017 to prod Supabase
4. ✅ UptimeRobot monitor on `/health/deep`
5. ✅ OpenRouter monthly cap ≤ $200 (matches AI_QUOTA caps × 10 users)
6. ✅ ElevenLabs monthly cap ≤ $100
7. ✅ Single API replica (Railway / Fly / wherever) — confirm autoscaling is OFF
8. ✅ Smoke: log in as test user → chat → create hoja → generate podcast → share link

---

## Known gaps deferred past 5–10 user demo

- Last-write-wins on hoja saves (two-tab conflict). Add optimistic concurrency before going beyond ~20 users.
- No CSRF token on API (relies on JWT bearer + same-site cookies). Fine for SPA bearer-token flow; revisit if cookie auth ever lands.
- No automated tests beyond one Playwright smoke.
- Mobile: canvas + slash menus aren't usable on touch. Marked desktop-only in onboarding copy.
- No GCS lifecycle on legacy audio/transcript buckets (they grow forever).
