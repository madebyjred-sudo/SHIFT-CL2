#!/usr/bin/env bash
#
# promote-preview.sh — promueve una preview revision de Cloud Run a 100% traffic.
#
# Workflow:
#   1. Deployaste con `deploy-api.sh --preview` → revision con 0% traffic
#   2. Hiciste smoke tests contra la preview URL
#   3. Cuando confirmaste que todo OK, corres este script
#   4. Si algo sale mal, `rollback.sh` te lleva de vuelta a la revision anterior
#
# Usage:
#   bash infra/deploy/promote-preview.sh preview-<sha>
#
# Lo que hace:
#   - Encuentra la revision que tiene el tag dado
#   - Mueve 100% del tráfico a esa revision
#   - Quita el tag (queda como current revision normal)
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-cl2-v2-api}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <preview-tag>"
  echo "Example: $0 preview-210aa74"
  exit 1
fi

PREVIEW_TAG="$1"

echo "→ Buscando revision con tag '$PREVIEW_TAG'..."
REVISION=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.traffic[?tag='$PREVIEW_TAG'].revisionName)" \
  2>/dev/null | head -1)

if [[ -z "$REVISION" ]]; then
  echo "✗ No se encontró revision con tag '$PREVIEW_TAG'."
  echo "  Revisions disponibles:"
  gcloud run revisions list \
    --service="$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --limit=10
  exit 1
fi

echo "→ Revision encontrada: $REVISION"

# Guardamos la revision actualmente en producción (por si necesitamos rollback)
PREV_REVISION=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.traffic[?percent=100].revisionName)" \
  2>/dev/null | head -1)
echo "→ Revision actual en prod (rollback target): ${PREV_REVISION:-unknown}"

read -p "→ Promover $REVISION a 100% traffic? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelado."
  exit 0
fi

echo "→ Promoviendo $REVISION a 100% traffic..."
gcloud run services update-traffic "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --to-revisions="$REVISION=100" \
  --remove-tags="$PREVIEW_TAG"

echo
echo "✅ Promoción completa."
echo "   $REVISION ahora recibe 100% del tráfico."
echo "   Rollback si necesario:"
echo "     bash infra/deploy/rollback.sh ${PREV_REVISION:-<revision-name>}"
