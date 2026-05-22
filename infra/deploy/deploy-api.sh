#!/usr/bin/env bash
#
# deploy-api.sh — build + deploy apps/api to Cloud Run.
#
# Pre-requisites (DO once per machine, see docs/PRODUCTION.md §Setup):
#   1. gcloud auth login (with a USER account, not the SA — see TODOs)
#   2. gcloud config set project sincere-burner-475520-g7
#   3. gcloud services enable run.googleapis.com cloudbuild.googleapis.com
#                                artifactregistry.googleapis.com
#   4. gcloud auth configure-docker us-central1-docker.pkg.dev
#   5. Create Artifact Registry repo (one-time):
#        gcloud artifacts repositories create cl2 \
#          --repository-format=docker --location=us-central1
#
# Usage:
#   bash infra/deploy/deploy-api.sh                  # full deploy → 100% traffic
#   bash infra/deploy/deploy-api.sh --preview        # deploy con 0% traffic
#                                                     (preview/canary, no afecta prod)
#
# Modo --preview:
#   - Crea una nueva revision sin enviarle tráfico
#   - La tag-ea como `preview-<sha>` para que tenga una URL dedicada accesible
#   - Imprime URL para smoke test
#   - Tras validar manualmente, promover con:
#       bash infra/deploy/promote-preview.sh preview-<sha>
#
# Required env (export before running, or source from infra/deploy/.env.production):
#   PROJECT_ID, REGION, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
#   OPENROUTER_API_KEY, ELEVENLABS_API_KEY, CEREBRO_BASE_URL, ALLOWED_ORIGINS,
#   GOOGLE_APPLICATION_CREDENTIALS_JSON (the SA JSON for runtime — NOT same as deploy)

set -euo pipefail

# ─── Parse flags ──────────────────────────────────────────────────────
PREVIEW_MODE=0
for arg in "$@"; do
  case "$arg" in
    --preview) PREVIEW_MODE=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ─── Config (override via env) ────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-cl2-v2-api}"
REPO="${REPO:-cl2}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$(dirname "$0")/../.." rev-parse --short HEAD 2>/dev/null || date +%s)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/cl2-v2-api:${IMAGE_TAG}"
SA_RUNTIME="${SA_RUNTIME:-shift-cl2-vertex@${PROJECT_ID}.iam.gserviceaccount.com}"

# ─── Env vars to inject into the Cloud Run service ────────────────────
# Required — fail fast if missing.
: "${NEXT_PUBLIC_SUPABASE_URL:?missing NEXT_PUBLIC_SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?missing SUPABASE_SERVICE_ROLE_KEY}"
: "${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (used by auth.ts to verify user JWTs)}"
: "${OPENROUTER_API_KEY:?missing OPENROUTER_API_KEY}"
: "${ELEVENLABS_API_KEY:?missing ELEVENLABS_API_KEY}"
: "${CEREBRO_BASE_URL:?missing CEREBRO_BASE_URL}"
: "${ALLOWED_ORIGINS:?missing ALLOWED_ORIGINS — e.g. https://cl2-v2.agentescl2.com}"

# ─── 1. Build via Cloud Build (no local docker needed) ────────────────
echo "→ Building image $IMAGE"
gcloud builds submit \
  --project="$PROJECT_ID" \
  --config="$(dirname "$0")/cloudbuild-api.yaml" \
  --substitutions="_IMAGE=$IMAGE" \
  "$(dirname "$0")/../.."

# ─── 2. Deploy to Cloud Run ───────────────────────────────────────────
if [[ "$PREVIEW_MODE" == "1" ]]; then
  PREVIEW_TAG="preview-${IMAGE_TAG}"
  TRAFFIC_FLAGS=(--no-traffic --tag "$PREVIEW_TAG")
  echo "→ Deploying $SERVICE_NAME (PREVIEW, 0% traffic, tag=$PREVIEW_TAG)"
else
  TRAFFIC_FLAGS=()
  echo "→ Deploying $SERVICE_NAME to Cloud Run (FULL traffic)"
fi

gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_RUNTIME" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=10 \
  --concurrency=80 \
  --timeout=600 \
  --execution-environment=gen2 \
  --no-cpu-throttling \
  ${TRAFFIC_FLAGS[@]+"${TRAFFIC_FLAGS[@]}"} \
  --set-env-vars "API_PORT=8080" \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt" \
  --set-env-vars "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL" \
  --set-env-vars "SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY" \
  --set-env-vars "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
  --set-env-vars "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
  --set-env-vars "ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY" \
  --set-env-vars "CEREBRO_BASE_URL=$CEREBRO_BASE_URL" \
  --set-env-vars "CEREBRO_TENANT=cl2" \
  --set-env-vars "^|^ALLOWED_ORIGINS=$ALLOWED_ORIGINS" \
  --set-env-vars "^|^PUBLIC_WEB_URL=${PUBLIC_WEB_URL:-$ALLOWED_ORIGINS}" \
  --set-env-vars "GCS_BUCKET_SIL=shift-cl2-sil" \
  --set-env-vars "GCP_PROJECT_ID=$PROJECT_ID" \
  --set-env-vars "GCP_LOCATION=$REGION" \
  --set-env-vars "YOUTUBE_API_KEY=$YOUTUBE_API_KEY" \
  --set-env-vars "INTERNAL_TRIGGER_SECRET=$INTERNAL_TRIGGER_SECRET" \
  --set-env-vars "GAMMA_API_KEY=$GAMMA_API_KEY" \
  --set-env-vars "CL2_ASSETS_BUCKET=shift-cl2-podcasts" \
  --set-env-vars "ASSET_GCS_BUCKET=shift-cl2-podcasts" \
  --set-env-vars "GEMINI_TRANSCRIPT_ENABLED=true" \
  --set-env-vars "YT_COOKIES_PATH=/secrets/youtube-cookies.txt" \
  --set-env-vars "SHIFT_INTERNAL_TOKEN=$SHIFT_INTERNAL_TOKEN" \
  --set-env-vars "CEREBRO_API_KEY=$CEREBRO_API_KEY"
# IMPORTANTE: `gcloud run deploy --set-env-vars` REEMPLAZA todas las env vars
# del revision. Cualquier env seteada vía `gcloud run services update` después
# del último deploy se PIERDE en el próximo deploy. Por eso GEMINI_TRANSCRIPT_ENABLED
# y YT_COOKIES_PATH viven acá, no en `update`. Si agregás otra env, agregala
# acá también para que sobreviva los redeploys.

# ─── 3. Print the service URL so the next step can grab it ────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format='value(status.url)')

if [[ "$PREVIEW_MODE" == "1" ]]; then
  # En preview mode buscamos la URL del tag, no la principal
  PREVIEW_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format="value(status.traffic[?tag='$PREVIEW_TAG'].url)" 2>/dev/null || true)
  # Fallback: construir URL manualmente si el query anterior no funcionó
  if [[ -z "$PREVIEW_URL" ]]; then
    BASE_URL=$(echo "$SERVICE_URL" | sed -E 's|^https://([^.]+)\.|https://'"$PREVIEW_TAG"'---\1.|')
    PREVIEW_URL="$BASE_URL"
  fi
  echo
  echo "✅ PREVIEW deployed (0% traffic)."
  echo "   Preview URL: $PREVIEW_URL"
  echo "   Production:  $SERVICE_URL  (sin cambios)"
  echo "   Image:       $IMAGE"
  echo "   Tag:         $PREVIEW_TAG"
  echo
  echo "→ Smoke test (preview, no afecta prod):"
  echo "   curl $PREVIEW_URL/health"
  echo
  echo "→ Promover a producción cuando esté validado:"
  echo "   bash infra/deploy/promote-preview.sh $PREVIEW_TAG"
  echo
  echo "→ Descartar preview (si algo se ve mal):"
  echo "   gcloud run revisions delete <revision-name> --region=$REGION"
else
  echo
  echo "✅ API deployed."
  echo "   Service URL: $SERVICE_URL"
  echo "   Image:       $IMAGE"
  echo
  echo "→ Smoke test:"
  echo "   curl $SERVICE_URL/health"
  echo
  echo "→ Next step:"
  echo "   API_BASE_URL=$SERVICE_URL bash infra/deploy/deploy-web.sh"
fi
