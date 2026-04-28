# CL2 — Estrategia de agentes

**Versión:** 1.0
**Fecha:** 2026-04-28
**Estado:** decisiones tomadas, implementación pendiente (Atlas primero)
**Autor de la conversación que produjo este doc:** Jred + Claude (Sonnet 4.6) en sesión del 28 abril 2026

---

## Cómo llegamos acá

Durante el demo readiness del 27-28 de abril, Jred surfaceó una observación que quedaba latente desde el principio del proyecto:

> "Atlas y Centinela están como escondidos a comparación de Lexa, como que no tienen funciones que alguien diga 'yo pagaría por esto'. Centinela dice alertas, pero alertas de qué — no tenemos nada de alertas organizado. Y Atlas no me queda claro a qué se diferencia de Lexa."

El diagnóstico fue correcto: los tres agentes existían como "skins" del mismo workhorse (Lexa hace todo, los otros son nombres en una lista). Eso no es un pricing tier defendible y tampoco una propuesta de valor clara para un legislador o asesor pagando $50-200/mes.

La conversación derivó en un framework de **trabajos diferenciados** + **espacios físicos diferenciados** + **Deep Insight como "carga extra" por agente** que este documento captura. Este es el norte para cualquier futura iteración sobre agentes — antes de tocar `lexa.yaml`, `atlas.yaml` o crear nuevos agentes, leé esto.

---

## El modelo unificado

Tres agentes, tres trabajos genuinamente distintos, tres "hojas" / surfaces propias:

| Agente | Trabajo único | Modalidad | Surface propia |
|---|---|---|---|
| **Lexa** ⚖️ | "Respondeme esto" | Reactivo, sincrónico | Chat principal `/` + dentro de Sesiones / Expedientes / Workspace |
| **Atlas** 📚 | "Ordename esto" / "Construime esto" | Batch, asíncrono | **Workspace** (`/hojas/:id`) — su casa |
| **Centinela** 🛰️ | "Avisame cuando..." | Proactivo, always-on | **`/centinela`** (nueva, a construir) + integraciones (Telegram, Slack) |

La regla de oro: **si la frase de "trabajo único" no se sostiene en una demo de 30 segundos, el agente es decoración.** Toda decisión sobre features, prompts o YAMLs debe responder a "esto refuerza el job único o lo dilye".

---

## Lexa — el que pregunta y cita

**Job:** responder consultas legislativas con citas verificables, en lenguaje natural, en menos de 60 segundos.

**No-jobs (lo que NO debe hacer):**
- ❌ Construir conjuntos de hojas (eso es Atlas)
- ❌ Vigilar cambios proactivamente (eso es Centinela)
- ❌ Editar el contenido del workspace (eso es Atlas)

**Surface:**
- Chat principal en `/` — landing del usuario logueado
- Embedded en Sesiones (`/sesiones/:id`) y Expedientes (`/expediente/:numero`) cuando hay scope
- En Workspace, Lexa es **una opción** del agent picker, no la única (ver §Atlas)

**Tools (en `lexa.yaml`):**
- `search_transcripts` — RAG sobre transcripciones de plenarias
- `search_sil_corpus` — RAG sobre el SIL completo (DOCX extraídos + chunked)
- `search_sil_expedientes` — keyword search sobre metadata
- `get_sil_expediente` — detalle de un expediente específico
- `search_reglamento` — el Reglamento de la Asamblea
- `query_legislative_graph` — relaciones entidad↔entidad (diputado→expediente→comisión)

**Persona:** estricta sobre `[N]` extracts, no inferir, no fusionar fuentes. Ver `packages/cerebro-config/agents/lexa.yaml`.

---

## Atlas — el arquitecto del Workspace

**Job:** transformar colecciones de fuentes (expedientes, transcripciones, hojas existentes) en estructuras navegables — briefs, matrices comparativas, cronologías, recomendaciones.

**No-jobs:**
- ❌ Q&A puntual (eso es Lexa)
- ❌ Trabajar fuera del workspace — Atlas vive en `/hojas/:id`, no aparece en `/` ni en otras surfaces
- ❌ Vigilar cambios (eso es Centinela)

