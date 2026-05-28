#!/usr/bin/env bash
#
# setup-all-jobs.sh — registra/actualiza TODOS los Cloud Scheduler jobs
# de CL2 contra el servicio cl2-v2-api. Idempotente: si un job ya existe
# se actualiza, si no, se crea.
#
# Esto es la pieza de "operación autónoma" del producto. Estos crons son
# los que permiten que CL2 ingiera, procese y alerte sin que nadie
# esté supervisando.
#
# Prereqs (1 vez por máquina):
#   gcloud auth login (cuenta con roles/cloudscheduler.admin)
#   gcloud config set project sincere-burner-475520-g7
#   gcloud services enable cloudscheduler.googleapis.com
#
# Uso:
#   bash infra/scheduler/setup-all-jobs.sh
#
# Para borrar todos:
#   bash infra/scheduler/setup-all-jobs.sh --teardown
#
# El secret INTERNAL_TRIGGER_SECRET debe estar en infra/deploy/.env.production
# y se inyecta como header X-Internal-Trigger en cada job.

set -euo pipefail

PROJECT="${PROJECT:-sincere-burner-475520-g7}"
REGION="${REGION:-us-central1}"
SERVICE_URL="${SERVICE_URL:-https://cl2-v2-api-u3rliii7wa-uc.a.run.app}"
TZ="${TZ:-America/Costa_Rica}"

# Leer INTERNAL_TRIGGER_SECRET del env file
if [[ -f "$(dirname "$0")/../deploy/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../deploy/.env.production"
  set +a
fi
if [[ -z "${INTERNAL_TRIGGER_SECRET:-}" ]]; then
  echo "ERROR: INTERNAL_TRIGGER_SECRET no está seteado." >&2
  exit 1
fi

TEARDOWN=0
if [[ "${1:-}" == "--teardown" ]]; then
  TEARDOWN=1
fi

# Catálogo declarativo de jobs. Cada línea:
#   <job_name>|<cron>|<endpoint_path>|<descripcion>
# Las descripciones son para identificación en `gcloud scheduler jobs list`.
read -r -d '' JOBS <<'EOF' || true
cl2-sil-discovery|0 3 * * *|/api/internal/centinela/sil-discovery|Descubre expedientes nuevos en el SIL (diario 3am CR)
cl2-sil-download|30 3 * * *|/api/internal/centinela/sil-download|Descarga PDFs del SIL a GCS (diario 3:30am CR)
cl2-sil-embed|0 4 * * *|/api/internal/centinela/sil-embed|Genera chunks + embeddings para docs SIL (diario 4am CR)
cl2-sil-enrich|30 4 * * *|/api/internal/centinela/sil-enrich|Enriquece metadata de expedientes SIL (diario 4:30am CR)
cl2-youtube-sync|0 * * * *|/api/internal/youtube-sync|Sincroniza videos de AsambleaCRC (cada hora)
cl2-process-pending|*/10 * * * *|/api/internal/process-pending|Procesa transcripts de sesiones pendientes (cada 10 min)
cl2-agenda-scrape|*/30 * * * *|/api/internal/centinela/agenda-scrape|Re-scrapea agenda del plenario (cada 30 min)
cl2-novelty-scan|*/30 * * * *|/api/internal/centinela/novelty-scan|Detector P16j de novedades pre-SIL (cada 30 min)
cl2-scan-mociones|*/30 * * * *|/api/internal/centinela/scan-mociones|Alerter P11/P11bis de mociones nuevas (cada 30 min)
cl2-similar-detect|0 */4 * * *|/api/internal/centinela/similar-detect|HNSW vecinos similares por expediente (cada 4h)
cl2-extract-fechas|0 6 * * *|/api/internal/centinela/extract-fechas-dictamen|P07 extracción de fecha estimada de dictamen (diario 6am)
cl2-categorize-expedientes|30 6 * * *|/api/internal/centinela/categorize-expedientes|Categorización editorial de expedientes (diario 6:30am)
cl2-ingest-decretos|0 5 * * *|/api/internal/centinela/ingest-decretos|P16i procesamiento de decretos ejecutivos (diario 5am)
cl2-process-ordenes-dia|30 5 * * *|/api/internal/centinela/process-ordenes-dia|P06 procesamiento de órdenes del día (diario 5:30am)
cl2-resumen-mixto|0 7 * * *|/api/internal/centinela/resumen-mixto|Resúmenes mixtos LLM (diario 7am)
cl2-informe-semanal|0 8 * * 1|/api/internal/centinela/informe-semanal|Informe semanal por cliente (lunes 8am)
cl2-daily-health|0 8 * * *|/api/internal/centinela/daily-health-report|Snapshot de salud diario (diario 8am)
cl2-llm-enrich-docs|0 23 * * *|/api/internal/centinela/llm-enrich-docs|Enriquecimiento LLM de documentos (diario 11pm)
cl2-ingest-transcript-chunks|15 23 * * *|/api/internal/centinela/ingest-transcript-chunks|Ingest de chunks de transcripts a HNSW (diario 11:15pm)
EOF

if [[ "$TEARDOWN" == "1" ]]; then
  echo "⚠️  TEARDOWN MODE — borrando todos los jobs CL2..."
  while IFS='|' read -r name _cron _path _desc; do
    [[ -z "$name" ]] && continue
    echo "  borrar $name"
    gcloud scheduler jobs delete "$name" \
      --location="$REGION" --project="$PROJECT" --quiet 2>/dev/null || true
  done <<< "$JOBS"
  echo "✅ teardown completo"
  exit 0
fi

# Crear o actualizar cada job
echo "→ Registrando jobs contra $SERVICE_URL"
while IFS='|' read -r name cron path desc; do
  [[ -z "$name" ]] && continue
  uri="${SERVICE_URL}${path}"
  echo "  $name → $cron → $path"
  # gcloud scheduler crea o actualiza con el mismo comando bajo `update` o `create`.
  # Usamos describe para chequear si ya existe; si sí, update; si no, create.
  if gcloud scheduler jobs describe "$name" \
       --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" \
      --location="$REGION" --project="$PROJECT" \
      --schedule="$cron" --time-zone="$TZ" \
      --uri="$uri" --http-method=POST \
      --update-headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET,Content-Type=application/json" \
      --message-body='{}' \
      --description="$desc" \
      --attempt-deadline=1800s \
      --min-backoff=30s --max-backoff=600s \
      --max-retry-attempts=3 \
      >/dev/null
  else
    gcloud scheduler jobs create http "$name" \
      --location="$REGION" --project="$PROJECT" \
      --schedule="$cron" --time-zone="$TZ" \
      --uri="$uri" --http-method=POST \
      --headers="X-Internal-Trigger=$INTERNAL_TRIGGER_SECRET,Content-Type=application/json" \
      --message-body='{}' \
      --description="$desc" \
      --attempt-deadline=1800s \
      --min-backoff=30s --max-backoff=600s \
      --max-retry-attempts=3 \
      >/dev/null
  fi
done <<< "$JOBS"

echo ""
echo "✅ Jobs registrados. Listado:"
gcloud scheduler jobs list \
  --location="$REGION" --project="$PROJECT" \
  --filter='name~cl2-' \
  --format='table(name.basename(),schedule,timeZone,state,httpTarget.uri.basename())'
