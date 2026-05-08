# Workspace para Shifty Studio — pathway de implementación

**Para:** equipo de Shifty Studio
**De:** equipo CL2 · 2026-05-06
**Status:** especificación (no código todavía)
**Lectura:** ~20 min

---

## ⚠️ Deuda — NO replicar el patrón `openRouterClient` de CL2

**Status (2026-05-07):** este doc fue escrito el 2026-05-06 describiendo el stack de CL2 como referencia para Studio Workspace. Una auditoría del día siguiente detectó que CL2 está construido haciendo **bypass de Cerebro** en el motor de chat — `apps/api/src/services/openRouterClient.ts` llama OpenRouter directo en 10 callsites (workspace.ts:1808/2038/2332/2654/2725, onboarding.ts:123, podcastScript.ts:22, transcriptProcess.ts:30, voto-inusual-backfill.ts:28, openRouterClient.ts:68).

**Studio NO debe copiar ese patrón.** Studio cwd (`shift-ai-gateway (1)`) ya pasa por Cerebro nativamente vía `SWARM_API_URL` (34 callsites confirmados a `/swarm/chat`, `/swarm/debate`, `/peaje/ingest`, `/v1/rag/retrieve`, etc.). Eco también pasa por Cerebro vía `CEREBRO_BASE_URL`. **Esos dos son la referencia correcta.**

**Plan de cierre de la deuda de CL2** (en `~/Downloads/audit-output/HANDOFF-CL2-AGENT.md`):

1. Mergear `feat/oai-compat` en `madebyjred-sudo/SHIFT-CEREBRO` y prender `ENABLE_OAI_ADAPTER=true` en Railway. Eso expone `/v1/chat/completions` OpenAI-compatible.
2. Cambiar 2 env vars en CL2 BFF: `OPENROUTER_BASE_URL` apunta a `https://shift-cerebro-production.up.railway.app/v1` y `OPENROUTER_API_KEY` se reemplaza por la key de Cerebro.
3. Mover los system prompts de agents legislativos (Lexa, Atlas, Centinela legislativo) a `madebyjred-sudo/SHIFT-CEREBRO/agents/skills/` con `visibility.apps: [cl2]` — versionados en git de Cerebro. Diseño en `~/Downloads/audit-output/proposals/agents-legislativos-scoping.md`.
4. Eliminar `apps/api/src/services/openRouterClient.ts` (~1188 líneas) y `apps/api/src/services/cerebroClient.ts` (62 líneas, ya muerto).
5. ADR-G4-bis en `docs/PLATFORM_GENESIS.md` formaliza la corrección con fecha de cierre 2026-05-15.

**Lo que Studio debe leer en este doc:**

- §1 (stack de Workspace en CL2 — frontend) → tomar como referencia de UX y de canvas, no de arquitectura backend.
- Las menciones a `openRouterClient` u "agents en el BFF" → leer **a través de la corrección**: en el target post-deuda, los agents viven en Cerebro y se invocan vía `/v1/agents/{agent_id}/invoke`. Studio cwd ya está en ese mundo.
- El cerebro compartido (la sección que hable del flywheel) → cierto en intención. CL2 está en proceso de alinear con la implementación; Studio cwd y Eco ya están alineados.

Si encontrás contradicciones entre este doc y la realidad post-migración, **gana la realidad post-migración**. Este aviso se quita cuando la deuda se cierre.

---

## 0. Por qué este doc existe

CL2 lleva ~6 semanas operando un canvas tipo "espacio de trabajo" llamado **Hojas**. Es donde los asesores legislativos arman un proyecto de ley entero — texto base, dictámenes, votaciones, posiciones de bancada, notas — en una sola página navegable. El feedback ha sido contundente: **el espacio de trabajo es lo que diferencia a CL2 de "un chat con IA"**.

Studio tiene una superficie equivalente latente: hoy soporta Chat + DAG (LM-Nodes para flujos de ejecución), pero le falta el modo **Notebook** — el espacio de trabajo libre donde el usuario co-construye un artefacto con los agentes.

