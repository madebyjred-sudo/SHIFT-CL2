# Spec — YouTube transcript pipeline + LLM review

**Fecha:** 2026-04-28
**Fase:** 0 (desbloqueante de Centinela)
**Estado:** spec validado, implementación pendiente
**Owner:** Jred

> Reemplaza el pipeline actual de transcripciones (ElevenLabs JSONs en GCS, indexación manual) por un pipeline automático basado en transcripciones nativas de YouTube + un agente LLM de review/correction.

---

## 1. Por qué hacer esto

### El pipeline actual (ElevenLabs) tiene tres problemas serios

1. **Costo:** ~$0.40/h × 4-5h por sesión × ~3 sesiones/semana ≈ **$25/sesión, ~$300-400/mes**. Era una fracción de los $700/mes de Oscar en CL2 legacy.
2. **Lag:** la transcripción se sube a GCS de forma asíncrona después de la sesión, después un humano corre el indexer. **Lag típico: 2-4 días.**
3. **Sin auto-detección de sesiones nuevas:** no hay cron que dispare "hay video nuevo en el canal, indexalo". Es 100% manual.

Para Centinela (alerta de mención en plenario), un lag de 2-4 días es inaceptable. Y el costo no escala si llegan más users.

### Lo que YouTube nos da gratis

