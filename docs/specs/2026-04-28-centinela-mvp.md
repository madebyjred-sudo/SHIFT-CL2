# Spec — Centinela MVP

**Fecha:** 2026-04-28
**Fases:** 1-5 (lanzable) + 6-7 (roadmap)
**Estado:** spec validado, implementación pendiente
**Owner:** Jred
**Depende de:** [Fase 0 — YouTube transcript pipeline](2026-04-28-youtube-transcript-pipeline.md)

> Implementación del agente Centinela (vigía proactivo) según lo definido en `docs/AGENTS.md`. Cuatro alertas factuales en MVP, digest semanal con Opus, página `/centinela` editorial, integraciones Telegram + Slack + email, banner en workspace, hero card en el chat principal.

---

## 1. Contexto + decisiones tomadas

Toda la justificación estratégica vive en `docs/AGENTS.md` §Centinela. Las decisiones técnicas tomadas en la conversación 28-abr-2026 están aquí:

1. **No hay API real-time con la Asamblea.** Polling vía SharePoint OData (con `modifiedSince`) cada 30-60 min.
2. **Page load NO consume IA.** El engine corre en background y popula `centinela_alerts`. La página solo lee la tabla.
3. **Plazos son shared, no per-user.** Una tabla `expediente_plazos` calculada UNA vez. Las preferencias personales son solo umbrales de alerta (`threshold_days = [1, 3, 7]`).
4. **4 alertas factuales en MVP** (estado, plazo, similar, agenda). Voto inusual y cambio de postura van al roadmap pero CON path técnico real (no fairy tale).
5. **Deep Insight de Centinela = digest semanal con Opus.** No es per-turn. Upsell natural a Pro tier.
6. **Schema entity-agnostic** para reusar en SENTINEL (Brand OS hermano).
7. **Página `/centinela` editorial** estilo `shifty-eco/WorkspaceDashboard` (KPI strip + trend + alerts list + charts premium).
8. **Auto-suscripción opt-out en workspace** (banner con micro-botón "¿Dejar de recibir auto-alertas?").

---

## 2. Schemas

### Genéricos (reusables para SENTINEL)

```sql
-- Watchlist genérica. entity_type es libre — para CL2 será expediente|diputado|tema,
-- para SENTINEL será media_outlet|topic|brand. NO acoplar a tablas específicas.
create table if not exists centinela_watchlist (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  entity_type     text not null,                       -- 'expediente' | 'diputado' | 'tema'
  entity_id       text not null,                       -- '24.429' | 'diputado_uuid' | 'fintech'
  source          text not null default 'manual',      -- 'manual' | 'auto_workspace:<wid>'
  metadata        jsonb default '{}'::jsonb,           -- contexto extra (display_name, etc)
  created_at      timestamptz not null default now(),
  unique (user_id, entity_type, entity_id, source)
);
create index centinela_watchlist_user_idx on centinela_watchlist (user_id);
create index centinela_watchlist_entity_idx on centinela_watchlist (entity_type, entity_id);

-- Alertas detectadas. Generadas por el engine, leídas por la página.
create table if not exists centinela_alerts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  entity_type     text not null,
  entity_id       text not null,
  alert_type      text not null,                        -- 'state_change' | 'deadline' | 'mention' | 'similar' | 'agenda'
  severity        text not null default 'info'         -- 'info' | 'warning' | 'critical'
                  check (severity in ('info', 'warning', 'critical')),
  payload         jsonb not null,                       -- ver §3 por tipo
  detected_at     timestamptz not null default now(),
  read_at         timestamptz,
  delivered_via   text[] default '{}'::text[],          -- ['in_app','telegram','slack','email']
  -- Deduplicación: misma watchlist + mismo alert_type + mismo payload digest
  -- evita disparar 5 alertas de "el 24.429 cambió a Hacienda" si el cron corre 5 veces
  dedup_key       text not null,
  created_at      timestamptz not null default now(),
  unique (user_id, dedup_key)
);
create index centinela_alerts_user_recent_idx on centinela_alerts (user_id, detected_at desc);
create index centinela_alerts_unread_idx on centinela_alerts (user_id, read_at) where read_at is null;

-- Preferencias de alertas por usuario.
create table if not exists centinela_alert_prefs (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  alert_types_on     text[] default array['state_change','deadline','mention','similar','agenda']::text[],
  deadline_thresholds int[] default array[1, 3, 7]::int[],     -- avisar con 7d/3d/1d
  channels           text[] default array['in_app']::text[],   -- 'in_app','email','telegram','slack'
  digest_enabled     bool default false,                       -- DI semanal (Pro tier)
  digest_cadence     text default 'weekly' check (digest_cadence in ('daily','weekly')),
  updated_at         timestamptz not null default now()
);
```