Este doc explica:
1. **Qué es Workspace en CL2** (stack + arquitectura)
2. **Qué hace que sirva** (las integraciones con los agentes)
3. **Qué de eso aplica a Studio tal cual** y qué hay que adaptar
4. **Cómo el cerebro compartido (Cerebro) hace que esto compongan ambos productos**

El objetivo no es copiar archivo por archivo. Es entender el **modelo mental** y dejar que Studio lo encarne con su propia data.

---

## 1. El stack de Workspace en CL2

### 1.1 Frontend — el canvas y la hoja

```
apps/web/src/pages/WorkspaceCanvasPage.tsx   ← entrypoint, ~1.080 líneas
apps/web/src/components/hoja/
├── HojaNode.tsx               (562 líneas) — el nodo "página de trabajo"
├── AssetNode.tsx              (183 líneas) — nodo de archivo importado
├── HojaFormatMenu.tsx         (845 líneas) — barra de formato flotante
├── HojaSelectionMenu.tsx      (378 líneas) — menú al seleccionar texto
├── HojaSlashExtension.tsx     (286 líneas) — comandos slash dentro del editor
├── LexaContextPanel.tsx       (383 líneas) — panel chat lateral
├── LexaInlineModal.tsx        (248 líneas) — comando AI inline
├── LexaQuickHojaModal.tsx     (187 líneas) — "pedile a Lexa una hoja" rápido
├── SilCitePickerModal.tsx     (189 líneas) — picker de citas (CL2-specific)
└── VoiceCaptureModal.tsx      (388 líneas) — voz a hoja
```

**Stack principal:**

| Capa | Librería | Por qué |
|---|---|---|
| Canvas infinito | `@xyflow/react` (React Flow) | Pan + zoom + nodes posicionables. Maneja drag, mini-mapa, controles de zoom. |
| Editor de texto | `@tiptap/react` v3 + StarterKit | Rich text estructurado (Markdown bidireccional, comandos slash, marks como bold/highlight/link). Open-source, sin lock-in. |
| Persistencia | Supabase (postgres + RLS) | Cada nodo es una row. Auto-save debounced 800ms. RLS por user_id. |
| Animación menor | `motion` (ex framer-motion) | Reveals al scroll, transiciones de selección. |
| Render markdown | `marked` (server-side) + custom client | Para export y preview de citas. |

**Arquitectura del canvas:**

- Un **workspace** = container con título y descripción.
- Múltiples **workspace_nodes** dentro, cada uno con `(x, y, width, height)` libre.
- Tipos de nodo: `hoja` (TipTap nativo), `note` (variante chica), `cite` (referencia inline), `expediente_ref`, `image`, `document` (PDF/DOCX importado), `audio`.
- ReactFlow renderiza los nodos en un canvas pannable. El usuario los arrastra.
- Cada drag dispara un PATCH al servidor con la nueva posición (con throttle).

### 1.2 Backend — el router y los servicios

```
apps/api/src/routes/workspace.ts    ← ~2.880 líneas, 19 rutas
apps/api/src/services/
├── workspacePptxExport.ts   ← export a presentación (Gamma)
└── (otros servicios reutilizados desde el contexto general)
```

Las 19 rutas se agrupan en 6 capas:

