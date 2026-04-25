# CL2 Demo Runbook — 2026-05-08

**Cliente:** Oscar Solano (Asamblea Legislativa de Costa Rica)
**Duración objetivo:** 12-15 min demo + Q&A abierto
**Presentador:** Juanma (Jred)
**Backup contact:** —

---

## 0. Pre-demo checklist (T-60 min)

Ejecutar en este orden, todo en máquina del presentador:

```bash
cd /Users/juan/Downloads/shift-cl2

# 1. Latest main
git status                              # debe estar limpio
git log --oneline -3                    # confirmar último commit

# 2. Install / build
npm install                             # idempotent
npm run typecheck                       # debe pasar 6/6 workspaces

# 3. Servicios up
npm run dev                             # web :5173, api :3001, worker idle

# 4. Smoke test
./scripts/smoke-demo.sh                 # debe ser all green
CL2_JWT="$(supabase auth get-session ...)" ./scripts/smoke-demo.sh

# 5. Verificar Cerebro Railway responde
curl -s https://shift-cerebro.up.railway.app/health | jq

# 6. Browser
# - Chrome incognito (sin extensiones que bloqueen youtube)
# - Tamaño 1920x1080
# - Zoom 100%
# - DevTools cerrado (a menos que Oscar pida ver SSE)
```

**Si algún check falla** → ver §4 Contingencias antes de demoar.

---

## 1. Setup pre-Oscar (T-15 min)

### 1.1. Pestañas pre-cargadas (en orden de uso)

1. `http://localhost:5173/` — landing post-login con chat general
2. `http://localhost:5173/sesiones` — lista de plenarias
3. `http://localhost:5173/sesiones/SESSION_ID_DEMO` — una sesión con resumen y citations interesantes ya cacheadas
4. `http://localhost:5173/sesiones/subir` — formulario de upload

> **TIP:** seleccionar `SESSION_ID_DEMO` con estos criterios: (a) duración 1-3h, (b) tiene resumen ejecutivo no vacío, (c) `transcripcion` URL válida, (d) tema "caliente" del momento (presupuesto, megaproyectos, derechos sociales).

### 1.2. Variables de demo

Anotar en una nota antes:
- Nombre de la sesión escogida
- Pregunta-reina para Lexa scoped (debe disparar 3+ citations)
- Pregunta-reina para Lexa general (debe disparar `search_transcripts` RAG)
- Timecode esperado para mostrar el seek (idealmente 1+ hora dentro del video)

### 1.3. Login

Loguearse **antes** de empezar. El demo arranca con app autenticada — la pantalla de login se enseña como "esto es lo que ven los usuarios autorizados", no se interactúa con ella.

---

## 2. Flow del demo (12-15 min)

### Acto 0 — Apertura (30 s)

> "Cerebro Legislativo 2.0 es una plataforma de inteligencia conversacional construida específicamente sobre el corpus de la Asamblea. La que ven hoy es la versión que va a usar tu equipo."

Abrir pestaña 1. **NO mostrar** la pantalla de login.

### Acto 1 — Sesiones index (1 min)

Click `Plenarias` → pestaña 2.

Puntos a destacar:
- "Cada card es una sesión real del archivo de `agentescl2.com` — pueden ver la fecha, duración, y si tiene resumen automático".
- Buscador funcional: tipear `presupuesto` y mostrar el filtrado.
- Hover una card: mostrar el lift visual + `aria-label` (no decir "aria", decir "los cambios visuales son consistentes con cómo estamos construyendo todas las interacciones").

### Acto 2 — Sesión + chat scopeado (4-6 min) ⭐ corazón del demo

Click una sesión (la elegida en §1.2) → pestaña 3.

**Layout:**
- Izquierda: video YouTube + 3 cards de resumen (ejecutivo, puntos clave, acuerdos).
- Derecha: tabs `Transcripción` ↔ `Preguntar a Lexa`.

**Flow:**

1. (15 s) Mostrar el resumen ejecutivo. "Esto se generó automáticamente a partir de la transcripción".
2. (30 s) Tab `Transcripción`: scroll, mostrar segmentos con timecodes. Buscar una palabra (e.g. `municipalidad`) y mostrar el filtrado.
3. (15 s) Click un segmento → el video salta al timecode (sin recarga visible — esto es D04, vale la pena destacar).
4. (1 min) Tab `Preguntar a Lexa`. Tipear la pregunta-reina scoped (ya preparada en §1.2). Lexa responde con streaming.
5. (1 min) Mostrar las **citations** abajo del mensaje. Click "X fuentes legislativas" para expandir. Cada card tiene timecode + comisión + similarity %.
6. (30 s) Click un timecode dentro del mensaje (las píldoras coral-rojas) → video salta. "Esto cierra el loop: pregunta → cita → evidencia visual en el video".
7. (30 s) Hacer una segunda pregunta de seguimiento sin re-explicar el contexto. Lexa la responde sabiendo que es la misma sesión.

