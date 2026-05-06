# Centinela — gaps detectados para llegar a demo-ready

**Status:** parked 2026-05-06 (mientras se resuelve issue de créditos OpenRouter).
**Cuándo retomarlo:** apenas haya créditos. Estimado: 1.5-2h para cerrar todo.

## Snapshot del estado real (verificado en prod 2026-05-06)

| Tabla / migración | Estado |
|---|---|
| Migration 0020 (workspaces.last_pptx) | ✅ aplicada |
| Migration 0021 (user_profile) | ✅ aplicada |
| Migration 0022 (votos_extraidos) | ❌ pendiente |
| reglamento_plazos | ✅ 7 reglas seedeadas |
| sessions indexed | 235 |
| transcript_segments | 28.632 |
| agenda_legislativa | 502 rows |
| centinela_watchlist | 4 entries (1 expediente legacy + 3 temas) |
| **centinela_alerts** | **0** ← bug |
| **expediente_plazos** | **0** ← bug del cron |

## Bug 1 — `expediente_plazos` está vacío

**Síntoma:** El cron `centinela-deadline-sweep` corre todos los días pero la vista `expediente_plazos_view` devuelve 0 rows.

**Hipótesis a investigar:**

1. **Mismatch entre `sil_expedientes.estado` y los `tipo_plazo` de `reglamento_plazos`.**  
   Las 7 reglas hablan de "asignación a comisión", "primer debate", etc. — pero la columna `sil_expedientes.estado` puede tener strings que no se mapean directo (ej: "EN COMISIÓN ASUNTOS HACENDARIOS" no es lo mismo que "EN COMISIÓN" genérico). Verificar con:
   ```sql
   select estado, count(*) from sil_expedientes group by estado order by count desc limit 30;
   ```

2. **`fecha_inicio` del plazo no se está calculando.** El cron debería mirar `sil_expedientes.fecha_presentacion` (o equivalente) + las reglas → pero quizás no detecta el evento de "asignación a comisión" porque no tenemos esa fecha de evento granular.

3. **El cron falla silencioso.** Mirar logs Cloud Run:
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="cl2-v2-api" AND jsonPayload.msg=~"deadline_sweep"' --project=sincere-burner-475520-g7 --freshness=2d --limit=10
   ```

**Fix probable:** ajustar el matching de estados en `centinelaSilSync.ts` o `deadline-sweep` para usar prefix-match (`estado LIKE 'EN COMISIÓN%'`) en lugar de equality.

## Bug 2 — Mentions no detecta `entity_type='tema'`

**Síntoma:** El user agrega un `tema` ("presupuesto_partidas") al watchlist pero el cron `centinela-mentions` solo busca `entity_type IN ('expediente','diputado')`.

**Fix:** extender `centinelaMentions.ts` para también scannear temas. Lógica:
- Para temas, hacer fuzzy/regex match sobre `transcript_segments.text` con el `entity_id` o `metadata.label`
- Usar `pg_trgm` (`text % 'presupuesto'`) o ILIKE

Approx 30 min de trabajo, sin LLM (puro Postgres).

## Bug 3 — La cuenta demo no tiene watchlist con expedientes activos

**Síntoma:** Las 4 entradas de watchlist son:
- `expediente :: 253` — LEY DE NATURALIZACIÓN DE COLONOS ITALIANOS (es del 1900s, sin actividad)
- 3 `tema` (presupuesto, dnu, salud)

Ningún expediente moderno con actividad real → ningún cron genera alertas → `/centinela` se ve vacío en el demo.

**Fix:** pre-seed la cuenta demo con 8-10 expedientes que YO sé que están activos. Query para encontrarlos:
```sql
select numero, titulo, estado, fecha_presentacion
from sil_expedientes
where fecha_presentacion > now() - interval '90 days'
  and estado not in ('ARCHIVADO', 'LEY')
order by fecha_presentacion desc
limit 30;
```

Después INSERT en `centinela_watchlist` para el user demo:
```sql
insert into centinela_watchlist (user_id, entity_type, entity_id, source, metadata)
values (
  '<demo-user-uuid>',
  'expediente',
  '24.987',
  'manual',
  '{"label": "Reforma fiscal 2026"}'::jsonb
);
-- repetir 8-10 veces con expedientes activos seleccionados
```

Approx 30 min, sin LLM.

## Bug 4 — Bugs ya arreglados, falta verificación

Pendientes de confirmar con user en prod (revision actual `d564ed5` API + `500504c` web):

- ✅ Lexa lee contenido de hojas (no solo títulos) — fix en `runArchitect` + `/turn` chat handler
- ✅ Watchlist add (escribir 24 → click sugerencia → se añade) — fix en backend (label/notes en `metadata jsonb`, source en onConflict)
- ✅ Hero strip aparece en `/` con sus 3 estados
- ✅ PPT options modal abre antes de generar

Si UNO de estos falla, frenar y diagnosticar antes de seguir.

## Plan ejecutivo cuando vuelvan créditos

**Orden sugerido (~1.5-2h total):**

1. (5 min) Aplicar migration 0022 en Supabase Studio
2. (20 min) Diagnosticar Bug 1 — query de estados en `sil_expedientes`, ajustar matching, re-disparar cron
3. (30 min) Bug 2 — extender `centinelaMentions.ts` para temas
4. (30 min) Bug 3 — query de expedientes activos + pre-seed watchlist demo
5. (10 min) User: smoke test de los 4 fixes
6. (15 min) Disparar manualmente los 4 crons una vez para forzar generación de alertas frescas
7. (5 min) Verificar `/centinela` muestra alertas reales

**Total que sube el porcentaje: 88% → 95-97%**

## Lo que NO necesita OpenRouter (se puede hacer mientras tanto)

- ✅ Bug 1 (deadline-sweep) — pura DB + lógica TypeScript, 0 LLM
- ✅ Bug 2 (mentions para temas) — Postgres `pg_trgm` o ILIKE, 0 LLM
- ✅ Bug 3 (pre-seed watchlist) — INSERT statements, 0 LLM
- ✅ Bug 4 (verificación de regresiones) — solo testing en UI, 0 LLM hasta que el user pregunte algo en chat

Lo único que CONSUME OpenRouter es:
- Backfill de voto inusual (script `voto-inusual-backfill.ts`) — opcional, no bloquea demo
- Probar Lexa/Atlas en chat — el user lo hace cuando quiera verificar, no es para mí
- Magic-help del onboarding — durante onboarding del user real

## Referencias cruzadas

- Spec original Centinela: `docs/specs/2026-04-28-centinela-mvp.md`
- Job `centinelaSilSync.ts` con la query del watchlist
- Job `agendaScrape.ts` con la query del watchlist
- Job `centinelaMentions.ts` ← este es el que necesita extensión para temas
- View `expediente_plazos_view` definida en migration 0019
- Lista de revisions en prod: `cl2-v2-api:d564ed5`, `cl2-v2-web:500504c`