### Específicos del dominio CL2 (legislativo)

```sql
-- Plazos calculados a partir del Reglamento + estado del expediente. Shared.
create table if not exists expediente_plazos (
  expediente_id        int not null,                   -- FK lógica a sil_expedientes.id
  tipo_plazo           text not null,                  -- 'dictamen_comision' | 'discusion_plenario' | etc
  articulo_ref         text not null,                  -- 'Art. 81' del Reglamento
  fecha_inicio         date not null,                  -- desde sil_expedientes (último cambio relevante)
  fecha_vencimiento    date not null,
  dias_restantes       int generated always as (
    (fecha_vencimiento - current_date)::int
  ) stored,
  calculado_en         timestamptz not null default now(),
  primary key (expediente_id, tipo_plazo)
);
create index expediente_plazos_dias_idx on expediente_plazos (dias_restantes) where dias_restantes >= 0;

-- Reglas hardcodeadas del Reglamento de la Asamblea. MVP: 5-7 reglas más comunes.
-- Producción: reemplazable por parser automático del Reglamento (roadmap).
create table if not exists reglamento_plazos (
  id                  uuid primary key default gen_random_uuid(),
  tipo_plazo          text not null unique,            -- 'dictamen_comision', etc
  articulo_ref        text not null,                   -- 'Art. 81'
  estado_disparador   text not null,                   -- 'en_comision' (cuando se activa)
  dias_habiles        int not null,                    -- 22
  descripcion         text,
  activo              bool default true
);

-- Orden del día scrapeado (Fase 1 incluye scraper nuevo). Shared.
create table if not exists agenda_legislativa (
  id                  uuid primary key default gen_random_uuid(),
  fecha               date not null,
  comision            text,                            -- null si es plenario
  expediente_id       int,                             -- nullable, no todos los items son expedientes
  expediente_numero   text,                            -- snapshot human-readable
  titulo              text not null,
  hora_inicio         time,
  scraped_at          timestamptz not null default now(),
  unique (fecha, comision, titulo)
);
create index agenda_fecha_idx on agenda_legislativa (fecha desc);
```

### Migration plan

Agrupar todo en una sola migration:
- `0018_centinela.sql` — todas las tablas de arriba
- Migrar la `expedientes_watchlist` legacy (migración 0010) a la nueva `centinela_watchlist` con `entity_type='expediente'` y `source='migrated_from_legacy'`. Después dropear la vieja.

---

## 3. Tipos de alerta — payload específico

### `state_change`
```json
{
  "expediente_numero": "24.429",
  "expediente_titulo": "Marco Fintech",
  "from_estado": "comisión hacienda",
  "to_estado": "plenario",
  "detected_at_source": "2026-04-28T14:32:00-06:00",
  "url_detalle": "https://..."
}
```
**Severity:** `warning` por default. `critical` si pasa a estado terminal (archivado, aprobado).

### `deadline`
```json
{
  "expediente_numero": "23.583",
  "expediente_titulo": "...",
  "tipo_plazo": "dictamen_comision",
  "articulo_ref": "Art. 81",
  "fecha_vencimiento": "2026-05-01",
  "dias_restantes": 3,
  "threshold_crossed": 3
}
```
**Severity:** `info` (>7d), `warning` (3-7d), `critical` (≤3d).

### `mention`
```json
{
  "session_id": "uuid",
  "session_fecha": "2026-04-26",
  "session_tipo": "plenario",
  "matched_term": "24.429",
  "match_kind": "expediente",        // 'expediente' | 'diputado'
  "context_snippet": "...por lo tanto el expediente 24.429 que estamos discutiendo...",
  "timecode_start_s": 5025,
  "youtube_url_with_ts": "https://youtube.com/watch?v=...&t=5025s",
  "has_corrections": true              // si el segmento donde matcheó tenía correcciones del LLM
}
```
**Severity:** `info`.

