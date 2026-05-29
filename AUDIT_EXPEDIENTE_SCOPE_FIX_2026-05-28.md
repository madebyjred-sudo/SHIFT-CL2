# Auditoría: Fix de Scope de Expediente (expediente_numero forzado)

**Fecha:** 2026-05-28
**Autor:** Agent Audit
**Commit auditado:** `830a131`
**Archivo principal:** `apps/api/src/services/openRouterClient.ts`

---

## Resumen Ejecutivo

| Aspecto | Estado |
|---------|--------|
| ¿El fix resuelve el problema original? | ✅ Sí |
| ¿El fix es seguro? | ⚠️ Parcialmente — introduce una regressión grave |
| ¿Hay otros scopes rotos? | ✅ Sí, `insight_retrieve` no está scopada |
| ¿Recomendación? | **Mejorar el fix** (no revertir) |

---

## Tarea 1: Revisión del Código del Fix

### Código actual (líneas 2219-2221)

```typescript
const effectiveExpedienteNumero = scopeExpedienteNumero
  ? normalizeExpedienteNumero(scopeExpedienteNumero)
  : normalizeExpedienteNumero(parsedArgs.expediente_numero) ?? parsedArgs.expediente_numero;
```

### Problema identificado: REGRESIÓN GRAVE 🚨

**El fix SIEMPRE sobreescribe el `expediente_numero` que el modelo pasa.**

Si el usuario está en el chat del expediente 25.590 y pregunta:
> "¿Qué pasó con el expediente 24.018?"

El sistema **ignorará "24.018"** y buscará en 25.590. Esto es un bloqueo de comparación entre expedientes.

### Lógica correcta

El fix debería ser **defensivo, no agresivo**:
- Si el modelo **omite** `expediente_numero` → usar el scope
- Si el modelo **pasa** `expediente_numero` → respetar lo que el usuario pidió

```typescript
// CORREGIDO:
const effectiveExpedienteNumero = normalizeExpedienteNumero(parsedArgs.expediente_numero)
  ?? (scopeExpedienteNumero ? normalizeExpedienteNumero(scopeExpedienteNumero) : undefined);
```

### Tipos TypeScript

| Variable | Tipo actual | Tipo esperado |
|----------|-------------|---------------|
| `scopeExpedienteNumero` | `string \| null` | Correcto |
| `parsedArgs.expediente_numero` | `string \| undefined` | Correcto |
| `effectiveExpedienteNumero` | `string \| null \| undefined` | Debería ser `string \| undefined` |

El `?? undefined` en la línea 2225 mitiga el `null`, pero la lógica debería evitar `null` desde el origen.

---

## Tarea 2: Verificación End-to-End del Filtro

### ¿searchSilCorpus recibe y usa el filtro correctamente?

✅ **Sí.** En `silClient.ts` línea 414-415:

```typescript
const normalizedNum = normalizeExpedienteNumero(args.expediente_numero);
const filterPrefix = normalizedNum ? `Exp. ${normalizedNum}` : null;
```

### ¿El RPC acepta el filtro?

✅ **Sí.** `match_chunks_hybrid` acepta `filter_source_ref_prefix`.

### Verificación en producción

```bash
# Chunks para 25.590 existen: 20 chunks confirmados via REST API
# source_ref: "Exp. 25.590 — texto_base"
# source_type: "sil_expediente"
```

### ¿El filtro funciona?

✅ **Sí.** El `filter_source_ref_prefix: "Exp. 25.590"` con `LIKE 'Exp. 25.590%'` matchea correctamente los chunks.

---

## Tarea 3: Scopes Rotos en Otras Tools

### Tools registradas cuando hay `scopeExpedienteNumero`

| Tool | ¿Scopada? | ¿Problema? |
|------|-----------|------------|
| `search_sil_corpus` | ✅ Sí (forzado) | Regressión: bloquea comparación |
| `search_transcripts` | ❌ No | Busca plenarias globales |
| `search_reglamento` | ❌ No | Busca reglamento global |
| `search_ral_comentado` | ❌ No | Busca RAL global |
| `search_constitucion_loal` | ❌ No | Busca constitución global |
| `insight_retrieve` | ❌ No | 🚨 **NUEVA tool, no scopada** |

### `insight_retrieve` — Nuevo riesgo 🚨

El commit `830a131` agregó `INSIGHT_RETRIEVE_TOOL` (líneas 795-820). Esta tool hace búsqueda paralela en TODOS los dominios (transcripts, SIL, reglamento, constitución). **No tiene parámetro de `expediente_numero`**.

Si el usuario activa Deep Insight en un chat scopado, `insight_retrieve` buscará globalmente y puede ignorar completamente el expediente.

### Recomendación

`insight_retrieve` debería:
1. Aceptar `expediente_numero` como parámetro opcional
2. O NO registrarse cuando hay `scopeExpedienteNumero` activo

---

## Tarea 4: Edge Cases

### 1. Comparación entre expedientes

