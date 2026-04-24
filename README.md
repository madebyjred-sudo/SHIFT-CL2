# Shift CL2

Plataforma de Inteligencia Legislativa para Costa Rica. Vertical 1 del template `cerebro-vertical`.

**Status:** sprint MVP en curso. Demo: 2026-05-08.

## Stack

- **Monorepo:** Turborepo
- **Frontend:** React 19 + Vite + Tailwind + Zustand (fork Shifty Studio sin DAG)
- **BFF:** Express + TypeScript
- **Worker:** Node + Playwright + cron
- **Auth/DB/Vector:** Supabase (Postgres + pgvector + Auth)
- **Inteligencia:** Cerebro SDK (Railway, tenant `cl2`)
- **LLM:** OpenRouter via Cerebro router
- **Transcripción:** ElevenLabs API
- **Documentos:** Gamma API
- **Storage histórico:** GCS (buckets CL2 existentes, read-only)
- **Deploy:** Railway → `alpha.agentescl2.com`

## Los 3 agentes

| Agente | Dominio | Herramientas |
|---|---|---|
| **Lexa** | Consultas legislativas (actas, proyectos, mociones, orden día) | RAG transcripts, citador |
| **Atlas** | Documental (scraping, ingesta, generación ejecutiva) | Playwright, Gamma adapter |
| **Centinela** | Monitor (Deep Insight, alertas, comparativas, debate) | Punto Medio, comparador histórico |

## Estructura

```
shift-cl2/
├── apps/
│   ├── web/          # Frontend React
│   ├── api/          # BFF Express
│   └── worker/       # Jobs async
├── packages/
│   ├── cerebro-config/   # YAMLs agentes
│   ├── shared-types/     # Types compartidos
│   └── ui-kit/           # Componentes brandeados
├── infra/
│   ├── supabase/         # Migrations + RLS
│   └── docker/
└── scripts/              # Migración + seed
```

## Quickstart

```bash
npm install
cp .env.example .env.local
# edita credenciales
npm run dev
```

## Replicabilidad

Este repo es el **template base** para nuevas verticales (`cerebro-vertical-{slug}`). Lo que cambia por vertical:

- `apps/web/src/brand/` — design tokens, logos
- `packages/cerebro-config/agents/` — YAMLs custom
- `infra/supabase/migrations/seed.sql` — datos vertical
- `apps/worker/jobs/` — ingestores específicos
- `.env.example` — vars vertical

Lo que NUNCA cambia: `packages/shared-types`, BFF base, auth flow, chat UI core.