| Capa | Rutas | Qué hace |
|---|---|---|
| **CRUD workspace** | `GET / POST / PATCH / DELETE /:id` | Listar, crear, renombrar, archivar, borrar workspaces. |
| **CRUD nodes** | `GET / POST / PATCH / DELETE /:id/nodes[/:nodeId]` | Operaciones sobre las hojas dentro del canvas. Auto-save por nodo. |
| **Export** | `POST /:id/export` (workspace entero) y `POST /:id/nodes/:nodeId/export` (hoja única) | Formatos: `md`, `docx`, `pptx`. PPTX usa Gamma (cache 1h). |
| **Import** | `POST /:id/nodes/import` (multipart) y `POST /:id/import-sources` | Subida de PDF/DOCX/imagen/audio + extracción a `extracted_text` para RAG. |
| **AI primitives** | `POST /:id/transform` (selección → reescritura), `POST /:id/architect` (build multi-hoja desde prompt), `POST /:id/turn` (smart turn — chat/build/edit/pptx) | Las operaciones inteligentes que usan los agentes. |
| **Citaciones** | `POST /citations` y `GET /:id/attach-context` | Guardar citas del chat como nodos del canvas + contexto entre canvas y chat. |

**Patrones críticos:**

- **Cache + auto-save**: cada PATCH a un nodo es debounced en cliente (800ms) + persistido en server. Idempotente.
- **Quota gates**: cada operación AI corre `requireQuota(userId, 'workspace.transform' | 'workspace.architect' | 'workspace.turn')`. Una sola bolsa diaria por usuario, no se puede bypassear cambiando de ruta.
- **Streaming SSE en /turn intent='chat'**: el chat dentro del workspace usa el mismo streamer que el chat principal — tokens, citaciones, confidence chunks. Reutilización completa.

### 1.3 La operación clave: el smart "turn"

`POST /:id/turn` es el corazón. Recibe `{query, agent_id, selected_node_id?, mode?}` y decide qué hacer:

```
1. ¿agent_id presente?
   ├─ Sí → usar agent picker (Lexa = chat, Atlas = build/edit/pptx)
   └─ No → llamar a un classifier LLM que devuelve {intent, target_node_id, confidence}

2. Pre-empt: si el query menciona "presentación|deck|ppt|slides" → intent = 'pptx'

3. Ejecutar según intent:
   ├─ chat            → SSE streaming con scope_system_prompt enriquecido
   ├─ build           → runArchitect (Gemini Flash Lite, JSON mode, max 16k tokens)
   ├─ edit_selected   → reescribe content del nodo seleccionado
   ├─ edit_by_match   → resuelve nodo por título y reescribe
   └─ pptx            → llama runWorkspacePptxExport (Gamma con cache)
```

Esa decisión-en-un-endpoint es lo que evita que el cliente tenga que saber "quién" responde. El usuario escribe en el chat lateral y el sistema decide si es una pregunta (chat), una construcción (build), una edición (edit) o un export.

**Para Studio**: este es el patrón que vale la pena copiar más que cualquier feature individual.

---

## 2. Las integraciones con los agentes (CL2-specific)

Lo que hace que Workspace **no sea solo un canvas Notion** son los agentes que viven dentro.

### 2.1 Lexa — la consultora al oído

**Cómo se comporta dentro del Workspace:**

Cuando el chat lateral está abierto y el usuario hace una pregunta, el endpoint `/turn` con `intent='chat'` arma un `scope_system_prompt` que le da contexto a Lexa:

```
[Workspace actual] "Reforma fiscal 2026"
[Hoja seleccionada] "Resumen ejecutivo": ...contenido completo...
[Hoja en canvas] "Antecedentes": ...contenido completo (capa 5K chars)...
[Hoja en canvas] "Análisis fiscal": ...contenido completo...
[Documento en canvas] "informe_22.403.docx": ...extracted_text (capa 8K chars)...
[CONTEXTO DEL WORKSPACE — REGLAS DE LECTURA]
PODÉS y DEBÉS leer estos bloques. NO digas "pegámelo aquí"...
```

Lexa responde **leyendo lo que ya está en el canvas** + sus tools normales (`search_sil_corpus`, `search_reglamento`, `search_transcripts`).

**Caps actuales para mantener bajo el context window:**
- Hojas (type='hoja' o 'note'): hasta 8 nodos × 5K chars = 40K
- Documents (type='document'): hasta 3 × 8K chars = 24K
- Total canvas context: ~64K + prompt de agente + tool defs ≈ comfortable bajo 120K