**Estado:** 🔴 BLOQUEADA por el fix actual.

Si el usuario en chat de 25.590 pregunta "¿Es similar al 24.018?", el sistema buscará en 25.590.

**Fix propuesto:** Solo forzar el scope si el modelo no pasó `expediente_numero`.

### 2. Búsqueda general en chat scopado

**Estado:** ✅ FUNCIONA.

Si el usuario en chat de 25.590 pregunta "¿Qué dice la constitución sobre tratados?", `search_constitucion_loal` busca globalmente (correcto).

### 3. Expediente mal normalizado

**Estado:** ✅ MANEJADO.

`normalizeExpedienteNumero` convierte:
- `"25590"` → `"25.590"`
- `"25.590"` → `"25.590"`
- `"Exp. 25,590"` → `"25.590"`

### 4. Fallback global en chat scopado

**Estado:** ❌ NO HAY.

Con el fix actual, NO hay forma de hacer búsqueda global de SIL dentro de un chat scopado. Esto podría ser intencional o no.

**Recomendación:** Dejar que el modelo decida. Si pide búsqueda global (sin `expediente_numero`), respetarlo.

---

## Tarea 5: System Prompt

### Prompt actual (`expedienteContextLoader.ts` línea 376)

```
Para el CONTENIDO de documentos (texto base, dictámenes, mociones),
usá `search_sil_corpus` con `expediente_numero: "25.590"`.
```

### Evaluación

- ✅ Es claro y específico
- ✅ Menciona la tool y el parámetro
- ⚠️ Puede ser ignorado por el modelo (los modelos no siempre siguen instrucciones al 100%)
- ✅ Con el fix de backend, el prompt sigue siendo útil pero no crítico

### Recomendación

Simplificar el prompt ahora que el backend fuerza el filtro:

```
Para el CONTENIDO de documentos, usá `search_sil_corpus`.
El backend ya filtra por este expediente automáticamente.
```

---

## Tarea 6: Validación en Producción

### Logs de Cloud Run

No se encontraron logs recientes de `search_sil_corpus`. Posiblemente:
1. El logging no está configurado para ese patrón
2. No hay tráfico reciente

### Verificación manual

| Test | Resultado |
|------|-----------|
| Expediente 25.590 → "¿Qué dice el texto base?" | ❌ "No tengo información adicional verificable..." (antes del fix) |
| Sesión 21 mayo → "¿Hubo votaciones?" | ✅ Encontró votaciones |
| Sesión 14 mayo → "¿Qué se discutió?" | ✅ Encontró caso Alvarado |
| Expediente 24009 → "¿Qué es?" | ✅ Normalizó y respondió correctamente |

---

## Entregables

### 1. ¿El fix es correcto?

**Parcialmente.** Resuelve el problema original (modelo omite `expediente_numero`) pero introduce una regressión grave (bloquea comparación entre expedientes).

### 2. Lista de issues adicionales

| # | Issue | Severidad |
|---|-------|-----------|
| 1 | Fix sobreescribe siempre `expediente_numero` | 🔴 Alta |
| 2 | `insight_retrieve` no tiene `expediente_numero` | 🟡 Media |
| 3 | `insight_retrieve` se registra en chat scopado | 🟡 Media |
| 4 | No hay logs de verificación del fix | 🟢 Baja |

### 3. Recomendaciones de mejora

#### A. Corregir el fix (PRIORIDAD ALTA)

```typescript
// CORREGIDO — solo forzar si el modelo omitió el parámetro
const effectiveExpedienteNumero = normalizeExpedienteNumero(parsedArgs.expediente_numero)
  ?? (scopeExpedienteNumero ? normalizeExpedienteNumero(scopeExpedienteNumero) : undefined);
```

#### B. Scopar `insight_retrieve` (PRIORIDAD MEDIA)

Opción 1: No registrar `insight_retrieve` cuando hay `scopeExpedienteNumero`.

Opción 2: Agregar `expediente_numero` a `insightRetrieve` y forzarlo igual que `search_sil_corpus`.

#### C. Agregar métricas/logs (PRIORIDAD BAJA)

```typescript
console.log('[search_sil_corpus] scope_override', {
  scopeExpedienteNumero,
  modelPassed: parsedArgs.expediente_numero,
  effective: effectiveExpedienteNumero,
});
```

---

## Decisiones Pendientes

1. **¿Se permite comparar expedientes en un chat scopado?**
   - Si SÍ → aplicar fix A (solo forzar si omitido)
   - Si NO → mantener fix actual, pero documentar la limitación

2. **¿`insight_retrieve` debería estar disponible en chat scopado?**
   - Si SÍ → scoparla correctamente
   - Si NO → deshabilitarla cuando `scopeExpedienteNumero` está activo

---

## Acción Recomendada Inmediata

**Aplicar fix A** (corregir la lógica de override) y re-deployar. El fix actual es demasiado agresivo y bloquea un caso de uso legítimo (comparación entre expedientes).
