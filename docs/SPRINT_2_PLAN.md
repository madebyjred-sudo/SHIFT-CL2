# Sprint 2 — Agentes funcionales + RAG

**Duración:** 2026-04-25 → 2026-05-01 (7 días)
**Precondición:** Sprint 1 cerrado (scaffold + auth + UI base + Cerebro decision).

## Objetivos

1. **3 agentes respondiendo con citas reales** (Lexa, Atlas, Centinela)
2. **RAG funcional** sobre 3 sesiones demo (seed) + pipeline de ingesta manual
3. **Deep Insight toggle** conectado a Opus 4.7
4. **Demo guion ensayado** con Jotini

## Entregables

### D1-D2 — Cerebro CL2 operativo

Depende de decisión Jred (A/B/C en CEREBRO_BLOCKER.md). Suponiendo **C**:

- [ ] Deploy fresh `shift-cerebro-cl2` en Railway (nuevo proyecto)
- [ ] `tenant_constitution.py` con seed CL2:
  ```python
  CL2_SEED = {
    'tenant_id': 'cl2',
    'tenant_name': 'Shift CL2 — Asamblea Legislativa CR',
    'agents': ['lexa', 'atlas', 'centinela'],
    'default_model': 'anthropic/claude-sonnet-4.6',
    ...
  }
  ```
- [ ] Mount tenant_api + peaje + studio_adapter routers
- [ ] Env: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
- [ ] Smoke: `POST /v1/chat/stream {tenant: cl2, agent: lexa, query: ...}` → SSE
- [ ] Actualizar `apps/api/src/services/cerebroClient.ts` al endpoint real

### D3 — RAG pipeline (Supabase pgvector)

- [ ] Aplicar migration 0001 a prod (paso manual, ver infra/supabase/README.md)
- [ ] `scripts/seed-demo.ts` con embeddings **reales** (OpenAI text-embedding-3-large)
  - Requiere OPENAI_API_KEY (pedir a Jred o reusar de Cerebro)
- [ ] Función RPC `match_chunks(query_embedding, match_count, session_filter)` en Supabase
- [ ] HNSW index después de seed:
  ```sql
  create index chunks_embedding_idx on legislative_chunks
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);
  ```
- [ ] Tool `search_transcripts` en Cerebro que llama a Supabase RPC y retorna top-K chunks con metadata

### D4 — Lexa end-to-end

- [ ] Prompt Lexa en tenant_constitution CL2 (persona + contract + citation format)
- [ ] Tool binding: `search_transcripts` → RAG, `cite_source` → formateo
- [ ] Frontend: renderizar citations como links expandibles
- [ ] Test: "¿Qué se votó en el Plenario #120?" → respuesta con cita `[Acta 120, 4-mar-2026, ...]`

### D5 — Atlas + Centinela

- [ ] Atlas: tool `upload_pdf` (stub que recibe URL y dispara ingest_job)
- [ ] Atlas: tool `generate_pptx` (Gamma API — mock si no hay key todavía)
- [ ] Centinela: Deep Insight ON → forzar Opus 4.7, comparativas entre sesiones
- [ ] Test: "Compará votación Plenario 120 vs Hacendarios 11-mar" → salida Centinela con análisis + fuentes

### D6 — UX polish con Jotini

- [ ] Integrar branding final de ui-kit (colores, tipografía, espaciado)
- [ ] Componentes Jotini: MessageBubble, CitationCard, AgentSwitcher pro
- [ ] Animaciones chat streaming
- [ ] Estados: loading, error, empty, confidence badge
- [ ] Mobile responsive (breakpoint 768px mínimo)

### D7 — Demo ensayo

- [ ] Guion demo Oscar (5-7 min, 3 preguntas clave por agente)
- [ ] Dry run completo con Jotini
- [ ] Plan B: si Cerebro cae, mock estático con respuestas pre-generadas
- [ ] Video loom de respaldo (grabación 1 pase limpio)

## Gates de revisión Jred (mínimos)

| Gate | Momento | Decisión | Duración |
|------|---------|----------|----------|
| G1 | Inicio D1 | Aprobar opción Cerebro A/B/C | 5 min |
| G2 | Fin D3 | Revisar chat con Lexa + cita real | 10 min |
| G3 | Fin D5 | Los 3 agentes funcionando | 15 min |
| G4 | Fin D7 | Dry run demo completo | 30 min |

Entre gates: full autonomy (excepto si algo bloquea >2h, entonces ping).

## Riesgos

- **Cerebro redeploy rompe Shift Lab** → opción C (proyecto separado) mitiga
- **OpenRouter rate limits en embeddings masivos** → start con seed (15 chunks), escalar después
- **Gamma API sin key** → mock hasta que Jred la obtenga
- **ElevenLabs transcripción on-the-fly no probada** → Sprint 3; para Oscar usamos seed pregenerado

## Salidas a Sprint 3

- Migración dataset real MariaDB → Supabase (3K+ videos)
- Worker scraping automático Asamblea (playwright cron)
- Ingesta manual YouTube URL + PDF upload desde UI
- Dominio alpha.agentescl2.com + SSL