### `similar`
```json
{
  "new_expediente_numero": "25.103",
  "new_expediente_titulo": "Reforma fintech sector cooperativo",
  "watched_expediente_numero": "24.429",
  "similarity_score": 0.82,
  "shared_themes": ["fintech", "regulación", "BCCR"]   // top 3 temas en común
}
```
**Severity:** `info` (0.7-0.85), `warning` (>0.85).

### `agenda`
```json
{
  "expediente_numero": "24.429",
  "fecha": "2026-04-29",
  "comision": "Hacienda",
  "hora_inicio": "09:00",
  "titulo": "Discusión y eventual dictamen del Marco Fintech"
}
```
**Severity:** `warning` (mañana), `info` (>1 día).

### Deduplicación

`dedup_key` se computa como hash determinístico:

```ts
// state_change
dedup_key = `state_change:${expediente_numero}:${from_estado}->${to_estado}`

// deadline (un alert por threshold cruzado, no por día)
dedup_key = `deadline:${expediente_numero}:${tipo_plazo}:${threshold_crossed}d`

// mention (un alert por sesión + término)
dedup_key = `mention:${session_id}:${matched_term}`

// similar
dedup_key = `similar:${watched}->${new_expediente}`

// agenda (un alert por fecha+expediente)
dedup_key = `agenda:${fecha}:${expediente_numero}`
```

Esto evita spam si el cron corre múltiples veces antes de que el user lea la alerta.

---

## 4. Engine — los crons

### Cron 1: `centinela-sil-sync` cada 30 min

```yaml
schedule: '*/30 * * * *'  # cada 30 min
```

1. Llama `silSharePointClient.crawlIncremental({modifiedSince: lastRun})`
2. Para cada expediente devuelto:
   - Comparar `estado` actual vs `sil_expedientes` row (que actualizamos)
   - Si difiere → para cada user con `centinela_watchlist` que matchea → INSERT en `centinela_alerts` con `alert_type='state_change'`
   - Si es expediente NUEVO (id no existía) → encolar embedding job (para alerta `similar`)
3. UPDATE `sil_expedientes` con datos nuevos
4. Recalcular `expediente_plazos` para los expedientes con cambio de `estado`
5. Para cada plazo recalculado, si cruzó un `threshold_days` de algún user → INSERT alert `deadline`

**Lag al user:** 30-60 min entre cambio en Asamblea y alerta.

### Cron 2: `centinela-deadline-sweep` daily a las 06:00 CR

Defensa en profundidad del cron 1 (por si perdió un cambio):
1. SELECT expedientes con `dias_restantes` ≤ max(threshold_days) de cualquier user
2. Para cada, chequear si ya hay alerta para ese threshold
3. Si no → INSERT alert `deadline`

### Cron 3: `centinela-similar-detect` cada 30 min (después del cron 1)

Para expedientes nuevos detectados:
1. Embeber título + texto base con Vertex
2. Para cada user con `centinela_watchlist` activo:
   - Cosine similarity vs embeddings de sus watchlist items
   - Si score >0.75 → INSERT alert `similar`

### Cron 4: `agenda-scrape` daily a las 22:00 CR

Scraper nuevo de `asamblea.go.cr/orden_dia/`:
1. Bajar HTML, parsear con cheerio
2. Extraer items por sesión + comisión
3. UPSERT en `agenda_legislativa`
4. Para cada item con `expediente_id` matcheando un watchlist → INSERT alert `agenda`

### Cron 5: `centinela-mentions` triggered (no scheduled)

NO cron — se ejecuta cuando el indexer del pipeline YouTube termina de procesar una sesión nueva.

1. Toma todos los chunks nuevos de la sesión
2. Para cada chunk, busca matches contra términos de watchlists activos:
   - Expedientes: regex `/\b\d{2}\.\d{3}\b/` cruzado con `entity_id`
   - Diputados: fuzzy match con `pg_trgm` (tolerancia a typos del transcript)
3. INSERT alerts `mention`

### Cron 6: `centinela-digest-weekly` semanal lunes 06:00 CR

Solo para users con `digest_enabled = true` (Pro tier).