La Asamblea sube cada sesión a [@AsambleaCRC](https://www.youtube.com/@AsambleaCRC). YouTube auto-transcribe los videos en ~1-4 horas después de subirlos. La transcripción tiene:
- Timecodes nativos (segmentos de ~3-8 segundos)
- Texto razonablemente preciso (típicamente 90%+ palabras correctas)
- API pública para extracción (`youtube-transcript-api` o similar)
- Costo: **$0**

### Lo que perdemos vs ganamos

| Aspecto | ElevenLabs | YouTube |
|---|---|---|
| Costo | ~$25/sesión | $0 |
| Lag | 2-4 días | 4-12 horas |
| Calidad | 95%+ | ~90% (auto-transcribe) |
| Speaker diarization | Sí (separa voces) | No (texto plano) |
| Timecodes | Sí | Sí (segmentos cortos) |
| API estable | Sí | Sí (con caveats — ver §6) |
| Auditabilidad legal | Una fuente | Una fuente + correcciones IA marcadas |

**El gap de calidad lo cerramos con un LLM review pass.** Ese es el corazón de este spec.

---

## 2. Arquitectura del pipeline

```
┌─ Cloud Scheduler ─────────────────────────────────────────┐
│ Cron: 0 6,18 * * *  (CR time = UTC-6, dispara 0h y 12h CR)│
│ Plus: endpoint manual /api/admin/transcripts/sync         │
└────────────────┬──────────────────────────────────────────┘
                 ▼
┌─ Cloud Run job: youtube-sync ─────────────────────────────┐
│ 1. Lista videos del canal @AsambleaCRC últimas 7 días     │
│ 2. Diff contra `sessions` (que ya tenemos)                │
│ 3. Para cada video nuevo:                                  │
│    a. Crea row en `sessions` con status='pending'          │
│    b. Inserta job en queue `transcript_jobs`              │
│ 4. Reporta count en logs                                  │
└────────────────┬──────────────────────────────────────────┘
                 ▼
┌─ Cloud Run job: transcript-process ───────────────────────┐
│ Para cada job pending:                                     │
│ 1. Descarga transcript de YouTube (lib + retry)           │
│ 2. Si falla (transcript no listo), reintenta en 1h        │
│ 3. Guarda raw en `transcript_segments` con timecodes      │
│ 4. Encola job de LLM review                               │
│ 5. Marca session.status='reviewing'                       │
└────────────────┬──────────────────────────────────────────┘
                 ▼
┌─ LLM Review (Sonnet 4.6) ─────────────────────────────────┐
│ Input: transcript_segments + contexto de sesión           │
│   (fecha, comisión, agenda si la tenemos)                 │
│ Process:                                                   │
│   1. Detección de typos en nombres                        │
│   2. Detección de typos en números de expediente          │
│   3. Detección de gaps audibles                           │
│   4. Detección de términos legislativos mal transcritos   │
│ Output: array de `transcript_corrections`                 │
│ NO modifica transcript_segments — solo agrega corrections │
└────────────────┬──────────────────────────────────────────┘
                 ▼
┌─ Indexer (chunking + embedding) ──────────────────────────┐
│ Chunking respetando timecodes (overlap de 1 segmento)     │
│ Aplica corrections inline al texto del chunk              │
│ Embeb con Vertex (gemini-embedding-001, 3072d)            │
│ Inserta en `legislative_chunks` con metadata enriquecida  │
│ Marca session.status='indexed'                            │
└────────────────┬──────────────────────────────────────────┘
                 ▼
┌─ Trigger downstream ──────────────────────────────────────┐
│ Notifica a Centinela engine: "hay sesión nueva indexada"  │
│ Centinela escanea menciones contra watchlists activos     │
└───────────────────────────────────────────────────────────┘
```

**Lag total:** 4-12h desde que YouTube termina de auto-transcribir hasta que el chunk está indexado y disponible para alerta de mención.

---

## 3. Schemas

### `sessions` (ya existe, agregar campos)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source text DEFAULT 'youtube';
-- 'youtube' | 'elevenlabs_legacy' (para distinguir histórico de marzo/abril)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS youtube_video_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS llm_reviewed_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS llm_review_model text;
```

### `transcript_segments` (nueva)

Almacena el transcript crudo tal como viene de YouTube. NO se modifica — es la fuente de verdad legal.

```sql
create table if not exists transcript_segments (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
  segment_idx     int not null,                    -- orden secuencial
  start_seconds   numeric(10,3) not null,
  end_seconds     numeric(10,3) not null,
  text            text not null,
  source          text not null default 'youtube_auto',
  created_at      timestamptz not null default now()
);
create index transcript_segments_session_idx on transcript_segments (session_id, segment_idx);
```

### `transcript_corrections` (nueva)

Almacena las sugerencias del LLM. **NUNCA reescribe `transcript_segments`** — son una capa de anotaciones aplicables al chunking downstream.

```sql
create table if not exists transcript_corrections (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
  segment_id      uuid not null references transcript_segments(id) on delete cascade,
  -- Tipo de corrección
  kind            text not null check (kind in (
    'typo_diputado',          -- "Bayardo" → "Vajardo"
    'typo_expediente',        -- "veinticuatro mil" → "24.429"
    'typo_legislativo',       -- "discamen" → "dictamen"
    'gap_filled',             -- "[...]" → contenido inferido
    'punctuation',            -- comas, períodos faltantes
    'speaker_attribution'     -- (futuro) atribuye un segmento a un diputado
  )),
  span_start      int not null,                  -- offset de char dentro del segment.text
  span_end        int not null,
  original_text   text not null,                 -- lo que YouTube transcribió
  suggested_text  text not null,                 -- lo que el LLM sugiere
  confidence      numeric(3,2) not null,         -- 0.00-1.00
  reasoning       text,                          -- por qué el LLM lo cambió
  -- Estado de revisión humana (default = aceptado por sistema, override manual)
  human_review    text not null default 'pending'
    check (human_review in ('pending', 'accepted', 'rejected')),
  reviewed_by     uuid references auth.users(id),
  reviewed_at     timestamptz,
  -- Modelo + cost
  model           text not null,                 -- 'anthropic/claude-sonnet-4.6'
  llm_run_id      uuid,                          -- agrupa correcciones del mismo run
  created_at      timestamptz not null default now()
);
create index transcript_corrections_session_idx on transcript_corrections (session_id);
create index transcript_corrections_run_idx on transcript_corrections (llm_run_id);
```

### `legislative_chunks` (ya existe, agregar metadata)

```sql
-- Aplicar correcciones al texto del chunk antes de embeber
-- (No tocamos schema — ya hay metadata jsonb suficiente)
-- Metadata enriquecida:
{
  "session_id": "...",
  "start": 1234.5,
  "end": 1240.0,
  "has_corrections": true,
  "correction_count": 3,
  "source": "youtube_corrected"
}
```

---

## 4. LLM Review — el agente

### Prompt system

```
Sos un agente de revisión de transcripciones legislativas. Recibís
transcripciones automáticas de sesiones de la Asamblea Legislativa
de Costa Rica generadas por YouTube. Tu trabajo es identificar errores
puntuales y proponer correcciones, SIN inventar contenido.

REGLAS DURAS:
1. NUNCA agregués palabras que no estén implícitas en el contexto.
   Si hay un gap audible "[...]" y no podés inferirlo con CERTEZA del
   contexto inmediato (oración antes/después), dejalo como está.
2. NUNCA cambies el sentido de una afirmación. Solo corregís typos
   ortográficos, números mal transcritos, o nombres mal escritos.
3. Para nombres de diputados, cruzá contra la lista oficial provista.
   Si no podés identificar al diputado con confianza ≥0.8, no corrijas.
4. Para números de expediente, formatá como "XX.XXX" (e.g. "24.429").
5. Si una corrección requeriría cambiar más de 5 palabras en una zona,
   NO corrijas — marca como "gap_unfillable" y seguí.

INPUTS QUE VAS A RECIBIR:
- Transcript completo en bloques numerados con timecodes
- Lista oficial de diputados activos (nombre + partido)
- Si está disponible: agenda de la sesión (orden del día)
- Si está disponible: número de sesión + fecha

OUTPUT (JSON estricto):
{
  "corrections": [
    {
      "segment_idx": 42,
      "span_start": 156,
      "span_end": 163,
      "kind": "typo_diputado",
      "original_text": "Bayardo",
      "suggested_text": "Vajardo",
      "confidence": 0.95,
      "reasoning": "Diputado Vajardo del partido X figura en lista oficial; pronunciación similar."
    },
    ...
  ],
  "summary": {
    "total_segments": 1820,
    "segments_modified": 47,
    "high_confidence_corrections": 38,
    "low_confidence_corrections": 9,
    "unfillable_gaps": 3
  }
}

Si NO encontrás errores corregibles, devolvé `corrections: []`.
```

### Modelo

**Empezamos con Sonnet 4.6.** Razón: la lógica de detección de typos legales es matizada y queremos calidad alta hasta estabilizar el prompt y crear evals.

**Iteración futura:** una vez tengamos un set de evals con sesiones reales reviewadas por humano, podemos comparar Sonnet vs Gemini Flash Lite vs Haiku 4.6. Si la calidad se mantiene >90% del Sonnet baseline con uno de los modelos baratos, hacemos el switch. Cost target: ~$0.10 por sesión (vs ~$1-2 con Sonnet).

### Costo estimado por sesión

- Sesión típica: ~3-4h, ~25k-40k palabras transcritas
- Input tokens al LLM: ~50k-80k (transcript + contexto)
- Output tokens: ~5k-15k (correcciones JSON)
- Sonnet 4.6: ~$3/M in, ~$15/M out
- Costo por sesión: **~$0.30-1.50**

A 12 sesiones/semana, ~$15-70/mes. Comparado con $300-400 de ElevenLabs, es 5-20x reducción.

---

## 5. Cron schedule + manual trigger

### Auto: Cloud Scheduler 2x/día

- **00:00 CR (06:00 UTC)** — pasada nocturna, captura sesiones del día anterior + reintentos pendientes
- **12:00 CR (18:00 UTC)** — pasada de mediodía, captura sesiones de la mañana

### Manual: endpoint admin

```
POST /api/admin/transcripts/sync
Body: { force?: boolean, video_ids?: string[] }
Auth: requireAdminUser (Jred)
```

Sin `video_ids`, equivale al cron. Con `video_ids`, solo procesa esos. `force=true` ignora cache y re-procesa aun si ya está indexado.

### UI admin (en `/admin/transcripts`)

- Tabla de sessions con `status, source, llm_reviewed_at, correction_count`
- Botón "Sync now" (dispara endpoint manual)
- Drill-down por sesión: comparativa segment-por-segment del raw vs corrected, con highlighting de correcciones (color por kind)
- Acceptar/rechazar correcciones individualmente (afecta `human_review` + opcional re-embed del chunk afectado)

---

## 6. Caveats técnicos honestos

### YouTube transcript API — no oficial

`youtube-transcript-api` (Node lib) es un scraper sobre los timed text tracks que YouTube expone. **No es API oficial.**

Riesgos:
- YouTube puede cambiar el formato sin aviso (raro, pero pasó en 2023)
- Rate limits no documentados
- Algunos videos no tienen captions (raro en livestreams oficiales como los de la Asamblea)

Mitigación:
- Implementar retry con backoff
- Loggear errores específicos para alertar si la lib se rompe
- Mantener ElevenLabs como fallback declarado para sesiones críticas (no automático, solo `force_provider=elevenlabs` en endpoint manual)

### Calidad variable

YouTube auto-transcribe varía con calidad de audio. Sesiones con gritos, eco, varios diputados hablando a la vez = peor calidad.

Mitigación:
- Si el LLM detecta >X% de gaps en un segmento, marcamos `quality_warning: true` y mostramos en UI admin
- Para sesiones críticas (cuando un user lo pida específicamente), permitir manual override a ElevenLabs

### Sin speaker diarization

YouTube no separa "quién habla". Esto limita la alerta de mención (podemos detectar "se mencionó a X" pero no "X dijo").

Mitigación de mediano plazo:
- En el LLM review podemos hacer un segundo pass con prompt: "intentá atribuir cada bloque a un diputado basado en contexto (quién dijo 'gracias presidente', quién fue invitado a hablar, etc.)"
- Es probabilístico — confianza baja, marcado como `speaker_attribution` con `confidence < 0.7`
- No bloquea el MVP

---

## 7. Migración desde ElevenLabs legacy

Tenemos transcripciones de marzo-abril en `gs://sesiones-transcripciones-uc1/transcripts/{youtubeId}.json`. Decisión:

- **No las reprocesamos.** Las dejamos como source='elevenlabs_legacy' en la tabla `sessions`.
- Las sesiones nuevas (mayo+) van por el pipeline YouTube.
- Si una sesión vieja necesita re-transcripción por un bug puntual, se hace manualmente vía endpoint admin con `force=true`.

Esto evita reprocesar 50+ sesiones (ahorro de tiempo + costo) y mantiene un audit trail histórico.

---

## 8. Reuse de CL2 legacy logic

Antes de implementar, hay que leer del CL2 legacy:

- Cómo lista los videos del canal (probablemente `googleapis` con `youtube.search.list`)
- Cómo extrae fecha + comisión del título del video (regex)
- Cómo identifica número de sesión

El path de extracción de metadata es el mismo. **Lo único que cambia es la fuente del transcript** (ElevenLabs JSON → YouTube transcript API) y el agregado del LLM review pass.

Estimación de reuse: ~60% del código del indexer actual (`scripts/index-gcs-transcripts.ts`) es reusable.

---

## 9. Trabajo y orden

| Task | Tiempo | Dependencia |
|---|---|---|
| Lib `youtube-transcript-api` integration + retry | 0.5d | (none) |
| Schema migrations (sessions cols, transcript_segments, transcript_corrections) | 0.5d | (none) |
| Cloud Run job `youtube-sync` (lista canal + diff sessions) | 1d | Lib |
| Cloud Run job `transcript-process` (download + LLM review) | 1.5d | Schema |
| LLM review prompt + tests con 2-3 sesiones reales | 1d | Process job |
| Cloud Scheduler triggers + endpoint manual | 0.5d | Process job |
| UI admin `/admin/transcripts` (lista + drill-down + aceptar/rechazar) | 1d | Schema |
| Smoke E2E con sesión completa real | 0.5d | Todo lo anterior |
| **Total** | **6.5d** | |

> Plus margin de 1d para imprevistos del scraping de YouTube → **8d total**

---

## 10. Criterio de éxito

Pipeline pasa a "production ready" cuando:

- [x] 3 sesiones procesadas end-to-end sin intervención manual
- [x] Correcciones del LLM revisadas por Jred — accuracy >85% (≤15% de correcciones erradas o innecesarias)
- [x] Lag promedio (subida YouTube → indexed): <12h en 3 ejecuciones consecutivas
- [x] Costo por sesión: <$2 (Sonnet); roadmap a <$0.20 con modelo barato post-mastery
- [x] Cero gaps no detectados en review humano (medido sobre 1 sesión completa con QA manual)

Una vez cumplidos los 5, este pipeline es la fuente única de transcripciones nuevas. ElevenLabs queda como fallback declarado, no default.

---

## 11. Lo que desbloquea cuando esté working

- **Centinela alertas de mención** con lag de 4-12h (vs 2-4 días)
- **Costo de transcripciones colapsa** ~80-90%
- **Cobertura completa automática** — toda sesión que la Asamblea suba se procesa
- **Speaker identification** (Fase 6+) basado sobre el LLM review
- **Voto inusual** (Fase 6) puede parsear conteos de votación de los transcripts corregidos
- **Cambio de postura** (Fase 7) puede comparar citas atribuibles a diputados a través del tiempo
