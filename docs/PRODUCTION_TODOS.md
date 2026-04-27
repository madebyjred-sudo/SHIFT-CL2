# PRODUCTION_TODOS — gaps conocidos del primer deploy

**Versión:** 1.0
**Fecha:** 2026-04-27
**Estado:** lista priorizada — TODO lo de aquí es **post-demo Oscar**, NO bloqueante

> Cualquier gap aquí asume que **funcionalmente** la app está OK en Cloud Run.
> Esto es deuda de infraestructura / hardening, no de producto.

---

## P0 — Antes de mover usuarios reales (semana post-demo)

### 1. Service account dedicado para Cloud Run runtime

**Estado actual:** ambos servicios corren con `shift-cl2-vertex@sincere-burner-475520-g7.iam.gserviceaccount.com`. Esa SA fue creada para acceso a Vertex AI desde el legacy.

**Por qué es deuda:** principle of least privilege. Si la SA se filtra, el atacante hereda permisos para Vertex también, no solo para Cloud Run + GCS.

**Fix:**

```bash
# 1. Crear SA específica para CL2 v2 runtime
gcloud iam service-accounts create cl2-v2-runtime \
  --display-name="CL2 v2 Cloud Run runtime" \
  --description="Runtime SA for cl2-v2-api and cl2-v2-web"

# 2. Grant permisos mínimos
PROJECT=sincere-burner-475520-g7
SA="cl2-v2-runtime@${PROJECT}.iam.gserviceaccount.com"

# Acceso al bucket SIL (read-only suficiente)
gsutil iam ch serviceAccount:${SA}:objectViewer gs://shift-cl2-sil

# Logging + monitoring (para que los logs salgan)
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${SA}" --role="roles/logging.logWriter"
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${SA}" --role="roles/monitoring.metricWriter"

# 3. Update los services
gcloud run services update cl2-v2-api --region=us-central1 \
  --service-account=$SA
gcloud run services update cl2-v2-web --region=us-central1 \
  --service-account=$SA
```

**Effort:** 30 min. **Owner:** quien tenga `roles/iam.serviceAccountAdmin`.

---

### 2. Supabase project separado para producción

**Estado actual:** prod usa el mismo Supabase project que dev. Los datos del demo se mezclan con datos de pruebas internas. RLS protege per-user pero no separa "ambiente".

**Por qué es deuda:**
- Migrations en dev pueden romper prod (no hay seguridad)
- Backups mezclados (un restore impacta a ambos)
- Compliance — clientes "reales" del demo merecen aislamiento de datos

**Fix:**

```bash
# 1. Crear nuevo project Supabase: cl2-v2-prod
# 2. Aplicar migrations 0001-0014 al nuevo project
# 3. Setup RLS policies (clonar de dev)
# 4. Update .env.production con el nuevo URL + service role key
# 5. Re-deploy api + web
```

**Effort:** 2-3 horas (migrations + smoke test).
**Cuándo:** antes de que entre el primer cliente externo.

---

### 3. Secret Manager para credentials

**Estado actual:** secrets viajan en `--set-env-vars` de Cloud Run. Visibles en `gcloud run services describe`.

**Por qué es deuda:** cualquier persona con `roles/run.viewer` en el project puede leer las API keys. Eso incluye stakeholders no-técnicos que les damos acceso al dashboard.

**Fix:**

```bash
# 1. Subir cada secret a Secret Manager
echo -n "$OPENROUTER_API_KEY" | gcloud secrets create cl2-v2-openrouter-key --data-file=-
echo -n "$ELEVENLABS_API_KEY" | gcloud secrets create cl2-v2-elevenlabs-key --data-file=-
echo -n "$SUPABASE_SERVICE_ROLE_KEY" | gcloud secrets create cl2-v2-supabase-srk --data-file=-

# 2. Grant accessor role a la runtime SA
gcloud secrets add-iam-policy-binding cl2-v2-openrouter-key \
  --member="serviceAccount:cl2-v2-runtime@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
# ... repetir por secret

# 3. Update Cloud Run para mountear secrets como env vars
gcloud run services update cl2-v2-api \
  --update-secrets=OPENROUTER_API_KEY=cl2-v2-openrouter-key:latest,\
ELEVENLABS_API_KEY=cl2-v2-elevenlabs-key:latest,\
SUPABASE_SERVICE_ROLE_KEY=cl2-v2-supabase-srk:latest
```

Después update `deploy-api.sh` para usar `--set-secrets` en vez de `--set-env-vars` para keys.

**Effort:** 1 hora. **Owner:** quien tenga acceso a Secret Manager.

---

## P1 — Higiene operacional (próximas 2 semanas)

### 4. CI/CD via GitHub Actions

**Estado actual:** deploys son manuales (`bash deploy-*.sh`). Funciona pero requiere disciplina.