1. Compone contexto: alertas de la semana + transcripciones de últimas 2 semanas + watchlist
2. Llama Opus 4.7 con el `deep_insight.prompt_addendum` de `centinela.yaml`
3. Genera digest estructurado (5 secciones: postura, coaliciones, momentum, proyección, oportunidades)
4. Guarda como alert tipo `digest_weekly` con payload markdown
5. Envía por canales configurados

---

## 5. Cloud infrastructure

```
Cloud Scheduler (6 jobs) ─→ Cloud Run jobs (sync workers)
                            ├─ centinela-sil-sync       (30 min)
                            ├─ centinela-deadline-sweep (daily)
                            ├─ centinela-similar-detect (30 min)
                            ├─ agenda-scrape           (daily)
                            └─ centinela-digest-weekly (weekly)

Pub/Sub trigger ─→ Cloud Run job
                   └─ centinela-mentions  (triggered post-indexer)

Postgres (Supabase) ─→ centinela_alerts table
                       (read by /centinela page, hero card, workspace banner)
```

Setup:
- Crear los 6 Cloud Scheduler jobs con `gcloud scheduler jobs create http`
- Cada uno apunta a un endpoint `/api/internal/centinela/<job-name>` autenticado con `--oidc-service-account-email=shift-cl2-vertex@...`
- El endpoint dispara la lógica del job (sync sharepoint, etc)
- Pub/Sub topic `transcripts.session.indexed` se publica desde el indexer del pipeline YouTube. Cloud Run subscriber para `centinela-mentions`.

---

## 6. Surfaces UI

### 6.1 Página `/centinela`

Layout editorial estilo `shifty-eco/WorkspaceDashboard`:

```
┌─ TopDock ──────────────────────────────────────────────────────────┐
└────────────────────────────────────────────────────────────────────┘
┌─ Hero (max-w-1480, font-display) ──────────────────────────────────┐
│ INTELIGENCIA LEGISLATIVA · TIER PRO · COSTA RICA                   │
│ "Buenos días, Juan."                                               │
│                                                                     │
│ [h1, 72px clamp]  3 cambios en tu radar esta semana                │
│                                                                     │
│ Tu watchlist sigue 12 expedientes. Hubo 1 plazo crítico,           │
│ 2 cambios de estado, y 1 mención en plenario.                      │
└────────────────────────────────────────────────────────────────────┘
┌─ KPI strip (4 tiles) ──────────────────────────────────────────────┐
│ Alertas semana    Expedientes     Plazos próximos    Sesiones      │
│ 12 ↑3            12               3 (1 crit)          4 con menc   │
└────────────────────────────────────────────────────────────────────┘
┌─ Charts row (2 charts side-by-side) ───────────────────────────────┐
│ Timeline alertas 30d         │  Distribución por tipo               │
│ (área stacked por tipo,      │  (donut con hover-detail)            │
│  hover muestra día + breakdown)                                     │
└────────────────────────────────────────────────────────────────────┘
┌─ Watchlist (sidebar izq) ──┬─ Feed alertas (col derecha) ──────────┐
│ Expedientes (12)           │ ⚠ El 24.429 pasó a Plenario · hace 2h│
│  + 24.429                  │ 📅 23.583 vence en 3 días    · hace 4h│
│  + 23.583                  │ 💬 Te mencionaron en sesión #94 · ayer│
│  ...                       │ 🔍 Nuevo similar al 24.429    · hace 1d│
│                            │ ...                                    │
│ Diputados (3)              │                                        │
│  + Vajardo                 │ Cada item:                             │
│  + Hernández               │   - Click → contexto                   │
│  + Solís                   │   - Hover → "Marcar leída"             │
│                            │   - Right-click → "Mandar a workspace" │
│ Temas (2)                  │                                        │
│  + fintech                 │                                        │
│  + agua                    │                                        │
│                            │                                        │
│ + Agregar entidad          │                                        │
└────────────────────────────┴────────────────────────────────────────┘
```

**Componentes nuevos:**
- `CentinelaHero` — título dinámico con cuenta de alertas (recientes 7d)
- `CentinelaKpiStrip` — 4 tiles con micro-trends
- `CentinelaTimelineChart` — área stacked, Recharts customizado
- `CentinelaTypeBreakdown` — donut con hover detail (estilo 21st-dev)
- `CentinelaWatchlist` — sidebar con autocomplete add
- `CentinelaFeed` — lista de alertas con acciones rápidas

