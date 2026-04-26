#!/usr/bin/env bash
# setup-podcasts-bucket.sh — one-shot GCS bucket provisioning for the
# podcast pipeline.
#
# Creates the bucket if absent, sets a permissive-but-bounded CORS
# policy (so the SPA's <audio> tag can fetch signed URLs cross-origin),
# and applies a 90-day lifecycle rule so old podcasts don't pile up
# storage cost forever.
#
# Run once per environment. Idempotent — safe to re-run.
#
# Requires: gcloud CLI authenticated as a principal with
# `storage.buckets.create` + `storage.buckets.update` on the project.
#
# Usage:
#   PODCAST_GCS_BUCKET=shift-cl2-podcasts \
#   GCS_REGION=us-central1 \
#   bash scripts/setup-podcasts-bucket.sh

set -euo pipefail

BUCKET="${PODCAST_GCS_BUCKET:-shift-cl2-podcasts}"
REGION="${GCS_REGION:-us-central1}"
PROJECT="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"

if [[ -z "$PROJECT" ]]; then
  echo "✗ GCP_PROJECT_ID not set and gcloud has no active project."
  echo "  → set with: gcloud config set project <id>"
  exit 1
fi

echo "▸ project: $PROJECT"
echo "▸ bucket:  gs://$BUCKET"
echo "▸ region:  $REGION"
echo

# 1. Create bucket if it doesn't exist.
if gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "✓ bucket exists, skipping create"
else
  echo "+ creating bucket..."
  gcloud storage buckets create "gs://$BUCKET" \
    --project "$PROJECT" \
    --location "$REGION" \
    --uniform-bucket-level-access
  echo "✓ created"
fi

# 2. CORS — needed for browser <audio> + fetch() to read signed URLs.
#    Origins kept narrow on purpose: localhost dev + the canonical
#    public host. Add more domains via env if you serve from CDN edges.
echo "+ applying CORS..."
ORIGINS_JSON=$(cat <<EOF
[
  {
    "origin": [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://agentescl2.com",
      "https://www.agentescl2.com",
      "https://app.agentescl2.com"
    ],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Accept-Ranges", "Content-Length"],
    "maxAgeSeconds": 3600
  }
]
EOF
)
TMPFILE=$(mktemp)
echo "$ORIGINS_JSON" > "$TMPFILE"
gcloud storage buckets update "gs://$BUCKET" --cors-file="$TMPFILE" >/dev/null
rm -f "$TMPFILE"
echo "✓ CORS applied"

# 3. Lifecycle — purge after 90 days. Demo cost ceiling: 50/day × 90 ≈
#    4500 podcasts × 5MB = 22.5GB. Tight enough.
echo "+ applying lifecycle (90d delete)..."
LIFECYCLE_JSON=$(cat <<'EOF'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 90 }
    }
  ]
}
EOF
)
TMPFILE=$(mktemp)
echo "$LIFECYCLE_JSON" > "$TMPFILE"
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file="$TMPFILE" >/dev/null
rm -f "$TMPFILE"
echo "✓ lifecycle applied (90 day TTL)"

echo
echo "─ done ──────────────────────────────────────────────"
echo "Bucket:   gs://$BUCKET"
echo "Region:   $REGION"
echo "TTL:      90 days"
echo
echo "Add to .env.local:"
echo "  PODCAST_GCS_BUCKET=$BUCKET"