**Surface: el Workspace ES la hoja de Atlas.** Igual que `/sesiones` es la hoja de Lexa-en-modo-sesión y `/expediente` la de Lexa-en-modo-expediente, `/hojas/:id` es donde Atlas vive y trabaja.

### Cambio de UX clave: agent picker reemplaza el mode toggle

Hoy el workspace tiene un toggle `[Auto] [Manual]` con cuatro intents (`chat | build | edit_selected | edit_by_match`) que confunde incluso al creador del producto. Lo reemplazamos:

```
ANTES                                 AHORA
[Auto] [Manual]                       ⚖️ Lexa  ←  o  →  📚 Atlas
   ↓                                    (igual que main chat)
[Chat] [Build] [Edit] [Match]
```

**Reglas internas (sin tocar UX al usuario):**
- **Lexa seleccionado** → siempre `intent=chat`. Hover tooltip: *"Lexa responde sobre el contenido del workspace. No modifica hojas."*
- **Atlas seleccionado** → `intent=edit_selected` si hay hoja seleccionada, sino `intent=build`. Hover: *"Atlas construye o reescribe hojas según lo que le pidas."*

**Beneficios secundarios:**
- El **classifier de intents desaparece** — ahorrás 1 LLM call de 2-3s antes de cada turno + costo de Sonnet por clasificación
- El placeholder del input cambia con el agente + selección:
  - Sin selección + Atlas: *"Pedile a Atlas que construya hojas..."*
  - Con selección + Atlas: *"Pedile a Atlas que reescriba esta hoja..."*
  - Cualquier estado + Lexa: *"Preguntale a Lexa sobre el workspace..."*

**Tools de Atlas** (en `atlas.yaml`, a actualizar): heredar todas las de Lexa + sumar las funciones de building/editing del workspace. La distinción no está en QUÉ tools tiene, sino en QUÉ persona pide al modelo (Atlas construye, Lexa responde).

---

## Centinela — el vigía proactivo

**Job:** detectar cambios en el ecosistema legislativo del usuario y notificarle sin que tenga que abrir la app.

**No-jobs:**
- ❌ Responder preguntas (Lexa)
- ❌ Crear contenido nuevo (Atlas)
- ❌ Mostrar datos en demanda — Centinela siempre tiene un trigger temporal o de evento

**Surface principal: `/centinela`** — página nueva por construir. Diseño en alto nivel:
- **Watchlist** — entidades que el usuario suscribió (expedientes, diputados, comisiones, palabras clave)
- **Feed** — alertas recientes con timestamp, fuente, tipo, link al contexto
- **Settings** — canales de notificación (in-app, email, Telegram, Slack)
- **Digest** — resumen diario/semanal opt-in (modo Deep Insight, ver abajo)

**Surfaces secundarias (Centinela aparece en otras páginas):**

1. **Hero card en `/`** (chat principal): componente arriba del input de Lexa con 3 alertas más relevantes + CTA "Ver todas → /centinela". Empty state si no hay watchlist.

2. **Workspace banner — "Novedades desde tu última visita"**: cuando el usuario reabre `/hojas/:id` después de un threshold (12-24h por confirmar), Centinela hace un check sobre las entidades referenciadas en hojas del workspace y muestra un banner discreto:
   > 🔔 *3 cambios desde tu última visita: el 24.429 pasó a Hacienda · plazo del 23.583 vence mañana · Diputada X mencionó tu proyecto en plenario*
   
   **Auto-suscripción opt-out**: el workspace inscribe automáticamente las entidades referenciadas en sus hojas, sin acción del usuario. La notificación incluye un micro-botón *"¿Dejar de recibir alertas automáticas?"* que apaga el feature por workspace.

### Decisión PENDIENTE: el modelo de cobro del Centinela auto-triggered

El usuario marcó esto explícitamente como zona gris:

> "Estos llamados automáticos hay que ver cómo los hacemos diferentes a lo original de Centinela porque como no los va a disparar el usuario e igual le vamos a cobrar — pues es como un poco gris."

