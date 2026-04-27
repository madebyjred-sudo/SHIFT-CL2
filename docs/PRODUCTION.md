# PRODUCTION — Runbook de deploy CL2 v2 a Cloud Run

**Versión:** 1.1
**Fecha:** 2026-04-27
**Estado:** primer deploy E2E live. URLs Cloud Run abajo. Falta domain mapping (paso interactivo).

## URLs vivas

| Servicio | Cloud Run URL |
|---|---|
| Web (SPA + nginx proxy) | https://cl2-v2-web-u3rliii7wa-uc.a.run.app |
| API (BFF Express) | https://cl2-v2-api-u3rliii7wa-uc.a.run.app |
| Imagen web | `us-central1-docker.pkg.dev/sincere-burner-475520-g7/cl2/cl2-v2-web:a83c302` |
| Imagen API | (latest tag publicado por el script de deploy) |

**Probado y funcionando** (2026-04-27 22:17 UTC):
- SPA root + deep routes (`/sesiones`, `/hojas`) → 200
- JS/CSS bundles → 200, content-type correcto
- `/api/*` proxy → 401 con auth header faltante (gate de auth vivo)
- API directo `/health` → 200 OK

---

## 0. Arquitectura

```
                 ┌─────────────────────────────────┐
                 │  cl2-v2.agentescl2.com  (DNS)   │
                 └──────────────┬──────────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │  cl2-v2-web      │  ← Cloud Run (nginx + Vite SPA)
                      │  (us-central1)   │
                      └──────┬───────────┘
                  /api/*     │
                  proxy      ▼
                      ┌──────────────────┐
                      │  cl2-v2-api      │  ← Cloud Run (Express BFF)
                      │  (us-central1)   │
                      └──┬─────────┬─────┘
                         │         │
                         │         └──────► OpenRouter / ElevenLabs
                         ▼
                ┌────────────────────┐
                │  Supabase (shared) │
                │  + GCS (shift-cl2-sil)
                │  + Cerebro (Railway)
                └────────────────────┘
```

**Por qué un solo dominio (no `api.` separado):** zero CORS. nginx en el web service proxia `/api/*` al API service. SSE (chat streaming) funciona porque desactivamos `proxy_buffering`.

---

## 1. Setup inicial (UNA VEZ por máquina)

> ⚠️ Tenés que correr esto con **tu cuenta personal de Google Cloud**, no con la SA `shift-cl2-vertex`. Esa SA es para **runtime** (acceso a GCS desde la app), no para deploy.

```bash
# 1. Auth con tu cuenta humana
gcloud auth login

# 2. Apuntar al project
gcloud config set project sincere-burner-475520-g7

# 3. Habilitar APIs necesarias
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com

# 4. Crear el repo de Artifact Registry para nuestras imágenes
gcloud artifacts repositories create cl2 \
  --repository-format=docker \
  --location=us-central1 \
  --description="CL2 v2 container images"

# 5. Configurar docker auth (si vas a hacer builds locales)
gcloud auth configure-docker us-central1-docker.pkg.dev

# 6. Verificar que tu cuenta tiene IAM suficiente:
#    - Cloud Run Admin (roles/run.admin)
#    - Cloud Build Editor (roles/cloudbuild.builds.editor)
#    - Artifact Registry Writer (roles/artifactregistry.writer)
#    - Service Account User on shift-cl2-vertex (roles/iam.serviceAccountUser)
gcloud projects get-iam-policy sincere-burner-475520-g7 \
  --flatten="bindings[].members" \
  --filter="bindings.members:user:$(gcloud config get account)" \
  --format="value(bindings.role)"
```

Si te falta algún rol, pedile a Oscar/Rodrigo que te lo grant. Para demo necesitás todos los anteriores.

---

## 2. Configurar `.env.production`

```bash
cp infra/deploy/.env.production.example infra/deploy/.env.production
$EDITOR infra/deploy/.env.production
```

Llená:
- `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (sacalos de tu `.env.local`)
- `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (idem)
- `OPENROUTER_API_KEY`
- `ELEVENLABS_API_KEY`
- `CEREBRO_BASE_URL` (default `https://shift-cerebro-production.up.railway.app` debería estar OK)
- `ALLOWED_ORIGINS=https://cl2-v2.agentescl2.com` (la URL final, asumiendo el domain mapping)

⚠️ El archivo está en `.gitignore`. NO lo commitees.

---

## 3. Primer deploy

