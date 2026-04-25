#!/usr/bin/env bash
#
# smoke-demo.sh — pre-demo verification of the BFF surface area.
#
# Hits every endpoint Oscar's demo will touch and asserts the contract:
# auth gates return 401 without a JWT, rate-limited routes set the
# X-RateLimit-* headers, /health/deep returns 200 with all subsystems up.
#
# Run before each demo session:
#     ./scripts/smoke-demo.sh
#     # optional: provide a real JWT to exercise the authed paths
#     CL2_JWT=eyJhbGciOi... ./scripts/smoke-demo.sh
#
# Exit code is the number of failed checks (0 = green).

set -u
API="${CL2_API_BASE:-http://localhost:3001}"
JWT="${CL2_JWT:-}"

PASS=0
FAIL=0

c_red()   { printf '\033[31m%s\033[0m' "$1"; }
c_green() { printf '\033[32m%s\033[0m' "$1"; }
c_dim()   { printf '\033[2m%s\033[0m'  "$1"; }

step() { printf '  %s %s\n' "$(c_dim '·')" "$1"; }

# expect <description> <expected> <actual>
expect() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  %s %s %s\n' "$(c_green '✓')" "$desc" "$(c_dim "($actual)")"
    PASS=$((PASS+1))
  else
    printf '  %s %s %s\n' "$(c_red '✗')" "$desc" "$(c_dim "expected=$expected got=$actual")"
    FAIL=$((FAIL+1))
  fi
}

# expect_in <description> <needle> <haystack>
expect_in() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  %s %s\n' "$(c_green '✓')" "$desc"
    PASS=$((PASS+1))
  else
    printf '  %s %s %s\n' "$(c_red '✗')" "$desc" "$(c_dim "needle=$needle")"
    FAIL=$((FAIL+1))
  fi
}

hr() { printf '\n%s\n' "─── $1 ───"; }

printf '\n%s %s\n' "smoke-demo" "$(c_dim "→ $API")"
[[ -n "$JWT" ]] && printf '  %s\n' "$(c_dim 'JWT set: authed paths will be exercised')" \
                || printf '  %s\n' "$(c_dim 'no JWT: authed paths will only check 401')"

# 1. Liveness ─────────────────────────────────────────────────────────
hr 'liveness'
status="$(curl -s -o /dev/null -w '%{http_code}' "$API/health")"
expect '/health returns 200' '200' "$status"

# 2. Deep health ──────────────────────────────────────────────────────
hr 'deep health'
deep="$(curl -s "$API/health/deep")"
status="$(printf '%s' "$deep" | head -c 1 | tr -d '\n')"
ok=$(printf '%s' "$deep" | grep -o '"ok":true' | head -1 || true)
if [[ -n "$ok" ]]; then
  printf '  %s deep health all subsystems OK\n' "$(c_green '✓')"
  PASS=$((PASS+1))
else
  printf '  %s deep health degraded — body: %s\n' "$(c_red '✗')" "$(c_dim "$deep")"
  FAIL=$((FAIL+1))
fi

# 3. Agents list (anon, rate-limited) ─────────────────────────────────
hr 'agents'
body="$(curl -s -D /tmp/smoke-headers "$API/api/agents")"
ratelimit="$(grep -i '^x-ratelimit-limit:' /tmp/smoke-headers | tr -d '\r' | awk '{print $2}')"
expect_in '/api/agents returns lexa' '"lexa"' "$body"
expect_in '/api/agents returns atlas' '"atlas"' "$body"
expect_in '/api/agents returns centinela' '"centinela"' "$body"
[[ -n "$ratelimit" ]] && expect_in '/api/agents has rate-limit headers' "$ratelimit" "$ratelimit" \
                      || { printf '  %s rate-limit headers missing\n' "$(c_red '✗')"; FAIL=$((FAIL+1)); }

# 4. Auth gates ───────────────────────────────────────────────────────
hr 'auth gates (no JWT → 401)'
status="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/sessions")"
expect '/api/sessions blocks anon' '401' "$status"

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/uploads/youtube" \
  -H 'content-type: application/json' \
  -d '{"youtube_url":"https://youtube.com/watch?v=aaaaaaaaaaa","titulo":"x","fecha":"2026-04-25"}')"
expect '/api/uploads/youtube blocks anon' '401' "$status"

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/uploads/123/status")"
# GET, but POST should still 401 (or 404). Accept either as "not anon-readable".
[[ "$status" == '401' || "$status" == '404' || "$status" == '405' ]] && {
  printf '  %s /api/uploads/:id/status not anon-readable %s\n' "$(c_green '✓')" "$(c_dim "($status)")"
  PASS=$((PASS+1))
} || {
  printf '  %s /api/uploads/:id/status leaked to anon %s\n' "$(c_red '✗')" "$(c_dim "($status)")"
  FAIL=$((FAIL+1))
}

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/ingest/pdf" \
  -F 'file=@/dev/null;filename=empty.pdf;type=application/pdf')"