### 2.2 Atlas — el constructor

Atlas tiene 3 tools nativas en el workspace declaradas en `packages/cerebro-config/agents/atlas.yaml`:

```yaml
- name: workspace_build_nodes
  description: Crea N nodos hoja en el workspace activo. 3-6 hojas típicas.
- name: workspace_edit_node
  description: Reescribe el content de una hoja existente (modo EDIT).
- name: generate_presentation
  description: Convierte el workspace en una presentación con Gamma.
```

El mecanismo end-to-end:

1. Usuario en chat: "Atlas, armame un brief sobre el expediente 24.018"
2. `/turn` ve `agent_id='atlas'` y sin nodo seleccionado → intent = `'build'`
3. Llama `runArchitect(workspaceId, prompt)` que:
   - Pre-fetch context: si el prompt menciona expedientes (regex `\d{2,5}\.\d{3}`), busca esos en el SIL y los inyecta como contexto
   - Pre-fetch existing hojas (capa 6 × 4K chars) para que Atlas no duplique
   - Llama Gemini Flash Lite en JSON mode con `ARCHITECT_SYSTEM` + el prompt
   - Parse del JSON con schema `{hojas: [{title, subtitle, content_md, x, y, color}], summary}`
   - Inserta los nodos en `workspace_nodes`
4. La frontend recibe el array de nodos y los renderiza en el canvas

**Anti-hallucination:** los expedientes en el prompt se pre-buscan en `sil_expedientes` antes de mandar al modelo. El modelo recibe los datos verificados. Si el modelo cita un número no existente en su respuesta, el frontend lo flaggea.

### 2.3 Centinela — silencioso en el workspace

Centinela no opera *dentro* del workspace, pero las alertas que genera (cambio de estado, plazo, mención, agenda) pueden originar la creación de un workspace nuevo: el usuario hace click en una alerta → "Crear espacio para investigar este expediente" → Atlas arma 4-5 hojas en segundos.

**Para Studio**: este patrón "alerta → genera workspace" es replicable cuando Studio tenga su propio motor de alertas (ej. monitoring de un dataset, drift de modelo, etc.).

### 2.4 Audio del board (podcast generation)

Hay un botón en la toolbar superior derecha del canvas: **"Audio del board"**. Genera un podcast narrado del workspace entero (8-10 min, voz de Lexa). Útil para reuniones de auto, escuchar el brief en el carro.

Stack: `apps/api/src/routes/podcasts.ts` + ElevenLabs para síntesis. No requiere integración de Studio inicialmente — es CL2-specific.

### 2.5 PPT generation con Gamma

Ya commit `ddb1e4d` documenta esto. Resumen: el botón "Presentación" abre un options modal (tono, audiencia, propósito, marca), envía el contenido del workspace a Gamma, recibe URL de deck editable + URL de descarga `.pptx`. Cache de 1h por workspace para no quemar créditos.

**Para Studio**: este flujo es 100% portable. Reemplazá "tono legislativo" con el contexto que aplique al despacho de Studio.

---

## 3. Qué de esto aplica a Studio (y qué hay que adaptar)

### 3.1 Reusable as-is

| Pieza | Cómo se reusa |
|---|---|
| **Esquema de DB** (`workspaces` + `workspace_nodes`) | Tal cual. Cambiá `metadata jsonb` por lo que aplique a Studio. RLS sobre `user_id`. |
| **CRUD routes** (CRUD workspace + nodes) | Tal cual. La estructura de payload sirve para cualquier dominio. |
| **Stack frontend** (ReactFlow + TipTap + auto-save 800ms) | Tal cual. La UX de "página dentro del canvas" es atemporal. |
| **`/turn` endpoint pattern** (classifier → execute) | Tal cual. La heurística de pptx pre-empt aplica a cualquier producto que genere artefactos. |
| **Quota gates** (`requireQuota`) | Tal cual. Studio tendrá sus propias buckets pero el patrón es el mismo. |
| **Architect pre-fetch** (verificar entidades antes de generar) | Tal cual. Studio puede pre-fetch del dataset que aplique. |
| **Asset import** (PDF → extracted_text → injection en system prompt) | Tal cual. Mammoth + pdf-parse están en el stack. |
| **Export pipeline** (md / docx / pptx via Gamma) | Tal cual. Solo cambia el `additionalInstructions` que pasa a Gamma. |