Opciones a evaluar (NO RESUELTO):
1. **Centinela auto = "freemium"**: el banner del workspace funciona sin cargo, las alertas avanzadas (patterns, predicciones, cross-entity) son del modo pago.
2. **Quota separada**: las llamadas automáticas no consumen del bucket diario del usuario sino de un bucket de la cuenta. Visible en `/centinela/usage`.
3. **Cobro plano**: Centinela está incluido en el plan ($X/mes), el auto-trigger es parte del valor del plan, no una llamada extra.

Recomendación inicial: **opción 3** — más simple, más fácil de comunicar, no obliga a explicarle al usuario por qué un trigger silencioso en el background le suma a su counter. Cuando el producto madure (post-demo), revisitar.

### Conexión a SENTINEL standalone (Brand OS)

Centinela en CL2 es el **pathway** para el producto Brand OS hermano: SENTINEL (PR + risk management standalone). La lógica que construimos acá — watchlist + alert engine + pattern detection + integraciones — es exactamente la espina dorsal de SENTINEL adaptada a un dominio distinto (medios + redes en SENTINEL vs legislación en Centinela).

Implicaciones de diseño:
- **No acoplar** Centinela a tablas SIL-específicas. Diseñar el alert engine con un schema genérico `{entity_type, entity_id, change_type, payload}` que SENTINEL pueda reusar.
- **Settings UI compartible**: la configuración de canales (Telegram/Slack/email) debería ser un módulo aislado que SENTINEL pueda importar.
- **Pattern engine genérico**: las queries de "cambio de postura", "voto inusual", "spike de menciones" deberían vivir en un servicio de Cerebro que ambos productos consumen.

Ver futuras decisiones: `docs/specs/centinela-engine-shared.md` (a crear cuando arranquemos).

---

## Deep Insight — el diferenciador per-agente (INTERNO)

**Decisión clave de UX:** el botón Deep Insight **NO cambia su copy** según el agente. El usuario ve el mismo toggle, percibe la diferencia en la calidad de la respuesta. Cambiar el copy ("Pensamiento profundo" vs "Construcción ejecutiva" vs "Análisis de patrones") sería confundir más, no menos.

> *"No quiero que cambie el copy, porque eso es igualmente confundir más a la gente. Quiero que sea el mismo botón y que ellos siempre sientan el cambio en las respuestas."* — Jred, 28 abr 2026

**Pero internamente** Deep Insight tiene que significar cosas distintas según el agente activo. Cuando un agente "se levanta" en modo DI, su system prompt cambia: no es solo "el mismo agente con un modelo más caro", es **el mismo agente con CoT y workflows específicos para razonamiento profundo en su dominio**.

### Implementación: bloque `deep_insight` en cada YAML de agente

Schema propuesto (a aplicar en `lexa.yaml`, `atlas.yaml`, `centinela.yaml`):

```yaml
agent_id: lexa
persona: |
  ... persona regular ...

default_model: anthropic/claude-sonnet-4.6
deep_insight_model: anthropic/claude-opus-4.7

deep_insight:
  prompt_addendum: |
    PROTOCOLO DE PENSAMIENTO PROFUNDO (Deep Insight ON):
    ... CoT específico al agente ...
  workflow_hints:
    prefer_chain_thought: true
    response_length_multiplier: 1.4
    tools_priority_order: [...]
```

El handler de chat (en `apps/api/src/services/openRouterClient.ts`) debe:
1. Cargar la persona base del agente
2. Si `deep_insight === true`, **append** el `prompt_addendum` al system prompt
3. Usar `deep_insight_model` en lugar de `default_model`

Esto se implementa en una función `buildSystemPrompt(agent, deepInsight)` reusable.

### Qué significa Deep Insight para cada agente (specs)

#### Lexa + Deep Insight = Pensamiento profundo