**Fix:** un `.github/workflows/deploy.yml` que:
- Ejecuta en push a `main`
- Build + push a Artifact Registry
- Deploy a Cloud Run
- Smoke test post-deploy

Usa Workload Identity Federation (NO json keys) para auth GitHub → GCP.

**Effort:** 4-6 horas. Vale la pena cuando el equipo crezca >1 dev.

---

### 5. Sentry en producción

**Estado actual:** el código YA llama a Sentry si `SENTRY_DSN` está set (ver `apps/api/src/index.ts:18-30`). Falta:
- Crear project Sentry para `cl2-v2-api`
- Crear project Sentry para `cl2-v2-web` (con `@sentry/react`)
- Set `SENTRY_DSN` en `.env.production`

**Fix:**

```bash
# Sentry side: create projects, get DSNs
# Local side:
echo "SENTRY_DSN=https://xxx@sentry.io/yyy" >> infra/deploy/.env.production
# Re-deploy
```

Para web, además agregar `@sentry/react` init en `apps/web/src/main.tsx`.

**Effort:** 1 hora.

---

### 6. Min instances = 1 para warm starts

**Estado actual:** `--min-instances=0` → cold start de 5-10s en primer request.

**Fix:** durante demo + presentaciones poner `--min-instances=1`. Costo extra: ~$10-15/mes por servicio.

```bash
gcloud run services update cl2-v2-api \
  --region=us-central1 --min-instances=1
```

**Effort:** 30 segundos. Hacerlo el día antes del demo y revertir después si hace falta.

---

### 7. Cloud Logging → BigQuery sink

**Estado actual:** logs en Cloud Logging. Retención 30 días default. Sin agregaciones útiles para análisis.

**Fix:** sink a BigQuery dataset `cl2_v2_logs`. Retención 365 días, queries SQL para audit.

**Effort:** 1 hora setup + queries on-demand.

---

### 8. Alertas básicas

**Estado actual:** ninguna. Si el servicio se cae, lo detectás cuando un usuario se queja.

**Fix mínimo:**
- Uptime check sobre `https://cl2-v2.agentescl2.com/healthz` cada 1 min
- Alert si 3 fallos consecutivos → email a Juan + Oscar
- Alert si 5xx rate > 5% en 5 min

**Effort:** 30 min en Cloud Monitoring console.

---

## P2 — Hardening a futuro (mes+1)

### 9. Custom domain SSL hardening (HSTS, etc)

Cuando el dominio esté firme, configurar:
- `Strict-Transport-Security`: max-age=31536000
- `Content-Security-Policy`: tight default-src
- `X-Frame-Options`: DENY (excepto para iframe embed)
- `Referrer-Policy`: strict-origin-when-cross-origin

Aplicar via headers en `nginx.conf.template`.

### 10. Rate limit a nivel Load Balancer (Cloud Armor)

Hoy: rate limit es application-level (express-rate-limit). Si hay un DDoS, el container se ahoga antes de poder rechazar.

Mejor: Cloud Armor edge rules. Más caro pero protección real.

### 11. Multi-region o multi-zone

Hoy: us-central1 solamente. Si Iowa cae (raro pero pasa), todo down.

Después de tener tráfico real: replicar a `us-east1` con global load balancer.

### 12. Imagen de containers — mover a Distroless

`node:20-alpine` ~50MB. `gcr.io/distroless/nodejs20-debian12` ~30MB sin shell. Reduce surface attack.

Fix sencillo, solo requiere testar que no rompa nada (no hay shell para debuggear, solo logs).

### 13. Backup strategy formal

- Supabase tiene backups automáticos. Documentar restore procedure y testarlo una vez.
- GCS bucket: enable versioning + lifecycle policy.

### 14. DR runbook

Doc en `docs/DR.md` con: "qué hacer si Cloud Run cae", "qué hacer si Supabase migra de URL", "qué hacer si OpenRouter cambia las API keys con cero notice".

---

## Cómo trackear esto

Sugerencia: convertir cada item en GitHub issue con label `prod-todo`. Priorización:
- P0 = ANTES de cliente real
- P1 = primer mes de operación
- P2 = primeros 3 meses

Owner inicial: Juan. Re-asignar cuando equipo crezca.

---

## Ya hecho ✅ (para que no se repitan preguntas)

- ✅ Cloud Run deploy de api + web
- ✅ nginx con SSE-friendly proxy
- ✅ Multi-stage Dockerfiles (small images)
- ✅ Workspace deps preserved (shared-types, ui-kit)
- ✅ Domain mapping a `cl2-v2.agentescl2.com`
- ✅ Health endpoints (/health para API, /healthz para web)
- ✅ tini para signal forwarding
- ✅ user node (UID 1000) en runtime — no root
- ✅ ALLOWED_ORIGINS configurable
- ✅ Cache headers para assets hashed (immutable)
- ✅ no-cache para index.html
- ✅ build-args para VITE_*
- ✅ CORS pasar Authorization header