> **PUNTO CLAVE:** "Cada conversación queda atada a la sesión. Si abren otra pestaña a otra sesión, ese chat es independiente. La sidebar las agrupa por sesión".

Abrir el sidebar (icono historial top-dock) — mostrar el agrupamiento "Sesión #N" arriba, conversaciones generales abajo.

### Acto 3 — Chat general + SIL + Deep Insight (3-4 min) ⭐ pico técnico

Volver a `/` → pestaña 1.

Selector de agente arriba: click en `Atlas`.

> "Lexa es especialista en lo que se DICE en plenarias. Atlas es especialista en el SIL — el Sistema de Información Legislativa. Cada agente tiene su propia persona y conjunto de herramientas, definidas en YAML; agregar un agente nuevo es escribir un archivo, no desplegar código".

**3.A — Query SIL básico (45 s)**

Tipear: `¿Qué proyectos de ley hay sobre <TEMA_HOT_DEMO>?` (e.g. "minería",
"reforma fiscal 2024", "violencia contra la mujer").

Atlas llama a `search_sil_expedientes`. Mostrar:
- Streaming de la respuesta con `[1]`, `[2]` inline.
- Citation cards al final: cada card es un **expediente del SIL** con badge
  coral, número Exp., estado, proponente, link "Ver en SIL" funcional.

Click "Ver en SIL" en una card → abre `consultassil3.asamblea.go.cr` con el
expediente real. **Acá viene el moment de claim crítico**:

> "Esto NO es un demo simulado. Estamos consultando 25 mil expedientes
> reales del SIL, indexados anoche. Cada cita es verificable contra la
> fuente oficial".

**3.B — Deep Insight (1.5 min)**

Toggle `Deep Insight` ON (botón shiny coral en la barra de input).

Hacer una pregunta analítica: `Compará los argumentos a favor y en contra
del Exp. <NUMERO_DEMO>`.

> **TIP:** elegir un expediente con dictamen de mayoría + minoría públicos.

Atlas (ahora con Opus 4.7) llama a `search_sil_corpus` (RAG semántico).
La respuesta es estructuralmente más rica: párrafos con argumentos
contrastados, citas a dictámenes específicos `[N]`, link al PDF
correspondiente.

> "El toggle Deep Insight cambia el modelo a Claude Opus y habilita la
> búsqueda semántica sobre el contenido completo de los proyectos. Para
> queries simples Sonnet alcanza; para análisis de fondo, Opus saca el
> jugo".

**3.C — Cross-domain (45 s, opcional)**

Si hay tiempo, hacer una pregunta que cruza SIL + plenarios:
`¿Qué dijo el diputado <NOMBRE> sobre el Exp. <NUM> en plenario?`

Atlas encadena `search_sil_expedientes` → `search_transcripts`. La respuesta
trae citations de los DOS tipos: una card SIL (badge coral) y una card de
transcripción (badge burgundy). El usuario ve la convergencia.

> **NO IDEAL** si el corpus RAG todavía está corto: si Lexa/Atlas dicen
> "no encontré X", redirigir el ejemplo a uno preparado en §1.2.

### Acto 4 — Subir sesión (1-2 min)

Click `Subir sesión` → pestaña 4.

Pegar URL de YouTube real de una plenaria reciente (idealmente una que NO esté en el archivo aún).

Submit → mostrar el banner de polling. Explicar: "el sistema baja el audio, transcribe con ElevenLabs, genera resumen automático, y la sesión aparece en el listado. Toma 5-15 minutos según duración".

> **NO esperar** a que termine durante el demo. Decir: "podemos cerrar esta pestaña, la sesión va a aparecer en `/sesiones` cuando esté lista. Volveremos a verla al final si terminó".

### Acto 5 — Cierre (1 min)

> "Lo que vieron es Sprint 2: chat multi-agente con citations verificables, video sincronizado al timecode citado, e ingestión nueva. Sprint 3 (4-6 semanas post-demo) reemplaza el worker legacy con pipeline propia y libera Atlas y Centinela para análisis de PDF y alertas push".

Pausar para Q&A.

---

## 3. Q&A anticipado