**Charts:** Recharts como base + override de styles para tipo 21st-dev (transitions, hover detail, fonts editorial). Todos con datos reales — sin decoración inflada.

### 6.2 Hero card en `/`

Componente arriba del input de Lexa cuando llega al chat principal:

```
┌─ 🛰️ Centinela ────────────────────────── Ver todas (12) → ┐
│ ⚠️ El 24.429 pasó a Plenario           hace 2h              │
│ 📅 Plazo del 23.583 vence en 3 días    hace 4h              │
│ 💬 Te mencionaron en plenario         ayer                  │
└──────────────────────────────────────────────────────────────┘
```

3 alertas (las más recientes + más críticas). Click → contexto. CTA → `/centinela`. Empty state si watchlist vacío: CTA "Configurar watchlist".

Implementación: 1 endpoint `GET /api/centinela/recent?limit=3` + 1 componente. Cache server-side 60s para evitar hits repetidos.

### 6.3 Workspace banner

Cuando el user reabre `/hojas/:id` después de >12h:

```
┌─ 🔔 3 cambios desde tu última visita ──────────────────────┐
│ • el 24.429 pasó a Plenario                                 │
│ • plazo del 23.583 vence mañana                             │
│ • Diputada Vajardo mencionó tu proyecto                     │
│                       ¿Dejar de recibir auto-alertas? × ✕   │
└─────────────────────────────────────────────────────────────┘
```

**Auto-suscripción opt-out:**
- Cuando el user crea hojas referenciando un expediente, se INSERT en `centinela_watchlist` con `source='auto_workspace:<workspaceId>'`
- El banner se renderiza si hay alertas con esas suscripciones desde la última visita
- El × pequeño dispara DELETE de las suscripciones `auto_workspace:<wid>` (apaga el feature por workspace)

Implementación:
- Tracking de `last_visited_at` por workspace por user (tabla `workspace_visits` ya existe o se agrega)
- Endpoint `GET /api/workspace/:id/changes-since/:timestamp` que devuelve alertas desde ese timestamp
- Banner UI con micro-botón

---

## 7. Notificaciones — Telegram + Slack + email

### Telegram

**Setup del bot:**
1. Crear bot en `@BotFather` → `BOT_TOKEN`
2. `BOT_TOKEN` va a Cloud Run env var (NO al frontend bundle)

**Pairing flow:**
1. User va a `/centinela/settings` → click "Conectar Telegram"
2. Backend genera `pair_token` UUID + guarda en tabla `telegram_pairings(user_id, pair_token, expires_at, paired_chat_id)`
3. UI muestra link `t.me/cl2_centinela_bot?start=<pair_token>` + QR
4. User abre Telegram, hace `/start <pair_token>`
5. Telegram envía webhook a `POST /api/centinela/integrations/telegram/webhook`
6. Backend lee el `start_payload`, busca el `pair_token`, asocia `chat_id` ↔ `user_id`
7. Bot responde "✅ Conectado, recibirás alertas acá"

