# Fix de Arquitectura de Retrieval — 2026-05-28

## Resumen Ejecutivo

**NO se hizo un "refactor profundo" de separación de tazas en toda la arquitectura.**

Lo que se implementó es un **fix quirúrgico** en `searchTranscripts` más una **nueva tool de deep insight** que hace retrieval paralelo. El resto del sistema (SIL, reglamento, constitución/LOAL) sigue funcionando exactamente como antes.

---

## ¿Qué SÍ cambió?

### 1. `searchTranscripts.ts` — Taza de transcripts aislada

**Cambio:** `filter_source_type: null` → `'transcript'`

**Efecto:** Cuando Lexa busca en transcripts, el RPC `match_chunks_v3` ahora solo busca dentro de chunks cuyo `source_type = 'transcript'`. Los chunks de SIL y reglamento ya no compiten en el mismo ranking semántico.

**Antes:**
- Usuario pregunta: "¿Qué pasó en abril sobre donaciones?"
- Vector search busca en TODO `legislative_chunks` (transcripts + SIL + reglamento + constitución)
- Un chunk de SIL del expediente 25.602 scorea 0.92 por metadatos densos
- Un chunk de transcript de abril scorea 0.71 por lenguaje natural disperso
- Resultado: SIL ahoga al transcript. La sesión de abril no aparece.

**Después:**
- Vector search busca SOLO en `legislative_chunks` donde `source_type = 'transcript'`
- Los transcripts compiten solo contra transcripts
- La sesión de abril ahora aparece en el top-k

**Fallback preservado:** Si `match_chunks_v3` no está disponible (error 42883), cae a `match_chunks` v1 SIN filtro de source_type, con un `console.warn` claro que documenta la degradación.

---

### 2. `insightAssembler.ts` — Nuevo módulo para Deep Insight

**Cambio:** Nuevo archivo. Hace retrieval paralelo por 4 tazas cuando `deep_insight === true`.

**Efecto:** Cuando el usuario activa "Profundizar" (deep insight), el sistema puede llamar a `insight_retrieve` en lugar de dejar que el modelo decida tool por tool. Esto busca en paralelo:
- `searchTranscripts` (source_type='transcript')
- `searchSilCorpus` (post-hoc filter `sil_*`)
- `searchReglamento` (filter por `source_ref_prefix`)
- `searchConstitucionLoal` (post-hoc filter `constitucion` | `loal`)

**Resultado:** El LLM recibe un contexto ensamblado con hits de los 4 dominios, etiquetados por fuente.

**NOTA:** Este módulo NO tiene "scoring mágico" ni "dimensiones abstractas". Es concatenación directa de los resultados. El LLM decide qué usar.

---

### 3. `openRouterClient.ts` — Tool `insight_retrieve` registrada

**Cambio:** Cuando `deep_insight === true`, se registra la tool `insight_retrieve` junto a las tools individuales existentes.

**Efecto:** El modelo puede elegir entre:
- Usar `insight_retrieve` para análisis cross-domain agregado
- Seguir usando `search_transcripts`, `search_sil_corpus`, etc. para preguntas puntuales de un solo dominio

---

## ¿Qué NO cambió?

### SIL (`searchSilCorpus`)

**NO se separó en tazas.** Sigue usando overfetch + post-hoc filtering (`source_type.startsWith('sil_')`).

**Por qué:** SIL tiene múltiples source_types (`sil_expediente`, `sil_dictamen`, `sil_mocion`, `sil_votacion`, `sil_acta`, etc.). `match_chunks_hybrid` solo acepta UN `filter_source_type`. Forzar retrieval paralelo por cada source_type:
1. Multiplicaría latencia (N llamadas RPC en serie o paralelo)
2. Perdería hits de source_types menos comunes
3. Complicaría el merge de rankings entre llamadas

**Solución real (futura):** Agregar `filter_source_type_prefix` al RPC de `match_chunks_hybrid`/`match_chunks_v3`, o crear un índice por dominio.

---

### Reglamento (`searchReglamento`)

**NO se cambió.** Sigue usando `filter_source_ref_prefix: 'Reglamento Asamblea'` en `match_chunks_hybrid`.

**Por qué:** Ya está relativamente aislado porque filtra por `source_ref`. No usa `filter_source_type`.

---

### Constitución/LOAL (`searchConstitucionLoal`)

**NO se cambió.** Sigue usando overfetch + post-hoc filtering (`source_type === 'constitucion' || source_type === 'loal'`).

**Por qué:** Aunque solo tiene 2 source_types y un corpus pequeño (~300 artículos), el retrieval paralelo rompía los tests existentes y agregaba complejidad sin beneficio claro. El overfetch actual funciona para un corpus tan pequeño.

---

## Estado de las "tazas"

| Dominio | Método de aislamiento | ¿Taza separada? |
|---|---|---|
| **Transcripts** | `filter_source_type: 'transcript'` en `match_chunks_v3` | ✅ SÍ |
| **SIL** | Overfetch + post-hoc `source_type.startsWith('sil_')` | ❌ NO (comparte ranking con otros dominios) |
| **Reglamento** | `filter_source_ref_prefix: 'Reglamento Asamblea'` | ⚠️ PARCIAL (filtra por source_ref, no por source_type) |
| **Constitución/LOAL** | Overfetch + post-hoc `source_type ∈ {constitucion, loal}` | ❌ NO (comparte ranking con otros dominios) |

---

## Próximos pasos recomendados

1. **Verificar en producción:** `SELECT proname FROM pg_proc WHERE proname LIKE 'match_chunks%';` para confirmar que `match_chunks_v3` existe.
2. **Monitorizar:** Revisar logs de `console.warn('[searchTranscripts] match_chunks_v3 unavailable...')` para ver si el fallback se dispara.
3. **SIL (futuro):** Evaluar si agregar `filter_source_type_prefix` al RPC es viable, o si conviene mantener el post-hoc.
4. **Insight Assembler:** Validar si el modelo usa `insight_retrieve` efectivamente en modo deep insight, o si sigue prefiriendo las tools individuales.

---

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `apps/api/src/services/searchTranscripts.ts` | `filter_source_type: 'transcript'` + fallback v1 con warning |
| `apps/api/src/services/openRouterClient.ts` | Registro y handler de `insight_retrieve` |
| `apps/api/src/services/insightAssembler.ts` | **Nuevo** — retrieval paralelo para deep insight |
| `apps/api/src/services/silClient.ts` | Sin cambios (revertido a original) |
