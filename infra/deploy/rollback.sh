#!/usr/bin/env bash
#
# rollback.sh — vuelve atrás a una revision específica de Cloud Run.
#
# Usage:
#   bash infra/deploy/rollback.sh                # rollback al "previous"
#   bash infra/deploy/rollback.sh <revision>     # rollback a uno específico
#   bash infra/deploy/rollback.sh --list         # listar revisions disponibles
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-cl2-v2-api}"

if [[ "${1:-}" == "--list" ]]; then
  echo "→ Últimas 10 revisions de $SERVICE_NAME:"
  gcloud run revisions list \
    --service="$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --limit=10 \
    --format='table(name,status.conditions[0].lastTransitionTime.date(format="2006-01-02 15:04"),metadata.labels.serving\.knative\.dev\/configurationGeneration:label=GEN)'
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  TARGET_REVISION="$1"
else
  # Auto-find: last "Ready" revision que NO sea la actual.
  CURRENT=$(gcloud run services describe "$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format="value(status.traffic[?percent=100].revisionName)" \
    2>/dev/null | head -1)
  TARGET_REVISION=$(gcloud run revisions list \
    --service="$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --filter="status.conditions.type:Ready AND status.conditions.status:True AND metadata.name!=$CURRENT" \
    --format="value(metadata.name)" \
    --limit=1)
fi

if [[ -z "$TARGET_REVISION" ]]; then
  echo "✗ No se encontró revision target."
  echo "  Usá: $0 --list  para ver opciones disponibles."
  exit 1
fi

echo "→ Rollback target: $TARGET_REVISION"
read -p "→ Mover 100% del tráfico a $TARGET_REVISION? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelado."
  exit 0
fi

gcloud run services update-traffic "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --to-revisions="$TARGET_REVISION=100"

echo
echo "✅ Rollback completo. $TARGET_REVISION ahora recibe 100% traffic."
