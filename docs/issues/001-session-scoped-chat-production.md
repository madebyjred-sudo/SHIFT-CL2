# Issue #001 — Session-scoped chat: reemplazar duct tape por scope server-side

**Status:** open
**Priority:** P1 (post-demo 2026-05-08)
**Owner:** Jred
**Created:** 2026-04-25
**Affects:** `apps/web/src/components/animated-ai-input.tsx`, `apps/web/src/pages/SesionViewPage.tsx`, `apps/api/src/routes/chat.ts`

---

## Resumen

Cuando el usuario abre el chat dentro de `/sesiones/:id` (tab "Preguntar a Lexa"), Lexa debe responder con el contexto de esa sesión específica sin que el usuario tenga que pegar título o resumen.

**Solución actual (cinta adhesiva)**: el componente `AnimatedAiInput` acepta un prop `contextPrefix` (string) que se prepende al `query` antes de mandarlo a `/api/chat/stream`. La sesión-view construye ese prefijo con `[Contexto de la sesión actual] Sesión #N — título · fecha · resumen ejecutivo` vía `buildSessionContext(detail)`.

Funciona para el demo del 2026-05-08. **No es production-ready.**

## Por qué importa

El sentido de tener chat embebido en la sesión es que la conversación quede vinculada a esa sesión, sea trazable y eficiente en tokens. La implementación actual rompe esos tres puntos.

## Problemas concretos

### 1. Bloat conversacional (turno N = N copias del prefijo)
Cada mensaje del usuario reinyecta el bloque entero. Conversación de 10 turnos sobre la misma sesión → 10 copias del resumen ejecutivo en el historial del LLM. Token waste lineal y hace que las respuestas tardías pierdan foco.

### 2. Persistencia sucia
El prefijo se guarda dentro de `messages.content` en Supabase (la columna que `insertUserMessage` recibe). Consecuencias:
- Búsqueda full-text sobre el historial devuelve falsos positivos (matchea por el resumen, no por lo que el usuario preguntó).
- Export de conversación / citaciones muestran el bloque al usuario.
- Si mañana queremos analytics ("qué tipo de preguntas hace la gente"), está contaminado.

### 3. Stuffing en lugar de retrieval
Inyectamos resumen ejecutivo entero aunque la pregunta sea trivial ("¿a qué hora arrancó?"). Para preguntas profundas ("qué dijo el diputado X en minuto 45"), el prefijo **no alcanza** porque solo trae el resumen, no el transcript de 35K palabras.

### 4. Hilos mezclados
La pregunta cae en la conversación global del usuario, no en un hilo `session_id=71`. Sidebar de historial no agrupa por sesión. Mañana no sabés qué preguntaste sobre qué sesión.

## Solución propuesta (production-ready)

### A. Scope server-side (no en `user.content`)
```ts
// Frontend
streamChat({ scope: { sesion_id: 71 }, query: userTrimmed, ... });

// Backend (chat.ts)
const scope = body.scope; // { sesion_id?: number }
if (scope?.sesion_id) {
  const meta = await fetchSessionMeta(scope.sesion_id);
  systemMessages.push({ role: 'system', content: buildSessionSystemPrompt(meta) });
}
```
- El context block va como `system message`, no se persiste como turno del usuario.
- `messages.content` queda limpio.

### B. Conversaciones taggeadas
- Agregar columna `conversations.scope_sesion_id` (nullable).
- Frontend: al primer mensaje desde `/sesiones/71`, crear (o reusar) una conversation con `scope_sesion_id=71`.
- Sidebar agrupa: "Sesión #71 — 3 preguntas", "Sesión #86 — 1 pregunta", "General — 12".

### C. Tools en lugar de stuffing
Lexa tiene tools registrados (estilo OpenAI function calling / Anthropic tool use):
- `getSessionMeta(id)` → título, fecha, duración, estado
- `getResumen(id)` → 3 secciones parseadas (ya las parsea el BFF)
- `searchTranscript(id, query)` → top-K segmentos relevantes (requiere embeddings)
- `getTranscriptRange(id, from_s, to_s)` → segmentos en una ventana temporal

El sistema prompt le dice: "Tenés acceso a estas tools sobre la sesión #N actual. Usalas en lugar de inventar." → llama `getResumen` solo si pregunta por resumen. Llama `searchTranscript` para preguntas específicas.

### D. RAG sobre transcript (depende de C)
- `pgvector` en Supabase (ya disponible si está prendido).
- Pipeline: cuando llega una sesión nueva, embed los segmentos (output del BFF `wordsToSegments`) y persistir en `transcript_segments`.
- `searchTranscript` ejecuta similarity search top-5 + reranking por score.

## Acceptance criteria

- [ ] `chat/stream` acepta `scope: { sesion_id }` opcional.
- [ ] Cuando viene scope, BFF inyecta system message con metadata + tools disponibles. **No** se modifica `user.content`.
- [ ] `messages.content` en DB no contiene jamás bloques `[Contexto de la sesión actual]`.
- [ ] Conversaciones desde `/sesiones/:id` se crean con `scope_sesion_id` y aparecen agrupadas en el sidebar.
- [ ] Lexa puede responder "qué dijo X en minuto Y" usando tool `searchTranscript` o `getTranscriptRange`.
- [ ] Eliminar `contextPrefix` y `buildSessionContext` del frontend.
- [ ] Tests: integration que verifique que el system message se construye y que `messages.content` queda limpio.

## Plan de migración

1. **Fase 1** (post-demo, semana 1): A + B. Frontend deja de prepender; BFF inyecta system message; sidebar muestra agrupación. Sin RAG todavía — el system message lleva resumen ejecutivo entero como hace hoy. Esto **no** es worse-than-current y **arregla los 4 problemas estructurales**.
2. **Fase 2** (semana 2-3): C. Definir contrato de tools. Implementar handlers en BFF. Cerebro/openrouter prompt que registre tools.
3. **Fase 3** (semana 4+): D. Embeddings pipeline + `searchTranscript`. Coordinar con Cerebro pipeline existente para no duplicar.

## Riesgo si no se hace

- **Para el demo (2026-05-08)**: cero. La cinta funciona y se ve bien.
- **Post-demo**: cualquier feature que toque historial (búsqueda, export, analytics, multi-sesión side-by-side) hereda el bloat. Cuesta más arreglarlo después porque hay datos sucios en producción.

## Referencias

- Implementación cinta: `apps/web/src/components/animated-ai-input.tsx:88-115` (props `contextPrefix`, `placeholder`)
- Construcción del prefijo: `apps/web/src/pages/SesionViewPage.tsx` (`buildSessionContext`)
- Wiring: misma página, en el tab "Preguntar a Lexa"
- BFF chat: `apps/api/src/routes/chat.ts`