### 3.2 Hay que adaptar

| Pieza CL2 | Equivalente Studio |
|---|---|
| `search_sil_expedientes`, `get_sil_expediente` | Sus tools de dataset/dominio. |
| `search_reglamento` | N/A o tools propias. |
| `search_transcripts` | Tools sobre logs/datasets de Studio. |
| Pre-fetch de expedientes en architect | Pre-fetch de las entidades que existan en el dominio Studio. |
| Citas con folio (`exp. 24.018 fl. 1.247`) | Citaciones con tu propio formato (run_id, dataset_version, etc.). |

### 3.3 Lo que NO hay que copiar

- **Audio del board** — específico de CL2, requiere ElevenLabs y casos de uso "asesor en el carro". Studio puede tenerlo después si tiene sentido.
- **SilCitePickerModal** — específico de citaciones legislativas costarricenses.
- **VoiceCaptureModal** — útil pero opcional, depende del workflow de Studio.

### 3.4 Decisiones que tomamos en CL2 y revisaríamos para Studio

- **Edge libre vs DAG**: en CL2 el canvas no tiene aristas — los nodos son páginas independientes. En Studio, dado que ya existe LM-Nodes con DAG ejecutable, vale la pena considerar si el Notebook tiene aristas conceptuales (entre páginas que dependen de otras) o si se mantiene libre y la ejecución sigue en LM-Nodes.
- **Selected node como contexto de chat**: en CL2 se pasa el contenido del nodo seleccionado al system prompt. Studio puede heredar esto exactamente.
- **Dimensions de nodo libres**: CL2 deja al usuario resize libre. Considerar si Studio quiere un grid invisible para alineación más estricta.

---

## 4. Cerebro — el cerebro compartido que hace que esto compongan

Aquí está el punto que el documento debe dejar **claro**: **CL2 y Studio no son productos independientes que comparten librería. Comparten un cerebro vivo (Cerebro), y cada Workspace que se construye en uno mejora a ambos.**

### 4.1 Qué es Cerebro

Cerebro es el SDK + servicio multi-tenant que vive en `https://shift-cerebro.up.railway.app`. Implementa:

- `/v1/chat/stream` — streaming chat completion con tools, deep insight, scope prompts
- `/peaje/ingest` — pattern extractor que convierte conversaciones reales en "insights" (4 macro buckets: estilo, vocabulario, prioridades, criterios de evidencia)
- `/v1/punto-medio/get_dynamic_rag` — read-side: devuelve patrones aprobados que se inyectan al system prompt
- `/v1/lightrag/query` — knowledge-graph augmentation
- `/v1/agents/{tenant}/{agent_id}` — config del agente (persona, tools, deep_insight settings)

**Modelo multi-tenant:** cada producto se conecta como un tenant. Hoy Cerebro tiene `cl2` activo. Studio se conecta como `studio` cuando esté listo.

```
Cerebro (Railway, v3.2.0-architect)
├── tenant: cl2
│   ├── agents: lexa, atlas, centinela
│   └── lineamientos del cliente CL2
├── tenant: studio   ← cuando se conecte
│   ├── agents: ej. notebook-architect, dataset-explainer
│   └── lineamientos del cliente Studio
└── shared substrate
    ├── Pattern extractor (Kimi K2.6) — corre por tenant pero el modelo es el mismo
    ├── PII redaction layer 2 — corre por tenant
    └── Punto Medio insights table — separado por tenant_id, pero el SCHEMA es compartido
```

