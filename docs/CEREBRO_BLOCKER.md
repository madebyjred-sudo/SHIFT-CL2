# Cerebro Railway — Blocker técnico (decisión Jred)

**Fecha:** 2026-04-24
**Estado:** Bloquea wire chat SSE end-to-end (Sprint 1 D5)

## Hallazgos

Probe a `https://shift-cerebro-production.up.railway.app`:

```
GET /openapi.json → solo 5 rutas:
  /health, /peaje/ingest, /swarm/agents, /swarm/chat, /swarm/debate

GET /health → "shift-cerebro-swarm-v3-legio-digitalis"
  agents: Pedro, Susana, Carlos, María, Jorge, Lucía, Andrés, Patricia,
          Roberto, Carmen, Diego, Fernanda, Martín, Sofía, Gabriel
```

URL `https://shift-cerebro.up.railway.app` → **404 Application not found**
(la del .env.local original estaba mal).

## Diagnóstico

Railway corre **versión vieja** de Cerebro:
- Solo `swarm` router montado, faltan `tenant`, `peaje`, `punto_medio`, `studio`, `export`, `embed`, `graph` que sí están en `main.py` local (líneas 51-57).
- Roster es **Shift agency**, no CL2 (Lexa, Atlas, Centinela).
- `POST /swarm/chat` con `tenant_id=cl2` falla con `OpenRouter 404 anthropic/claude-3.5-sonnet` — **modelo deprecated**. Cerebro Railway tiene hardcoded modelo viejo. Key OpenRouter funciona OK con `anthropic/claude-sonnet-4.6` (probado).

Local está en `c745a46 revert: remove speculative Shift Chat adapters` (clean, on main).
Railway no ha deployado los últimos commits.

## Opciones

### A) Redeploy full Cerebro a Railway (recomendado MVP)
- Push trigger en Railway desde `c745a46`.
- Add tenant `cl2` a `tenant_constitution.py` (semilla seed_context con personas Lexa/Atlas/Centinela).
- Verificar OPENROUTER_API_KEY en Railway env.
- **Riesgo:** Toca prod compartida con Shift Lab. Verificar que swarm sigue funcionando.

### B) Adaptar BFF a `/swarm/chat` existente
- Cambiar `apps/api/src/services/cerebroClient.ts` para usar `/swarm/chat`.
- **Bloqueo:** swarm no tiene CL2 agents, retorna roster Shift. No sirve para demo.

### C) Cerebro local en dev, Railway prod después
- `uvicorn main:app` desde local mientras desarrollamos.
- Deploy fresh (Railway nuevo proyecto `shift-cerebro-cl2`) para prod.
- **Recomendado si A es riesgoso.** Aísla CL2 de Shift Lab.

## Recomendación

**Opción C** — fork separado para producto replicable.
- Crea `shift-cerebro-cl2` proyecto Railway dedicado.
- Tenant_constitution.py con seed CL2 only.
- Deploy independiente, no toca Shift Lab prod.
- Coste: +$5/mo Railway, ganancia: aislamiento + replicabilidad.

## Acción pendiente Jred

1. ¿A, B o C?
2. Si C: token Railway + autorización para crear proyecto.