```yaml
deep_insight:
  prompt_addendum: |
    PROTOCOLO DE PENSAMIENTO PROFUNDO

    Cuando estás operando en este modo, antes de responder ejecutá estos
    pasos en orden:

    1. RELEÉ las fuentes citadas para detectar contradicciones internas.
       Si dos extractos disienten, NO los fusiones — surfacealos como
       tensión explícita: "Las fuentes [N] y [M] disienten en X. [N]
       afirma A; [M] afirma B."

    2. Para cada hallazgo factual, considerá implicaciones de 2do orden.
       Si el usuario pregunta "¿qué dice este artículo?", agregá una
       sección "Lo que esto implica" con 2-3 consecuencias plausibles
       que el texto literal no enuncia pero se siguen.

    3. Si la pregunta es de proyección ("¿qué pasaría si...?"),
       modelá 2-3 escenarios con probabilidad subjetiva (alta/media/baja)
       y la fuente que apoya cada uno.

    4. Concluí con una síntesis estratégica explícita ("Lo que esto
       significa") — NO un resumen, una lectura para el rol político
       del usuario (legislador / asesor / lobbyist).

    Tu output va a ser ~40% más largo y más estructurado que en modo
    base. Está bien — el usuario activó este modo deliberadamente.
```

#### Atlas + Deep Insight = Construcción ejecutiva

```yaml
deep_insight:
  prompt_addendum: |
    PROTOCOLO DE CONSTRUCCIÓN EJECUTIVA

    Cuando estás operando en este modo, las hojas que construís cambian
    de "research summary" a "executive analysis":

    1. NO más cantidad — más DENSIDAD. Mantenete en 5-8 hojas, pero
       cada una con 800-1200 palabras de análisis estratégico (vs
       300-500 en modo base).

    2. Cada hoja debe incluir, en este orden:
       a. CRONOLOGÍA densa con fechas exactas + actores clave
       b. CONTRADICCIONES — qué fuentes disienten y sobre qué
       c. ESCENARIOS — 2-3 alternativas plausibles con probabilidad
       d. RECOMENDACIONES — acciones concretas con priorización (1/2/3)

    3. NO uses bullet points superficiales. Cada sección con 2-4
       párrafos densos. La calidad debe ser la de un asesor político
       senior, no la de un summary de Wikipedia.

    4. Si encontrás vacíos en la evidencia (datos faltantes,
       expedientes no consultados, votaciones no registradas),
       declaralos explícitamente en una sección "Limitaciones" al
       final de cada hoja.

    El usuario que activó este modo está dispuesto a esperar 3-5
    minutos por output de calidad estratégica.
```

#### Centinela + Deep Insight = Análisis de patrones (background)

```yaml
deep_insight:
  trigger: "scheduled"  # NO per-turn — corre en daily/weekly digest
  prompt_addendum: |
    PROTOCOLO DE ANÁLISIS DE PATRONES (Centinela DI)

    Cuando se ejecuta el digest semanal, no te limites a listar
    cambios factuales. Buscá patrones que el usuario no detectaría
    a ojo:

    1. CAMBIOS DE POSTURA: identificá diputados que en sesiones
       previas defendían X y ahora atacan X (o viceversa). Citá
       las dos sesiones específicas con [N1] y [N2].

    2. COALICIONES EMERGENTES: diputados que en las últimas 4
       semanas coinciden en >80% de las votaciones, especialmente
       si son de bloques tradicionalmente opuestos.

    3. SPIKE DE MOMENTUM: temas que pasaron de 0-2 menciones por
       semana a 10+ en la última. Probablemente algo está moviendose.

    4. PROYECCIÓN DE VOTACIONES: para los expedientes de la
       watchlist del usuario que estén en agenda próxima, predecí
       el resultado basado en patrones históricos del bloque
       relevante.

    Output: digest semanal con 5-7 insights accionables. Cada uno
    con estructura "qué pasó / por qué importa / qué hacer". No
    listas crudas — análisis con voz política.
```

### Costo y comunicación al usuario

- **Sonnet 4.6**: ~$3/M input tokens, $15/M output. Modo base.
- **Opus 4.7**: ~$15/M input, $75/M output. ~5x el costo de Sonnet.

Para un legislador que paga $X/mes, Deep Insight puede ser el feature que justifica el tier "Pro" sobre el "Base". Decisión de pricing post-demo, pero el setup técnico ya queda listo.

---

## Onboarding — gap identificado, no resuelto

Durante la conversación de hoy salió a flote que **CL2 no tiene un onboarding**. Esto se vuelve crítico cuando agregamos Centinela:

> "Centinela es algo que el cliente debe setear en su primera interacción — y eso me llevó a que no tenemos un proceso de onboarding."