### 4.2 Cómo Workspace en CL2 alimenta a Cerebro hoy

Hoy en CL2, cada turno de chat (incluido el del Workspace) dispara un **Peaje ingest** vía `firePeajeIngest()` en `apps/api/src/services/peajeClient.ts`:

```
1. Usuario manda un mensaje en el workspace
2. Lexa/Atlas responde (streaming)
3. Al terminar, fire-and-forget POST a Cerebro:/peaje/ingest
   con { sessionId, agentId, messages, response, tenantId: 'cl2' }
4. Cerebro corre Pattern Extractor (LLM) sobre la conversación
5. Extrae 1-N "insights" categorizados en 4 buckets
6. Persistidos en peaje_insights del tenant cl2
7. Manual review gate (admin/punto-medio) los aprueba o rechaza
8. Aprobados se vuelven parte del dynamic_rag del tenant
9. La próxima vez que un usuario CL2 pregunta algo, getApprovedRag() trae los patterns aprobados
10. Se inyectan al system prompt como [Inteligencia institucional Shift]
```

**Resultado**: cada hora que un asesor pasa en CL2 mejora cómo Lexa/Atlas/Centinela responden a TODOS los users de CL2. Es flywheel de uso → mejor producto.

### 4.3 La parte que Studio compone con CL2 a través de Cerebro

Acá está el punto que vale dejar explícito porque es lo que hace que esto sea **un sistema de inteligencia que crece simultáneamente, no dos productos paralelos**.

**El insight**: aunque las conversaciones de CL2 son legislativas y las de Studio son de otro dominio, hay **patterns generales de "cómo trabaja un profesional con IA en un workspace"** que se extraen IGUAL en ambos:

- Estilo de pedido (concisión, tono, detalle)
- Vocabulario propio del despacho/equipo
- Criterios de qué evidencia aceptan o rechazan
- Patrones de re-ask (cuando el usuario pide una segunda iteración, qué cambia)
- Patrones de selección (qué partes del contexto son las que más se usan)

Cuando Studio se conecta como tenant a Cerebro, **el Pattern Extractor que aprende de CL2 ya está afinado**. La calidad de extracción que toma 6 meses de iteración en un solo producto, Studio la hereda al primer commit.

Ejemplo concreto:

```
CL2 detecta (después de 1.000 conversaciones):
  Pattern: "los usuarios castigan respuestas que abren con 'Claro, te ayudo con eso'.
            Prefieren respuestas que abren directo con el dato."

Studio se conecta como tenant nuevo:
  Pattern extractor fires sobre las primeras 100 conversaciones.
  El MODELO que lo extrae ya tiene la categoría "abridores conversacionales" rodada.
  Empieza a clasificar bien desde la primera ingest.
```

Lo que NO se comparte entre tenants:
- Los insights específicos (no entrenamos el modelo de Studio con datos de CL2)
- Los lineamientos del cliente (cada despacho/equipo tiene los suyos)
- Los datasets de RAG (cada tenant tiene su propio corpus)

Lo que SÍ se comparte:
- El motor que extrae insights (modelo + prompt + categorización)
- La arquitectura de inyección (cómo los insights se vuelven dynamic_rag)
- Los eval suites (tests sobre el pattern extractor que cubren casos genéricos)
- El ciclo de mejora (cada vez que CL2 detecta un caso que el extractor falla, lo arreglamos en el motor; Studio se beneficia automáticamente)

### 4.4 Concretamente para Studio: qué wires hacer al implementar Workspace

Cuando Studio implemente su tab Workspace siguiendo este pathway, los wires con Cerebro son:

**Wire 1 — al final de cada chat turn:**
```ts
// en el equivalente de apps/api/src/routes/chat.ts (o el smart turn) de Studio:
import { firePeajeIngest } from './services/peajeClient.js';

// después de que el chat termine de streamear:
void firePeajeIngest({
  sessionId: conversationId,
  agentId: agent.id,
  messages: prior,
  response: assistantText,
  tenantId: 'studio',  // ← tenant nuevo, no 'cl2'
});
```