```bash
# 1. Cargar el env
set -a && source infra/deploy/.env.production && set +a

# 2. Deploy API
bash infra/deploy/deploy-api.sh

# El script imprime al final algo como:
#   ✅ API deployed.
#      Service URL: https://cl2-v2-api-xxxxxx-uc.a.run.app
#      Image:       us-central1-docker.pkg.dev/.../cl2-v2-api:abc123

# 3. Smoke test API
curl https://cl2-v2-api-xxxxxx-uc.a.run.app/health
# → debe devolver { ok: true } o similar

# 4. Deploy web (usando el URL del API)
export API_BASE_URL=https://cl2-v2-api-xxxxxx-uc.a.run.app
bash infra/deploy/deploy-web.sh

# 5. Smoke test web
curl https://cl2-v2-web-yyyyyy-uc.a.run.app/healthz
# → "ok"
open https://cl2-v2-web-yyyyyy-uc.a.run.app
# → debe cargar el SPA. Login + query a Lexa debe funcionar.
```

Si el smoke pasa, seguís con el domain mapping. Si no, ver §6 Troubleshooting.

---

## 4. Domain mapping a `cl2-v2.agentescl2.com`

⚠️ **Requiere un paso interactivo** — el dominio tiene que estar verificado en Search Console **bajo la misma cuenta de Google que está corriendo gcloud**. Esto es chequeo de propiedad de Google, no se puede automatizar.

### Paso 1 — verificar el dominio (UNA VEZ)

```bash
# Esto abre Search Console en el browser
gcloud domains verify agentescl2.com
```

Search Console te pide que demuestres propiedad del dominio. La forma más rápida es **DNS TXT record**:

1. Search Console te da un string tipo `google-site-verification=abc123...`
2. Vas al DNS provider de `agentescl2.com` (Cloudflare/Route53/etc.) y agregás un TXT record:
   - Nombre: `@` (o el dominio root)
   - Valor: `google-site-verification=abc123...`
3. Volvés a Search Console y clicás "Verify"
4. Google chequea que el TXT esté propagado (puede tardar 5-30 min)

Una vez verificado el dominio root `agentescl2.com`, **automáticamente quedan verificados todos los subdominios** (incluyendo `cl2-v2.agentescl2.com`).

### Paso 2 — crear el mapping

```bash
gcloud beta run domain-mappings create \
  --project=sincere-burner-475520-g7 \
  --region=us-central1 \
  --service=cl2-v2-web \
  --domain=cl2-v2.agentescl2.com
```

### Paso 3 — crear el DNS record

El comando del paso 2 imprime el DNS record que tenés que crear. Para subdominios suele ser un CNAME:

```
NAME    TYPE    VALUE
cl2-v2  CNAME   ghs.googlehosted.com.
```

Crealo en el DNS provider de `agentescl2.com`. Esperar 5-30 min para SSL provisioning automático.

### Paso 4 — verificar

```bash
# Estado del mapping (READY = listo)
gcloud beta run domain-mappings describe \
  --project=sincere-burner-475520-g7 \
  --region=us-central1 \
  --domain=cl2-v2.agentescl2.com \
  --format='value(status.conditions[].status,status.conditions[].type)'

# Smoke
curl -sI https://cl2-v2.agentescl2.com/
open https://cl2-v2.agentescl2.com
```

### Paso 5 — actualizar `ALLOWED_ORIGINS` en el API

```bash
gcloud run services update cl2-v2-api \
  --project=sincere-burner-475520-g7 \
  --region=us-central1 \
  --update-env-vars="ALLOWED_ORIGINS=https://cl2-v2.agentescl2.com,https://cl2-v2-web-u3rliii7wa-uc.a.run.app"
```

(Mantenés también la URL Cloud Run para fallback si el dominio falla.)

### Si no podés verificar el dominio (atajo para el demo)

Si Oscar/Jred manejan el DNS y no podés meterte ahora, **el demo igual funciona en la URL Cloud Run cruda**:

```
https://cl2-v2-web-u3rliii7wa-uc.a.run.app
```

Tiene SSL válido (cert de `*.run.app`), CORS está configurado para esa URL, y todo el flujo end-to-end funciona. El custom domain es cosmético.

---

## 5. Smoke test E2E (post-deploy)

URL base para el primer round (antes del custom domain): `https://cl2-v2-web-u3rliii7wa-uc.a.run.app`

### Checklist infra (ya validado 2026-04-27)

```
✅ GET /                                             → 200, SPA carga
✅ GET /assets/index-*.js                            → 200, JS bundle (~3MB)
✅ GET /sesiones, /hojas (SPA fallback)              → 200, index.html
✅ GET /api/workspace (sin auth)                     → 401 (proxy + gate vivos)
✅ Direct API /health                                → 200 OK
```

