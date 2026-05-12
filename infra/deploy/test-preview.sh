#!/usr/bin/env bash
#
# test-preview.sh — corre la suite de regresión Playwright contra una
# preview deploy ANTES de promote-preview.sh. Si falla, abort.
#
# Uso:
#   bash infra/deploy/deploy-api.sh --preview        # → tag preview-<sha>
#   bash infra/deploy/test-preview.sh preview-<sha>  # corre suite
#   bash infra/deploy/promote-preview.sh preview-<sha>  # solo si pasó
#
# O todo en un workflow:
#   bash infra/deploy/safe-deploy.sh  (que encadena los 3)
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-cl2-v2-api}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <preview-tag>"
  echo "Example: $0 preview-c41bd65"
  exit 1
fi

PREVIEW_TAG="$1"

# Encontrar las URLs del preview (api + web). El tag debería estar en ambos
# servicios si el deploy fue completo, pero acá solo necesitamos api para
# tests de API.
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format='value(status.url)')
# preview URL = injection del tag en el subdomain
PREVIEW_API_URL=$(echo "$SERVICE_URL" | sed -E "s|https://([^.]+)|https://${PREVIEW_TAG}---\1|")

echo "→ Testing preview: $PREVIEW_API_URL"

# Smoke check de salud antes de empezar tests serios
if ! curl -sf --max-time 15 "$PREVIEW_API_URL/health" > /dev/null; then
  echo "✗ Preview /health no responde — abort"
  exit 1
fi
echo "  ✓ /health OK"

# Necesitamos un JWT válido para los tests autenticados. Lo obtenemos via
# service-role (admin). El token tiene que estar en E2E_TEST_TOKEN ambiente
# o en infra/deploy/.env.production como SUPABASE_SERVICE_ROLE_KEY (no
# ideal — el service role es admin total, los tests deberían usar un user
# admin específico, TODO).
if [[ -z "${E2E_TEST_TOKEN:-}" ]]; then
  if [[ -f "$(dirname "$0")/.env.production" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$(dirname "$0")/.env.production"; set +a
  fi
  E2E_TEST_TOKEN="${SUPABASE_SERVICE_ROLE_KEY:-}"
fi
if [[ -z "$E2E_TEST_TOKEN" ]]; then
  echo "⚠️  E2E_TEST_TOKEN no seteado — tests autenticados se skipearán"
fi

# Correr la suite. Salida non-zero si algún test crítico falla.
cd "$(dirname "$0")/../.."
E2E_API_URL="$PREVIEW_API_URL" \
E2E_TEST_TOKEN="$E2E_TEST_TOKEN" \
npm run test:e2e --workspace=apps/web -- tests/e2e/regression-critical.spec.ts

echo
echo "✅ Regression suite OK contra $PREVIEW_TAG."
echo
echo "→ Promover a producción:"
echo "   bash infra/deploy/promote-preview.sh $PREVIEW_TAG"
