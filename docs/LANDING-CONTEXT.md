# CL2 — contexto para agente que construye la landing

**Para**: agente coding que va a hacer la landing pública (`agentescl2.com` o
similar). Leelo entero antes de mover una línea — no son nice-to-haves,
es el contrato.

---

## 1. Qué es CL2 (en una frase)

> Un equipo de tres asesores legislativos especializados que leen el SIL,
> el Reglamento y las plenarias en vivo, y aprenden cómo le gusta
> trabajar a tu despacho.

No "un chat con IA". No "un buscador inteligente". Un **equipo**. La
metáfora del equipo es la que la landing tiene que vender.

---

## 2. ICP — quién entra a la landing

Cuatro personas concretas. Si la landing no le habla a una de estas, está
mal apuntada.

1. **Jefa de despacho** de una fracción legislativa. Coordina 4-6 asesores.
   Su tiempo se va en briefings de 11pm para votación de mañana 9am.
2. **Asesora jurídica** de una diputada. Necesita precedentes y dictámenes
   con cita verificable, no resúmenes con "según se ha dicho".
3. **Diputada en el plenario**, durante una sesión activa. Quiere
   "qué dijo X en el minuto Y" en su iPad mientras el colega habla.
4. **Periodista político / consultor de comunicación**. Quiere patrones
   ("votación cruzada FA-PUSC", "quién ha apoyado reformas de salud") con
   trazabilidad obsesiva para no publicar fake news.

No es: el ciudadano común, el académico, el extranjero curioso. Esos no
pagan.

---

## 3. Problema que resuelven hoy a la mala

- **SIL es público pero ilegible**: 21,620 expedientes, búsqueda por
  número, sin texto completo, sin cruces, sin alertas. La pestaña de
  Chrome se queda abierta horas.
- **Las actas y videos están en YouTube** sin transcripción navegable. Si
  querés citar lo que dijo X, te tocaba ver el video entero.
- **Reglamento de 96 artículos** que nadie revisa porque está en PDF y
  hay que leerlo de seguido.
- **Equipos de fracción reinventan el mismo briefing cada semana** porque
  no hay memoria institucional fuera de Word docs sueltos.

CL2 colapsa los cuatro problemas en una conversación con citas inline.

---

## 4. El diferenciador real (no decir "AI", decir esto)

Tres capas que multiplicadas son difíciles de copiar:

### Capa 1 — Datos vivos
SIL conectado en tiempo real (21.6k expedientes, ~100k chunks indexados),
Reglamento (96 artículos), plenarias del periodo legislativo activo
(YouTube + Whisper). Cualquiera puede tener SIL en un mes; los otros tres
no.

### Capa 2 — Tres asesores especializados
Tres "almas" con personalidades distintas, no tres prompts idénticos:

- **⚖️ Lexa** — análisis plenario. Cita actas con timecode. Su regla
  rectora: "decir 'no encontré' es respuesta válida; nunca inferir
  desde otra sesión."
- **📑 Atlas** — comisiones y datos. Cruza dictámenes con votación
  nominal. Nunca habla de leyes que no estén en SIL aunque las sepa.
- **📡 Centinela** — alertas y deep insight. Bandera de confianza
  explícita. Penaliza fuentes de prensa, prefiere acta.

Cada uno tiene su propio modelo, temperatura, herramientas y umbrales.
Mismo dato, tres lecturas.

### Capa 3 — Memoria curada
El despacho **enseña** al equipo cómo le gusta responder. Cada chat se
destila a un lineamiento editorial; el operador publica los buenos; eso
queda inyectado al system prompt para siempre.

> Después de 6 meses de uso, la versión de CL2 del despacho A no es
> intercambiable con la del despacho B. **Eso** es el lock-in.

(NUNCA decir "extrae insights del usuario" o "aprende de tus
conversaciones". La narrativa pública es: el operador escribe lineamientos
editoriales. Punto.)

---

## 5. Casos concretos (los que vas a poner en la landing)

Elegí 3-4 de estos, no los seis. Cada uno con un *before* y un *after*:

| Caso | Before | Con CL2 |
|---|---|---|
| **Briefing nocturno antes de votar** | 3 horas leyendo dictámenes en PDF | "Atlas: dame minoría + mayoría del Exp. 24.018 con argumentos clave." 30 segundos. |
| **Pregunta procedimental** | "¿cuál es el plazo de dictamen?" → bajar Reglamento PDF, buscar | "Lexa: plazo dictamen comisión." Devuelve `[Art. 113]` con el texto. |
| **Citar plenario en vivo** | "creo que Calderón dijo algo del art 14" — abrir 4h de YouTube | "Lexa: qué dijo Calderón sobre el art 14." `[2] (1:57:26)` con link al segundo exacto. |
| **Cálculo estratégico** | reuniones de fracción para estimar votos a ojo | "Centinela: ¿cuánto apoyo tendría una moción de censura?" Rango cualitativo + bandera de confianza. |
| **Onboarding de diputado novato** | un mes leyendo Reglamento | "Lexa: cómo se presenta una moción de fondo." Artículo + plazo + ejemplo real del SIL. |

---

## 6. Brand y tokens (ya construidos, respetalos)

**Tipografía**:
- `Newsreader` (serif) — solo h1 y números grandes editoriales. No
  usarla en cuerpo.
- `Figtree` — todo lo demás.

**Colores brand** (definidos como tokens `cl2-*`):
- `cl2-accent` (`#F93549`) — coral, único color para CTAs primarios
- `cl2-accent-hover` (`#E11D48`) — pressed
- `cl2-accent-soft` (`#FF6877`) — gradiente
- `cl2-burgundy` (`#7A3B47`) — Lexa / institucional / display
- Ochre `#8B6E54` — Atlas
- Rose `#F43F5E` — Centinela