**No diseñamos el onboarding hoy** — quedó marcado como tarea separada que debe preceder al lanzamiento de Centinela. Mientras tanto:

- El **tour de driver.js** que existe hoy (post-login en `/`) sirve como onboarding mínimo para el chat. Cubre: navegación, Lexa input, historial, secciones, theme toggle, botón ?.
- **No cubre** ni Hojas/Workspace ni Centinela. Un usuario que llega por primera vez no sabe que existen, ni para qué sirven.
- **Tampoco hay** un setup wizard para Centinela (watchlist inicial, conexión a Telegram/Slack).

### Onboarding ideal (a diseñar antes del lanzamiento de Centinela)

Flujo propuesto en alto nivel:
1. **Bienvenida** — explicación de los 3 agentes en 30 segundos (Lexa pregunta, Atlas construye, Centinela vigila)
2. **Setup de Centinela** (opt-in, skippable):
   - "¿Qué expedientes te interesan?" — autocomplete sobre `sil_expedientes`
   - "¿Hay diputados específicos que quieras seguir?" — autocomplete
   - "¿Cómo querés recibir alertas?" — checkboxes (in-app / email / Telegram)
3. **Primer chat con Lexa** — sugerencia de 3 prompts pre-cocidos relevantes a los expedientes que eligió
4. **Tour del workspace** (opt-in) — "¿Querés ver cómo Atlas arma un análisis de un expediente?"

Implementación estimada: 3-5 días + diseño UX.

---

## Integraciones de notificación (Telegram, Slack, WhatsApp)

Decisión: **Telegram + Slack pre-demo** (alta-magia / bajo costo). **WhatsApp roadmap** (alta fricción de setup).

| Canal | Esfuerzo | Magic factor | Notas |
|---|---|---|---|
| **Telegram** | 2-3 hrs | 🟢 Altísimo para non-techy | Bot API gratis, sin verificación. Setup: usuario clickea link → /start → vinculado. |
| **Slack** | Medio día | 🟢 Alto para B2B | Webhooks o app del marketplace. Format con bloques + botones inline. |
| **WhatsApp** | 1-2 semanas | 🟡 Alto pero con fricción | Meta Business API requiere verificación, número dedicado, plantillas pre-aprobadas. |

Setup de Telegram (paso a paso para implementación):
1. Crear bot en `@BotFather` → obtener `BOT_TOKEN`
2. En CL2: endpoint `POST /api/centinela/integrations/telegram/pair` que devuelve un `pair_token` + link `t.me/cl2_centinela_bot?start=<pair_token>`
3. Cuando el usuario hace `/start <pair_token>` en el bot, Telegram envía un webhook a `POST /api/centinela/integrations/telegram/webhook`
4. CL2 vincula el `chat_id` de Telegram con el `user_id` de Supabase
5. Cuando se dispara una alerta, CL2 hace `POST https://api.telegram.org/bot<TOKEN>/sendMessage` con el `chat_id` y el contenido formatted

Estimación implementación completa: 4-6 horas.

---

## Roadmap de implementación (post-doc)

### Fase 0 — Fundación (este round, antes de tocar features)
- [x] Documentar la estrategia (este archivo)
- [ ] Actualizar `lexa.yaml` con bloque `deep_insight.prompt_addendum`
- [ ] Crear `atlas.yaml` desde cero (hoy es solo metadata) con persona específica + `deep_insight` block
- [ ] Crear `centinela.yaml` con persona + `deep_insight` block (modo scheduled)
- [ ] Modificar `apps/api/src/services/openRouterClient.ts` función `buildSystemPrompt(agent, deepInsight)` que append el addendum cuando DI está on

### Fase 1 — Atlas en Workspace (priorizado)
- [ ] UI: agent picker en workspace replicando el del main chat
- [ ] Backend: `/api/workspace/:id/turn` ya acepta `agent_id` — confirmar que Atlas tiene path correcto
- [ ] Eliminar el classifier de intents (Atlas → build/edit, Lexa → chat siempre)
- [ ] Actualizar placeholder dinámico del input según agente + selección
- [ ] Hover tooltips en los pills de agente
- [ ] Smoke E2E