**Wire 2 — al armar el system prompt de cada turn:**
```ts
import { getApprovedRag } from './services/puntoMedioClient.js';

const dynamicRag = await getApprovedRag({
  tenant: 'studio',
  agent_id: agent.id,
  // optional: query context for filtering
});

// inyectar en system prompt si dynamicRag.combined_rag.length > 50
```

**Wire 3 — Cerebro tenant config:**

Studio necesita su propia config en `packages/cerebro-config/agents/` (o equivalente). Mínimo:
- 1 agent yaml por agente (notebook-architect, dataset-explainer, etc.)
- Cada agent.yaml define: persona, tools, deep_insight settings, response_contract, guardrails
- Las tools native de Workspace (`workspace_build_nodes`, `workspace_edit_node`, `generate_presentation`) son reutilizables tal cual

**Wire 4 — Schema en Cerebro Postgres:**

Un solo INSERT en `tenants` table de Cerebro:
```sql
insert into tenants (tenant_id, display_name, created_at) values ('studio', 'Shifty Studio', now());
```

Después, peaje_insights y dynamic_rag se ramifican automáticamente por tenant_id.

### 4.5 Cuándo Studio empieza a notar el flywheel

Estimado — basado en cómo CL2 fue evolucionando:

| Mes desde que Studio activa Workspace + Peaje | Lo que Studio ve |
|---|---|
| Mes 0 (lanzamiento) | El extractor está funcionando pero los insights aún no están aprobados. dynamic_rag vacío. Calidad base = la del modelo + tools. |
| Mes 1 | Primeros 30-50 insights aprobados. Calidad mejora ~10% en métricas internas. Los abridores conversacionales se afinan, las respuestas pierden filler. |
| Mes 3 | 200-300 insights. Empieza a haber patterns sobre cómo el equipo Studio prefiere recibir el trabajo (formato de output, longitud, ejemplos). Calidad mejora ~25%. |
| Mes 6 | 500+ insights. El sistema ya tiene "voz de despacho" para Studio. Los users sienten que la herramienta los conoce. |

Lo importante es que **CL2 y Studio aceleran juntas**: cada vez que arreglamos un bug del extractor (porque CL2 lo detectó), Studio se beneficia automáticamente. Cada nuevo bucket que añadimos a la categorización (porque Studio detectó un caso nuevo), CL2 lo gana.

---

## 5. Implementation pathway concreta para Studio

Si tuviera que dar un orden de tareas para llevar este Workspace a Studio:

**Sprint 1 — schema + chrome (1 semana)**
- [ ] Migration: `studio_workspaces` + `studio_workspace_nodes` (mismo schema que CL2)
- [ ] BFF: 4 rutas CRUD (`GET / POST / PATCH / DELETE`)
- [ ] Frontend: WorkspaceCanvasPage con ReactFlow + 1 tipo de nodo (texto plano)
- [ ] Auto-save funcional

**Sprint 2 — TipTap + AI primitives (1 semana)**
- [ ] HojaNode con TipTap StarterKit + slash extension + format menu
- [ ] BFF: `POST /:id/transform` (selección → reescritura LLM)
- [ ] BFF: `POST /:id/architect` (build multi-hoja desde prompt)
- [ ] Atlas-equivalent agent con tools `workspace_build_nodes`, `workspace_edit_node`

**Sprint 3 — chat lateral + smart turn (3-4 días)**
- [ ] LexaContextPanel-equivalent panel lateral
- [ ] BFF: `POST /:id/turn` con classifier → execute pattern
- [ ] Streaming SSE del chat
- [ ] Hoja content injection en scope_system_prompt

**Sprint 4 — import + export (3-4 días)**
- [ ] Asset import multipart (PDF, DOCX, imagen, audio si aplica)
- [ ] Re-extract endpoint para archivos importados
- [ ] Export md, docx
- [ ] Export pptx via Gamma con PptxOptionsModal