| Pregunta de Oscar | Respuesta corta |
|---|---|
| **¿Cuánto cuesta operarlo?** | OpenRouter: ~$0.005 por turno con Sonnet, ~$0.025 con Opus. Embeddings Vertex: ~$0.10 por sesión completa. Supabase free tier alcanza para arranque. Estimado total mensual con tu equipo (5-10 usuarios activos): $20-80. |
| **¿Quién ve los datos?** | Solo los usuarios que tu equipo crea en Supabase. JWT por sesión, RLS estricto en cada tabla. El BFF nunca expone keys al cliente. Datos en GCP us-central1. |
| **¿Y si el agente alucina una votación?** | Por contrato (`response_contract.refuse_if_no_evidence` en YAML), Lexa no responde sin citation. Si no hay evidencia en la transcripción, dice "no encontré". Centinela trae confidence score visible al usuario. |
| **¿Cuándo más sesiones?** | Fase B (post-demo, 4-6 semanas) construye pipeline propia: yt-dlp → ElevenLabs → Claude resumen → embedding pgvector. Quedaremos independientes del worker legacy. |
| **¿Pueden integrarlo con SICAL/SAEL?** | Posible vía REST. Atlas tiene tool `query_metadata` que apunta a `sessions`; agregar fuentes externas es escribir un nuevo tool en YAML. Diseño explícito para esto. |
| **¿Funciona en celular?** | Responsive baseline (sidebar drawer en mobile, video stacked top). No hay PWA aún — Sprint 4 si lo piden. |
| **¿Cómo agregamos un agente nuevo?** | YAML en `packages/cerebro-config/agents/`: persona, default_model, tools, response_contract. Reload del API. Mostrar `lexa.yaml` en pantalla si hace falta. |
| **¿Qué pasa si OpenAI/Anthropic suben los precios?** | OpenRouter desacopla del proveedor — cambiar el `default_model` en YAML y se prueba con otro. Soportamos Anthropic, OpenAI, Mistral, Google sin tocar código. |

---

## 4. Contingencias

### 4.1. Si `npm run dev` falla en el setup

- Verificar que `.env.local` tiene todas las keys (`OPENROUTER_API_KEY`, `SUPABASE_*`, `CEREBRO_*`).
- `npm install` desde la raíz (turbo handlea workspaces).
- Si pasa: `apps/api/dist` o `.turbo` cache corruptos → `rm -rf apps/api/dist apps/api/.turbo` y reintentar.

### 4.2. Si el smoke fail

- `/health/deep` rojo → leer la sección que falla:
  - **supabase** → verificar `SUPABASE_SERVICE_ROLE_KEY` y que el proyecto Supabase está vivo.
  - **openrouter** → verificar `OPENROUTER_API_KEY` y `https://openrouter.ai` no esté caído.
  - **vertex** → verificar `GOOGLE_APPLICATION_CREDENTIALS` apunta a un SA JSON válido.
  - **legacy** → `https://api.agentescl2.com` puede estar caído. Si pasa: el demo SE PUEDE HACER sin la pestaña 4 (subir). Las pestañas 1-3 funcionan con cache + Supabase.

### 4.3. Si Cerebro / OpenRouter se cae **durante** el demo

- El BFF emite `error` SSE con mensaje user-friendly (`'El proveedor del modelo está teniendo problemas. Reintentá en unos segundos.'`).
- Plan B: cambiar a otro agente (sus modelos pueden estar OK aunque uno falle).
- Plan C: hacer la pregunta sobre una sesión cacheada — el resumen ejecutivo ya está en pantalla, dirige la conversación a eso mientras el LLM se recupera.

### 4.4. Si el upload de YouTube falla en el demo (Acto 4)

- El endpoint loguea la respuesta cruda del legacy (`req.log.warn('uploads_register_no_id', { registered, triedPaths })`).
- Plan B: decir "el endpoint está listo y endurecido, hoy quiero mostrarles la mecánica visual antes de validar contra una URL real" → quedarse en el formulario sin submit.
- Plan C: mostrar `scripts/smoke-demo.sh` ejecutándose para que vean el rigor de testing.

### 4.5. Si el video no carga (YouTube IFrame API bloqueada)

- El `VideoPlayer` cae automáticamente al modo iframe-reload (D04 fallback).
- El seek funcionará pero recargará el iframe (300ms). No es ideal pero no rompe el demo.
- Si Oscar lo nota: "el reproductor se recarga porque la red bloqueó el script de YouTube — en producción usaremos otro CDN".

### 4.6. Si la sesión scopeada da resultados pobres

- Es **keyword search**, no semantic (Sprint 2 trade-off).
- Cambiar a otra query con palabras más específicas y técnicas.
- Si insiste en una pregunta abstracta: "ese tipo de query será semántico en Sprint 3 cuando los embeddings de la sesión estén indexados".

---

## 5. Post-demo

1. **Mensaje de seguimiento** a Oscar dentro de las 24h con:
   - Resumen visual (1 screenshot por acto).
   - Próximos pasos concretos (Fase B + timeline).
   - Una pregunta open-ended para mantener el thread vivo.
2. **Capturar feedback** mientras está fresco — escribir en `docs/feedback/oscar-2026-05-08.md`.
3. **Snooze el repo de demo** por 48h: NO hacer cambios disruptivos sin confirmar con Juanma — Oscar puede querer una segunda demo o ver el repo.

---

## 6. Métricas a vigilar después

- API logs en `request` events: `ms` por turno (objetivo P95 < 5s sin tools, < 12s con tool calls).
- Errores `userFacingError` por código: si `upstream` o `rate_limit` aparecen mucho, hay tema.
- `health_deep_degraded` warnings: cualquier subsistema en rojo más de 5 min → escalar.

---

**Fin del runbook — v1.0 (2026-04-25)**

Mantenedor: Juanma. Cualquier cambio al flow del demo DEBE editarse acá antes
del próximo run.