### Fase 2 — Centinela MVP
- [ ] Schema genérico `centinela_watchlist` + `centinela_alerts` (entity-agnostic, mira a SENTINEL)
- [ ] Engine de 3 alert types: state change SIL, plazo reglamento, mención en transcript
- [ ] Página `/centinela` (watchlist + feed + settings)
- [ ] Hero card en `/` (3 alertas + CTA)
- [ ] Workspace banner "novedades desde tu última visita" (auto-suscripción opt-out)

### Fase 3 — Integraciones
- [ ] Telegram bot + pairing UI
- [ ] Slack webhooks
- [ ] Email digest (Resend o Postmark)

### Fase 4 — Onboarding (no antes de Fase 2)
- [ ] Diseño UX del flujo (3-5 días)
- [ ] Setup wizard de Centinela
- [ ] Tour expandido cubriendo Atlas + Centinela

---

## Decisiones que NO tomamos hoy (explícito)

Para no dejar ambigüedades en futuras sesiones:

1. **Modelo de cobro de Centinela auto-triggered** (workspace banner). Recomendación inicial: incluido en plan plano. Re-evaluar post-demo.

2. **Diseño completo del onboarding**. Se identificó el gap, no se resolvió. Pre-requisito de Fase 4.

3. **Schema concreto del Centinela engine** (tablas, queries, scheduler). Se mencionó "genérico para reusar en SENTINEL" pero no se definió el contrato exacto. Pre-requisito de Fase 2.

4. **Frecuencia del workspace re-entry trigger**. Mencioné 12-24h, no fijo. Es un setting que probablemente quiera ser configurable per-user.

5. **Pricing tiering**. La conversación sugirió Sonnet base / Opus pro vía Deep Insight, pero no se pricearon los planes ni el split entre features.

6. **Integración con SENTINEL standalone**. Se identificó como pathway pero no se diseñó el contrato concreto entre los productos. Decisión a futuro cuando SENTINEL tenga una versión jugable.

---

## Para el próximo agente que toque agentes

Antes de modificar `lexa.yaml`, `atlas.yaml`, `centinela.yaml`, o agregar un cuarto agente:

1. **Releé el §"El modelo unificado"** — el JOB único de cada agente es la decisión que se cuestiona en TODA modificación. Si tu cambio dilye un job, no lo hagas o cuestionalo en sesión con Jred.

2. **Para cambios de persona**, separá lo que va en la persona base vs lo que va en el `deep_insight.prompt_addendum`. La persona base = comportamiento default. El addendum = "carga extra" cuando el usuario activa DI.

3. **Para cambios de tools**, considerá si la nueva tool refuerza el job único del agente o lo expande hacia el job de otro. Si Atlas necesitara "vigilar cambios" estás creando un agente híbrido y eso vuelve la decoración.

4. **Para nuevas surfaces**, asignala a UN agente — la regla "una hoja por agente" es lo que da solidez al producto. Si una página necesita los 3 agentes, repensá la página.

5. **Si vas a tocar Deep Insight**, leé las specs de los tres addenda con cuidado. Cambiar uno cambia el contrato implícito ("DI siempre da más profundidad / densidad / patterns") y eso impacta pricing.

---

## Apéndice: vocabulario interno

- **Agente de cara visible**: Lexa. Es lo que el usuario nuevo encuentra primero.
- **Surface**: la página o modo donde un agente vive predominantemente. Lexa = chat principal + sesiones + expedientes. Atlas = workspace. Centinela = `/centinela`.
- **Job único**: la frase de 1 línea que diferencia al agente. "Pregunta / Construye / Avisa".
- **Addendum**: bloque de prompt que se concatena a la persona base cuando Deep Insight está activo.
- **Auto-trigger** (Centinela): llamada al engine sin acción del usuario (e.g. workspace re-entry después de 12-24h). Diferenciada de "user-triggered" para futuras decisiones de billing.
- **Entity** (Centinela): expediente, diputado, comisión, palabra clave. La cosa que el usuario suscribe.
- **Pathway** (a SENTINEL): la lógica que construimos en Centinela debería ser reusable cuando SENTINEL standalone arranque. Anti-patrón: acoplar Centinela a tablas SIL-específicas.