**Send flow:**
- Cuando se inserta una alert con `'telegram' in user.channels`, encolar mensaje
- Worker `notification-dispatcher` procesa el queue: `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
- Marca `delivered_via` con `'telegram'`

### Slack

**Setup:**
- Webhook URL configurada por user en `/centinela/settings` (forma simple)
- O: Slack app del marketplace con OAuth (forma B2B, post-MVP)

**Send flow:**
- Mismo `notification-dispatcher` worker
- POST con bloques formateados (header + section + buttons)

### Email digest

- Provider: **Resend** (más simple) o **Postmark** (más robusto B2B). Recomendación: Resend para empezar.
- Template: HTML simple con header burgundy + lista de alertas + footer con link a `/centinela`
- Por default: digest diario a las 7am. Toggle para `instant` (cada alerta crítica como email).

---

## 8. Deep Insight semanal — el upsell

### Trigger
Cron `centinela-digest-weekly` lunes 06:00 CR, solo users con `digest_enabled = true`.

### Composición del prompt
- Base: persona de Centinela (`centinela.yaml`)
- Append: `deep_insight.prompt_addendum` (5-section protocol)
- Contexto adjuntado:
  - Watchlist del user
  - Alertas de los últimos 7 días
  - Citas relevantes en transcripciones de las últimas 2 semanas (filtradas por watchlist)
  - Snapshot del estado de los expedientes monitoreados

### Output esperado
1500-2500 palabras estructuradas en 5-6 secciones:
1. Cambios de postura
2. Coaliciones emergentes
3. Spike de momentum
4. Proyección de votaciones próximas
5. Oportunidades accionables
6. Limitaciones del análisis

### Costo
- Sonnet base + Opus addendum: input ~30k tokens, output ~3k tokens
- Opus 4.7: ~$0.50-1.50 por digest por user
- A 100 users de Pro tier × 4 semanas = ~$200-600/mes. Coberable por el upcharge del tier.

### Entrega
- INSERT en `centinela_alerts` con `alert_type='digest_weekly'`, payload con markdown
- Email (Resend) con render del markdown
- Telegram/Slack si configurados (mensaje resumido + link al feed)

---

## 9. Settings UI (`/centinela/settings`)

```
┌─ Configuración de Centinela ───────────────────────────────────────┐
│                                                                     │
│ TIPOS DE ALERTAS                                                    │
│ ☑ Cambios de estado de expediente                                  │
│ ☑ Plazos legales por vencer                                        │
│ ☑ Menciones en plenario                                            │
│ ☑ Expedientes similares                                            │
│ ☑ Agenda legislativa                                               │
│                                                                     │
│ AVISOS DE PLAZOS                                                    │
│ Avisarme con: ☑ 7 días   ☑ 3 días   ☑ 1 día                       │
│                                                                     │
│ CANALES DE NOTIFICACIÓN                                             │
│ ☑ En la app                                                        │
│ ☐ Email                          [configurar]                       │
│ ☐ Telegram                       [conectar bot]                     │
│ ☐ Slack                          [agregar webhook]                  │
│                                                                     │
│ ANÁLISIS SEMANAL DE PATRONES (Pro)                                  │
│ ☐ Enviar digest semanal de Centinela                               │
│   Cada lunes 6am, Centinela analiza patrones de la semana          │
│   y te manda un reporte de inteligencia estratégica.               │
│                                                                     │
│ AUTOSUSCRIPCIÓN DE WORKSPACES                                       │
│ ☑ Cuando creo hojas referenciando expedientes, suscribirme         │
│   automáticamente. Puedo apagarlo por workspace en el banner.       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. Trabajo y orden de implementación

### Fase 0 — YouTube transcript pipeline
**Pre-requisito.** Ver spec separado. ~8 días.

### Fase 1 — Schema + engine factual (5 días)

| Task | Tiempo |
|---|---|
| Migration 0018: schemas centinela_*, expediente_plazos, agenda_legislativa, reglamento_plazos | 0.5d |
| Seed reglamento_plazos con 5-7 reglas hardcodeadas | 0.5d |
| Cloud Scheduler setup (6 jobs) + Cloud Run skeletons | 0.5d |
| `centinela-sil-sync` job (crawl incremental + diff + alerts) | 1d |
| `centinela-similar-detect` job (embedding + cosine) | 0.5d |
| `centinela-deadline-sweep` job + recalculo en sync | 0.5d |
| `agenda-scrape` job (scraper nuevo de orden del día) | 1d |
| `centinela-mentions` triggered job (post-YouTube indexer) | 0.5d |
| Smoke E2E con 1 user real | 0.5d |

### Fase 2 — Notificaciones (1.5 días)

| Task | Tiempo |
|---|---|
| Telegram bot creation + pairing flow + webhook handler | 0.75d |
| Slack webhook config + dispatcher | 0.25d |
| Resend integration + email digest template | 0.5d |

### Fase 3 — Surfaces UI (3 días)

| Task | Tiempo |
|---|---|
| Página `/centinela` (hero + KPI + charts + watchlist + feed) | 2d |
| Hero card en `/` (3 alertas + CTA) | 0.5d |
| Workspace banner (changes-since logic + UI + opt-out micro-button) | 0.5d |

### Fase 4 — Onboarding (3-5 días)

| Task | Tiempo |
|---|---|
| Diseño UX del flujo (welcome → setup Centinela → primer chat) | 1-2d |
| Implementación del wizard (multi-step modal) | 1.5d |
| Tour expandido de driver.js cubriendo Atlas + Centinela | 1d |

### Fase 5 — Deep Insight semanal (3 días)

