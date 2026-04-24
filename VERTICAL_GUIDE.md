# Vertical Guide — cómo replicar shift-cl2 para una nueva vertical

Este repo es la **vertical 1** del template `cerebro-vertical`. Para crear una nueva (banca, ecommerce, salud, etc):

## 1. Clonar y renombrar

```bash
gh repo create shift-{slug} --private --template madebyjred-sudo/shift-cl2
cd shift-{slug}
# busca/reemplaza:
#   shift-cl2 → shift-{slug}
#   cl2 → {slug}
#   CL2 → {SLUG}
```

## 2. Cambiar lo que es vertical-específico

| Archivo / dir | Qué cambia |
|---|---|
| `apps/web/src/brand/` | Tokens, logos, tipografía |
| `apps/web/src/index.css` | Variables CSS `--cl2-*` → `--{slug}-*` |
| `apps/web/tailwind.config.js` | Namespace `cl2` → `{slug}` |
| `packages/cerebro-config/agents/*.yaml` | Persona, dominio, herramientas, guardrails |
| `infra/supabase/migrations/0001_init.sql` | Tablas dominio (sessions → orders, etc) |
| `apps/worker/src/jobs/` | Ingestores específicos |
| `.env.example` | Vars vertical (APIs, buckets) |
| `README.md` | Descripción + agentes |

## 3. Lo que NO se toca

- `packages/shared-types/` (contratos genéricos)
- `apps/api/src/index.ts` y `routes/health.ts` (boilerplate)
- `apps/api/src/services/cerebroClient.ts` (cliente genérico)
- `apps/api/src/middleware/auth.ts` (Supabase JWT)
- `turbo.json`, `package.json` raíz

## 4. Setup nuevo Supabase project

1. Crear proyecto Supabase nuevo `shift-{slug}-prod`
2. Correr `infra/supabase/migrations/0001_init.sql`
3. Copiar URL + publishable key a `.env.local`
4. Habilitar Google OAuth en dashboard

## 5. Setup Cerebro tenant

- Reusar instancia Railway compartida
- Definir `tenant_id` nuevo en `tenant_constitution.py` del repo Cerebro
- Setear `CEREBRO_TENANT={slug}` en `.env`

## 6. Deploy

- Railway: 3 servicios (web, api, worker), apuntando al monorepo
- DNS: subdominio `alpha.{cliente-domain}.com` → Railway

## Métrica objetivo

**Vertical nueva con demo en 5 días** una vez familiarizados con el template.