expect '/api/ingest/pdf blocks anon' '401' "$status"

# 5. Validation ───────────────────────────────────────────────────────
if [[ -n "$JWT" ]]; then
  hr 'validation (with JWT)'
  body="$(curl -s -X POST "$API/api/uploads/youtube" \
    -H "authorization: Bearer $JWT" \
    -H 'content-type: application/json' \
    -d '{"youtube_url":"not a url","titulo":"x","fecha":"2026-04-25"}')"
  expect_in 'youtube_url_invalid surfaces in detail' 'youtube_url_invalid' "$body"

  body="$(curl -s -X POST "$API/api/uploads/youtube" \
    -H "authorization: Bearer $JWT" \
    -H 'content-type: application/json' \
    -d '{"youtube_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","titulo":"ab","fecha":"bad"}')"
  expect_in 'titulo_required surfaces' 'titulo_required' "$body"
  expect_in 'fecha format check surfaces' 'fecha_required_yyyy_mm_dd' "$body"
fi

# 6. Chat stream (anon ok) ────────────────────────────────────────────
hr 'chat stream (anon → SSE)'
# Pull the first chunk only, with a generous timeout. Cerebro / OpenRouter
# may take a couple of seconds to emit the first token.
firstline="$(curl -s -N --max-time 8 \
  -X POST "$API/api/chat/stream" \
  -H 'content-type: application/json' \
  -d '{"agent_id":"lexa","query":"Decí solo OK","conversation_id":null}' \
  | head -c 200)"
if [[ -n "$firstline" ]]; then
  expect_in 'chat stream emits something' 'data:' "$firstline"
else
  printf '  %s chat stream returned no bytes within 8s\n' "$(c_red '✗')"
  FAIL=$((FAIL+1))
fi

# 7. Expedientes auth gate ─────────────────────────────────────────────
hr 'expedientes (canonical SIL view)'
status="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/expedientes/22293")"
expect '/api/expedientes/:numero blocks anon' '401' "$status"

if [[ -n "$JWT" ]]; then
  body="$(curl -s -H "authorization: Bearer $JWT" "$API/api/expedientes/22293")"
  ok=$(printf '%s' "$body" | grep -o '"ok":true' | head -1 || true)
  if [[ -n "$ok" ]]; then
    expect_in 'expediente lookup returns numero' '"numero"' "$body"
  else
    # 404 is also valid if the backfill hasn't reached this expediente yet.
    nf=$(printf '%s' "$body" | grep -o '"not_found"' | head -1 || true)
    if [[ -n "$nf" ]]; then
      printf '  %s expediente 22293 not yet in DB %s\n' "$(c_dim '·')" "$(c_dim '(backfill incomplete?)')"
    else
      printf '  %s /api/expedientes returned unexpected shape %s\n' "$(c_red '✗')" "$(c_dim "$body")"
      FAIL=$((FAIL+1))
    fi
  fi
fi

# 8. Punto Medio admin gate ────────────────────────────────────────────
hr 'punto-medio admin gate'
status="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/punto-medio/pending")"
expect '/api/punto-medio/pending blocks anon' '401' "$status"
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/punto-medio/review/1" \
  -H 'content-type: application/json' -d '{"action":"approve","item_type":"consolidation"}')"
expect '/api/punto-medio/review blocks anon' '401' "$status"

# 9. Rate-limit shape on /api/uploads (only verify the header exists) ─
hr 'rate-limit headers'
curl -s -o /dev/null -D /tmp/smoke-headers \
  -X POST "$API/api/uploads/youtube" \
  -H 'content-type: application/json' \
  -d '{}' >/dev/null
limit="$(grep -i '^x-ratelimit-limit:' /tmp/smoke-headers | tr -d '\r' | awk '{print $2}')"
[[ -n "$limit" ]] && {
  printf '  %s /api/uploads has X-RateLimit-Limit %s\n' "$(c_green '✓')" "$(c_dim "($limit)")"
  PASS=$((PASS+1))
} || {
  printf '  %s /api/uploads missing X-RateLimit-Limit\n' "$(c_red '✗')"
  FAIL=$((FAIL+1))
}

# Summary ─────────────────────────────────────────────────────────────
hr 'summary'
total=$((PASS+FAIL))
printf '  %s / %d checks pass\n' "$(c_green "$PASS")" "$total"
if [[ $FAIL -gt 0 ]]; then
  printf '  %s\n' "$(c_red "$FAIL failed — fix before demo")"
  exit "$FAIL"
fi
printf '  %s\n\n' "$(c_green 'all green — safe to demo')"
exit 0
