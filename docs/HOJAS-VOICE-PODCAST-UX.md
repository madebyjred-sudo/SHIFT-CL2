# Hojas + voz + podcast — design rationale

Status: design + A1 implementation.
Date: 2026-04-26.

## Por qué meter podcast + voz en Hojas (no como producto separado)

Cuatro JTBD concretos, sacados del ICP de LANDING-CONTEXT §2.

### JTBD-1 · "Necesito repasar mi investigación sin pantalla"
La asesora arma un board sobre reforma fiscal. Cierra el despacho 8 pm.
En el carro hay 30 min. **Quiere oír su propio trabajo**, no leerlo.

→ **Audio del board**. 3-5 min de la investigación condensada,
narrada en tono de briefing radial. Reproducción en celular. La
asesora llega al plenario con el contenido en la cabeza.

### JTBD-2 · "Capturar una idea sin escribirla"
Diputada en plenario. Colega menciona algo que la asesora ya
investigó. Saca el celular. *No puede escribir* — manos ocupadas
con papeles, ojos en el conferenciante. Habla 30 s en una nota.

→ **Voz → nueva hoja**. Push-to-record. Scribe transcribe. Aparece
una hoja nueva en el board, lista para ordenar después.

### JTBD-3 · "Memoria del despacho heredable"
Jefa de despacho rota equipo. Asesora nueva hereda 40 boards. Si
cada board trae su podcast asociado, la nueva persona no necesita
leer 200 hojas para ponerse al día — escucha mientras hace su café.

→ **Stale badge** + **regenerar**. Cuando el board cambia, el strip
de audio en el header marca "actualizado hace X — re-generá si
querés la nueva versión". Nunca auto-regenera (cuesta plata, no
queremos sorpresas).

### JTBD-4 · "Convertir investigación en pieza editable"
Periodista terminó research. Necesita un pre-script narrativo para
su nota. El podcast no es un dead-end — es un **borrador audible**.

→ **Script exportable**. JSON estructurado, segmentos numerados, se
puede copiar a markdown, editar el guion, regenerar el audio con el
texto editado. Out of scope para A1, pero el modelo ya lo soporta
(`podcasts.script` jsonb).

## Must-haves para A1 (esta sesión)

1. **Botón "Audio del board"** en el header del canvas → mismo
   `PodcastModal` con `source_type='hoja_workspace'`. Default style
   `conversacional` (entrevista host+guest), 3 min. Más engaging que
   monólogo si vas a escucharlo en el carro.

2. **Audio strip persistente** en el header cuando existe podcast
   `ready`. Player inline con play/pause, scrubber, velocidad
   (1x/1.5x/2x), botón "regenerar".

3. **Voz → nueva hoja**. Botón al lado de "+ Hoja". Push-to-record
   inline (no modal — fricción mínima). Termina recording → Scribe
   → markdown → `createNode({ content: { md } })` → aparece animada
   en el grid. Mismo `VoiceInput` que ya existe en chat, wrapper
   nuevo que llama `createNode` en el callback.

4. **Voz → append a hoja existente**. Mic icon en el header de
   cada `HojaNode`. Mismo flow, pero appendea al final del editor
   TipTap.

## Nice-to-haves diferidos a A2/A3

- **Mini-player flotante** bottom-right cuando arrancás playback —
  el usuario sigue trabajando en el board mientras escucha. (A3.)
- **Chapter markers** en el scrubber — cada `script.segments[]` =
  un capítulo, click salta. Necesita timestamps por segmento (ya
  los tenemos via duration estimation, pero v3 los daría exactos).
- **Sync texto ↔ audio**. Mientras suena, el segmento actual del
  guion se highlightea visualmente. Premium feature pesado de
  cablear — espera v3 con timestamps reales.
- **Per-node podcast** — cada hoja con su propio audio. Útil pero
  marginal frente al board-level. Implementar si el feedback lo
  pide.

## Decisión arquitectónica

**No tabla `hoja_podcasts`** todavía. Demasiado schema churn para
un beneficio marginal en A1. Filtramos `podcasts` por `source_type
in ('hoja_workspace','hoja_node') and source_id = workspace_id` y
ordenamos por `created_at desc` para mostrar el más reciente. Si
después hace falta multi-attach (varios podcasts colgados a un
mismo nodo), añadimos la tabla.

## Tono de voz para podcast de board

Override del prompt: "Estás resumiendo el TRABAJO DE INVESTIGACIÓN
de un despacho legislativo, no un expediente o sesión específica.
El usuario reúne notas para defender una posición. Tu trabajo es
ordenar lo que ya pensaron, no agregar nuevos datos. Habla EN
PRIMERA PERSONA PLURAL ('lo que encontramos', 'la línea que vimos')
porque sos parte del despacho."

Esto va dentro de `loadSource('hoja_workspace')` como prefijo del
`source_text`.

## AAA polish hooks

- Audio strip muestra **waveform real** durante playback (Canvas2D
  + AudioContext analyser). Diferenciador frente a controls
  nativos.
- Voice input usa **vibrate API** en mobile al start/stop (haptic).
- Recording state: waveform en vivo del input, no solo timer.
- Stale badge usa el patrón `mt-update-recently` con motion fade —
  aparece sin sustos, desaparece al regenerar.
- Microcopy:
  - Botón: "Audio del board" (no "Generar podcast" en este surface
    — ya estás en el board, sería redundante).
  - Empty state: "Convierte tu investigación en un briefing de
    audio. Tres minutos de lo que ya pensaste."
  - Stale: "El board cambió hace 2 horas. El audio actual quedó
    grabado antes."