**Sprint 5 — Cerebro wires (1-2 días)**
- [ ] Crear tenant 'studio' en Cerebro
- [ ] Migrar agent yamls a packages/cerebro-config/agents/
- [ ] Wire firePeajeIngest al final de cada turn
- [ ] Wire getApprovedRag al inicio de cada turn
- [ ] Verificar que peaje_insights se popula con tenant='studio'

**Sprint 6 — UX polish (1 semana)**
- [ ] Onboarding del primer workspace
- [ ] Slash commands específicos del dominio Studio
- [ ] Voice capture si aplica al workflow
- [ ] Quota dashboards

**Total estimado: 5-6 semanas de un desarrollador full-time** con acceso al codebase de CL2 como referencia.

---

## 6. Lo que sí importa repetir

- **El Workspace no es un canvas Notion**. Es un canvas con tres agentes que viven adentro.
- **El stack es público y portable**. No hay dependencia secreta.
- **Cerebro es lo que hace que esto sea un sistema, no un producto**. Cada conversación que ocurre en cualquier tenant mejora el motor para todos los tenants.
- **Studio gana mucho del trabajo de CL2**. El extractor está rodado, las primitivas (build, edit, transform, turn) están probadas, los esquemas están vivos en producción.
- **CL2 va a ganar mucho de Studio**. El día que Studio detecte un pattern que CL2 nunca vio (porque su dominio es distinto), ese pattern se vuelve mejor categorización para los dos.

---

## 7. Referencias para deep-dive

| Tema | Archivos en CL2 |
|---|---|
| Canvas + ReactFlow | `apps/web/src/pages/WorkspaceCanvasPage.tsx` |
| Hoja node + TipTap | `apps/web/src/components/hoja/HojaNode.tsx` + extensiones |
| BFF rutas | `apps/api/src/routes/workspace.ts` |
| Architect (Atlas) | `apps/api/src/routes/workspace.ts` líneas ~2070-2230 (`runArchitect`) |
| Smart turn | `apps/api/src/routes/workspace.ts` líneas ~2280-2790 |
| Pptx export | `apps/api/src/services/workspacePptxExport.ts` |
| Cerebro client | `apps/api/src/services/cerebroClient.ts` |
| Peaje (write) | `apps/api/src/services/peajeClient.ts` |
| Punto Medio (read) | `apps/api/src/services/puntoMedioClient.ts` |
| Atlas agent yaml | `packages/cerebro-config/agents/atlas.yaml` |
| Doc agentes general | `docs/AGENTS.md` |
| Doc plataforma | `docs/PLATFORM_GENESIS.md` |

---

## Apéndice A — el patrón de scope_system_prompt

El truco que hace que el chat dentro del workspace sea útil es que el system prompt no es estático. Se compone en runtime con el contexto del canvas:

```ts
const scopeSystemPrompt = [
  ws ? `[Workspace actual] "${ws.title}"...` : '',
  canvasReadingRules,                                // override anti-hallucination
  selNode ? `[Hoja seleccionada] "${selNode.title}":\n${selBody}` : '',
  ...hojaBlocks,                                     // hasta 8 hojas con contenido
  ...assetBlocks,                                    // hasta 3 docs con extracted_text
  hojaToitles.length > N
    ? `[Hojas adicionales (titles only)] ...`
    : '',
  `Para preguntas factuales que NO se refieren al canvas, usá las tools.`,
].filter(Boolean).join('\n\n');
```

Esto le da a Lexa la habilidad de leer todo lo que el usuario tiene en su canvas SIN tener que llamar tools. Las tools quedan para preguntas factuales sobre el corpus general (SIL/Reglamento).

**Para Studio**: este patrón aplica idéntico, solo cambia qué se mete en el `scope_system_prompt` (en lugar de hojas legislativas → notebooks de análisis, datasets, modelos, etc.).