**Modos**: light + dark. Dark usa `bg-mesh` (`#231f1f` warm near-black).
**Fondo claro**: `bg-gray-50`. **Hairlines**: `border-[#0e1745]/[0.06]` /
`dark:border-white/[0.06]`. **Pixel-dot overlay**: `bg-pixel-dots opacity-60`.

**Estilo**: editorial, no corporate. Newsreader display + dot overlay
sobre warm-neutral. Inspiración: NYT product pages, no SaaS B2B típicos.

**Logo**: monograma CL2 en gradiente coral 135deg.

---

## 7. Tono de voz (esto es lo que te van a corregir)

- **Español de Costa Rica**, registro profesional pero cercano. "Vos" no
  "tú". "Acá" no "aquí". "Plenario" "fracción" "expediente" "comisión"
  "dictamen" — esos son los términos.
- **Sin AI hype**: nunca "powered by AI", "potenciado por inteligencia
  artificial", "el futuro del trabajo". Ya. Aburre.
- **Citas obsesivas**: cada claim numérico de la landing debe ser
  verificable. Si decís "21,620 expedientes", que sea cierto en este
  momento. No inventes. Si no sabés, no lo digas.
- **Anti-promesa**: "no inventamos respuestas." "Si no encontró, te dice
  que no encontró." Esa es la ventaja, no esconderla.

---

## 8. Qué NO decir (importante)

- ❌ "Aprende de tus conversaciones" / "se hace más inteligente con tu
  uso" / "extrae patrones de los usuarios"
- ❌ "Powered by GPT" / "Claude" / "Anthropic" — los modelos son interna,
  el producto no es uno de los modelos
- ❌ "RAG" / "embeddings" / "vector search" — jerga técnica
- ❌ "Reemplaza a tus asesores" — los aumenta, no los reemplaza
- ❌ "Tiempo real" excepto donde literalmente lo es (transcripción en
  vivo)
- ❌ Capturas de pantalla de la consola admin — eso es interno

---

## 9. Estructura sugerida de la landing

1. **Hero** — Newsreader display: *"Tu despacho ya pensó esto antes. CL2
   lo recuerda."* + 3 KPIs (1998 → / 21.6k expedientes / 100% con cita)
2. **Tres almas** — bloque editorial con foto/ícono de cada agente,
   color brand de cada uno, una frase de qué hace
3. **Antes / con CL2** — 3 casos lado a lado
4. **Citabilidad** — visual de un timeline de expediente real, hover
   muestra la cita inline. "Cada respuesta lleva el link al video, al
   artículo del Reglamento, al expediente del SIL. Si no se puede citar,
   el agente te dice que no se puede."
5. **Memoria del despacho** — la capa de curaduría, framing editorial:
   *"el agente aprende a hablar como tu despacho"*. NO decir cómo.
6. **Demo** — embed del chat funcional con ejemplos pre-cargados, o un
   video de 90 segundos navegando una pregunta real
7. **Quién está detrás** — Shift como holding (no decir Shift Lab Swarm
   ni los nombres internos), una línea sobre el equipo
8. **CTA** — "Agendá una demo de 30 minutos" — calendly link o un form
   simple. NO "regístrate gratis" — esto es B2B con sales gate.

---

## 10. Datos de scope que podés usar (todos verificables hoy)

- **3,493** expedientes 2022-2026 con texto base + dictámenes descargados
  vía SIL (en proceso, ~75% completo a 2026-04-26)
- **120** sesiones plenarias transcritas
- **96** artículos del Reglamento de la Asamblea indexados
- **3** agentes especializados (Lexa, Atlas, Centinela)
- **>1997** — fecha desde la que el SIL tiene texto digital recuperable
- **100%** de respuestas con cita verificable (es la regla guardrail, no
  un objetivo aspiracional)

Si necesitás un número que no esté acá, decimos "decenas de miles" o
"miles" — nunca inventes precisión.

---

## 11. Lo que pasa cuando alguien clickea "Demo"

El producto vivo está en `agentescl2.com`. Tres agentes funcionando, chat
con streaming, citas reales, transcripciones de sesiones reales.

La demo NO debería abrir el chat directo — primero un calendly de 30
minutos con Juanma o Oscar. Es B2B, hay que filtrar.

---

## 12. Inspiración visual (no copiar — capturar)

- **NYT** product pages — densidad editorial, Newsreader headlines
- **Linear** — micro-interacciones limpias, hairlines, dark mode bien
  hecho
- **Vercel** marketing — pero menos "tech-bro", más institucional
- **Stripe Atlas** — landing tono de seriedad financiera transmitido a
  legislativo

NO inspiración: Notion AI, Cursor, ChatGPT marketing — todo eso huele
a SaaS genérico.

---

## 13. Tech stack ya en repo

- React 19 + Vite 6 + TypeScript strict
- Tailwind v4 con tokens `@theme` (los `cl2-*` ya están)
- shadcn/ui primitives donde aplica
- motion/react para animaciones (entrance + scroll, no decorativas)
- lucide-react para íconos

Si la landing es página estática separada, mantené el stack.

---

## 14. Deadline

Demo a Oscar Solano el **2026-05-08**. La landing no necesita estar lista
para ese demo — ese es el demo del producto, la landing es para después.
Pero si está antes, mejor: Oscar la va a usar para vender a otros despachos.

---

**Listo. Buena suerte. Si hay duda, preguntá antes de inventar.**
