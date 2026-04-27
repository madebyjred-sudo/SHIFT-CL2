#!/usr/bin/env bash
#
# deploy-web.sh — build + deploy apps/web to Cloud Run.
#
# Pre-requisites: same as deploy-api.sh.
#
# Usage:
#   API_BASE_URL=https://cl2-v2-api-xxx-uc.a.run.app \
#     bash infra/deploy/deploy-web.sh
#
# Required env:
#   API_BASE_URL (the Cloud Run URL of the API service — output of deploy-api.sh)
#   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (baked into the bundle at build time)

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-cl2-v2-web}"
REPO="${REPO:-cl2}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$(dirname "$0")/../.." rev-parse --short HEAD 2>/dev/null || date +%s)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/cl2-v2-web:${IMAGE_TAG}"

: "${API_BASE_URL:?missing API_BASE_URL — run deploy-api.sh first}"
: "${VITE_SUPABASE_URL:?missing VITE_SUPABASE_URL}"
: "${VITE_SUPABASE_PUBLISHABLE_KEY:?missing VITE_SUPABASE_PUBLISHABLE_KEY}"

# ─── 1. Build via Cloud Build with build-args for VITE_* ──────────────
echo "→ Building image $IMAGE"
gcloud builds submit \
  --project="$PROJECT_ID" \
  --config="$(dirname "$0")/cloudbuild-web.yaml" \
  --substitutions="_IMAGE=${IMAGE},_VITE_SUPABASE_URL=${VITE_SUPABASE_URL},_VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}" \
  "$(dirname "$0")/../.."

# ─── 2. Deploy to Cloud Run ───────────────────────────────────────────
echo "→ Deploying $SERVICE_NAME to Cloud Run"
gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=256Mi \
  --min-instances=0 \
  --max-instances=5 \
  --concurrency=200 \
  --timeout=60 \
  --set-env-vars "API_BASE_URL=$API_BASE_URL"

# ─── 3. Print the URL ─────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format='value(status.url)')

echo
echo "✅ Web deployed."
echo "   Service URL: $SERVICE_URL"
echo "   Image:       $IMAGE"
echo
echo "→ Smoke test:"
echo "   curl $SERVICE_URL/healthz"
echo "   open $SERVICE_URL"
echo
echo "→ Next step (custom domain):"
echo "   gcloud beta run domain-mappings create \\"
echo "     --service=$SERVICE_NAME --domain=cl2-v2.agentescl2.com \\"
echo "     --region=$REGION --project=$PROJECT_ID"