| Task | Tiempo |
|---|---|
| `centinela-digest-weekly` job con Opus call | 1d |
| Schema + UI del digest (renderiza markdown en `/centinela/digest`) | 1d |
| Toggle en `/centinela/settings` + email template para digest | 1d |

**Total Fases 1-5:** ~16 días (~3.5 semanas)

### Roadmap (Fases 6-7) — paths técnicos

#### Fase 6 — Voto inusual (1 semana)

1. Verificar pobladez de `sil_votaciones.votos_jsonb` (query a Supabase)
2. Si SharePoint expone breakdown: implementar diferencial estadístico
3. Si no: parser de transcripts post-LLM review extrayendo conteos
4. Algoritmo "voto inusual" (vector de afinidad por diputado, detección de outliers)
5. Cron daily + alertas tipo `voto_inusual`

#### Fase 7 — Cambio de postura (1.5 semanas, depende de Fase 5)

1. Pipeline de extracción de citas atribuibles (segundo pass del LLM review con speaker attribution)
2. Embeddings de citas por diputado por tema
3. Comparación temporal (cita marzo vs cita mayo, mismo tema)
4. Va integrado en el digest semanal de Opus, NO como alerta en tiempo real

---

## 11. Pricing implications (decisión preliminar)

| Tier | Features Centinela |
|---|---|
| **Base** | 3 alertas factuales (estado, plazo, agenda). In-app + email. Watchlist hasta 5 expedientes. |
| **Pro** | Todas las alertas (estado, plazo, mención, similar, agenda). Telegram + Slack. Digest semanal Opus. Watchlist sin límite. |
| **Enterprise** | Pro + multi-user (equipo comparte watchlist). API access. Webhooks custom. |

Pricing exacto: post-demo a Oscar (cuando haya benchmarks de uso).

---

## 12. Decisiones que NO tomamos (siguen abiertas)

1. **Threshold del workspace re-entry** — default 12h. ¿Configurable per-user post-MVP?
2. **Granularidad de unsubscribe** — hoy es por workspace. ¿Por entidad? ¿Por tipo de alerta?
3. **Acción rápida "mandar alerta a workspace"** — conexión Centinela → Atlas (crear hoja con contexto de la alerta). MVP nice-to-have, post-MVP probablemente.
4. **Frecuencia de retención de alertas** — ¿cuánto tiempo guardamos `centinela_alerts` antes de archivar? Default 90 días.
5. **Histórico de votos pobladez** — verificar `sil_votaciones.votos_jsonb` antes de comprometerse con la Fase 6.

---

## 13. Criterio de éxito del MVP (Fases 1-3)

- [x] 4 alertas factuales generándose con datos reales para 1 user con watchlist
- [x] Página `/centinela` carga en <500ms con 50+ alertas
- [x] Hero card en `/` muestra 3 alertas reales sin cold start
- [x] Workspace banner aparece tras 12h de ausencia
- [x] Telegram bot funciona end-to-end (pairing → primera alerta)
- [x] Smoke E2E pasa: crear watchlist → simular cambio en SharePoint mock → alerta llega vía in-app + Telegram
- [x] Costo del engine: <$50/mes en producción para 100 users hipotéticos (excluyendo digest weekly)

Cuando se cumplen los 7, Centinela MVP es "demo-ready" y podemos pasar al onboarding (Fase 4).

---

## 14. Pathway hacia SENTINEL standalone

Recordatorio crítico: este Centinela es el blueprint técnico de SENTINEL standalone (PR + risk management Brand OS).

**Lo que reusará SENTINEL al 100%:**
- Schema `centinela_watchlist`, `centinela_alerts`, `centinela_alert_prefs` (entity-agnostic)
- Cloud Scheduler + Cloud Run jobs pattern
- Notification dispatcher (Telegram, Slack, email)
- Deep Insight digest pattern
- Página dashboard editorial
- Onboarding wizard pattern

**Lo que reescribirá:**
- Conector de datos (medios + redes en vez de SIL)
- Tipos de alerta específicos del dominio (`reputation_dip`, `viral_mention`, etc)
- Pattern engine (sentiment analysis vs voting analysis)

**Trabajo aprovechable:** 70-80% del Centinela CL2 es código directamente reusable en SENTINEL. Esa es la justificación de este investment.