### Checklist funcional (E2E, en browser)

```
□ Login Supabase desde el SPA                                 → user dashboard carga
□ Mandar query a Lexa "qué proyectos hay sobre fintech"       → respuesta + citas (SSE OK)
□ /hojas → crear espacio → "armame un análisis del exp X"     → arquitecta materializa hojas
□ /hojas → mic → dictar 5s                                    → texto aparece (ElevenLabs OK)
□ /hojas → 3-puntos → "Exportar a Word"                       → DOCX se descarga
□ /sil → catálogo muestra 3,970+ indexados                    → ✓
□ Sidebar de chat → cerrar sesión → volver a entrar           → historial persistido
```

Si el funcional pasa en la URL Cloud Run, el demo está listo. El custom domain es solo cosmética.

---

## 6. Troubleshooting

### "Cannot find module ..." al startup del container API

Probable: el bundle tsc no está incluyendo algo del workspace. Mirá los logs:
```bash
gcloud run services logs read cl2-v2-api --region=us-central1 --limit=50
```

Solución típica: el import path está rompiéndose cuando `apps/api/dist/` queda en el container pero `node_modules` se resuelve mal. Verificá que el Dockerfile copia tanto `node_modules` (root) como `apps/api/node_modules`.

### CORS error en el browser al hacer fetch

Probable: `ALLOWED_ORIGINS` en el API no incluye el dominio web. Update:
```bash
gcloud run services update cl2-v2-api \
  --region=us-central1 \
  --set-env-vars="ALLOWED_ORIGINS=https://cl2-v2.agentescl2.com"
```

### SSE / chat streaming no llega — el assistant queda mudo

Probable: nginx en el web service está bufferando. Verificá `nginx.conf.template` — debe tener `proxy_buffering off` en la location `/api/`. Si está OK pero sigue, verificá los timeouts (`proxy_read_timeout 300s`).

### Cold starts molestos (>5s en primera request)

Para el demo, settear `--min-instances=1` en el API:
```bash
gcloud run services update cl2-v2-api \
  --region=us-central1 --min-instances=1
```
Costo: ~$10/mes adicionales. Vale la pena si es para Oscar.

### "permission denied" en deploy

Tu cuenta no tiene los roles. Ver §1 paso 6.

### El bundle del web no tiene VITE_SUPABASE_URL

Probable: olvidaste exportar las VITE_* antes de correr `deploy-web.sh`. Esos son **build-time**, NO runtime. Re-build:
```bash
set -a && source infra/deploy/.env.production && set +a
bash infra/deploy/deploy-web.sh
```

### Logs en vivo

```bash
# API
gcloud run services logs tail cl2-v2-api --region=us-central1

# Web (nginx)
gcloud run services logs tail cl2-v2-web --region=us-central1
```

---

## 7. Rollback

Cada deploy crea una nueva revisión. Para volver a la anterior:

```bash
# Listar revisiones
gcloud run revisions list --service=cl2-v2-api --region=us-central1

# Apuntar 100% del tráfico a una revisión específica
gcloud run services update-traffic cl2-v2-api \
  --to-revisions=cl2-v2-api-00012-abc=100 \
  --region=us-central1
```

Útil si una corrida nueva rompe el demo y querés volver atrás en 30 segundos.

---

## 8. Costo esperado

Para el demo (5-10 usuarios, < 1000 requests/día):

| Servicio | Estimado/mes |
|---|---|
| Cloud Run (api + web) | $5-15 |
| Cloud Build (deploys) | $1-3 |
| Artifact Registry | < $1 |
| Egress (incluido en Cloud Run) | ya en Cloud Run |
| **Total infra deploy** | **~$10-20/mes** |

(NO incluye: Supabase, OpenRouter, ElevenLabs — esos son separados, ver `docs/cost-projection.md` si existe).

---

## 9. Próximos pasos (NO bloqueantes para demo)

Ver [`PRODUCTION_TODOS.md`](./PRODUCTION_TODOS.md). Resumen:

- Service account dedicado para Cloud Run (no reusar `shift-cl2-vertex` de Vertex AI)
- Supabase project separado para producción (hoy = mismo que dev)
- Secret Manager (hoy = env vars en Cloud Run)
- CI/CD GitHub Actions (hoy = manual via deploy-*.sh)
- Sentry en producción (DSN ya soportado, falta crear el project Sentry)
- Custom log routing a BigQuery
- Alertas on-error vía Cloud Monitoring
