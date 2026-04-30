-- 0022_votos_extraidos.sql
--
-- Votos nominales extraídos de transcripts (post-LLM review).
--
-- Por qué esta tabla existe: el SIL del SharePoint NO expone el detalle de
-- votos por diputado. Lo único que tenemos son las plenarias en YouTube,
-- ya transcritas + corregidas por Sonnet (28k segments en transcript_segments).
-- En las plenarias, el secretario nombra cada voto: "diputado Pérez: a favor,
-- diputada Rodríguez: en contra…". Ese texto vive en transcript_segments
-- pero como prosa libre — sin estructura.
--
-- Pipeline (scripts/voto-inusual-backfill.ts):
--   1. Detector (Haiku 3.5, ~$0.001 cada 1k segments): clasifica cada segment
--      como "es-votación" / "no-es-votación" y agrupa los rangos contiguos.
--   2. Extractor (Sonnet 4.6, sólo sobre los rangos detectados): devuelve
--      JSON estructurado con la lista de diputados y sus votos.
--   3. INSERT en esta tabla.
--
-- Algoritmo "voto inusual" (apps/api/src/jobs/votoInusualDetect.ts, post-this):
--   Para cada diputado, computar vector de afinidad sobre todas sus votaciones
--   históricas. Agrupar por similitud coseno. Cuando un diputado vota CONTRA
--   su cluster habitual → alerta tipo `voto_inusual`.
--
-- Costo estimado:
--   - Backfill one-shot (28k segments): ~$5
--   - Incremental por sesión nueva: ~$0.20-0.30
--   - Lecturas / dashboard: $0 (SELECT a esta tabla)

create table if not exists votos_extraidos (
  id uuid primary key default gen_random_uuid(),

  -- Ancla en la sesión y rango de segments donde apareció el voto.
  -- Permite linkear "ver en transcript" desde el UI.
  session_id uuid not null references sessions(id) on delete cascade,
  segment_id_start uuid references transcript_segments(id),
  segment_id_end   uuid references transcript_segments(id),

  -- N-ésima votación dentro de la sesión (1, 2, 3…). Útil para reconstruir
  -- orden cronológico cuando hay múltiples votos en la misma plenaria.
  votacion_local_index int not null,

  -- Best-effort: el extractor intenta inferir el expediente que se votaba
  -- ("aprobar dictamen mayoría del expediente 24.429..."). Puede ser null
  -- si la votación es procedimental (mociones de orden, alteración de agenda).
  expediente_numero text,

  -- Texto literal de qué se votó: "aprobar el dictamen de mayoría",
  -- "moción de orden de la diputada X", "primer debate del proyecto Y".
  pregunta text not null,

  fecha date,

  -- Votos como jsonb: [{diputado: "PEREZ MARIN", voto: "a_favor"}, ...]
  -- voto ∈ {a_favor, en_contra, abstencion, ausente, no_consta}
  votes jsonb not null default '[]'::jsonb,

  -- Conteos pre-calculados para queries rápidas (ahorro vs jsonb_array_length).
  total_a_favor int default 0,
  total_en_contra int default 0,
  total_abstenidos int default 0,
  total_ausentes int default 0,

  -- Resultado: 'aprobada' | 'rechazada' | 'sin_quorum' | 'desconocido'
  resultado text,

  -- Confidence del extractor (0-1). <0.7 = revisar manualmente antes de
  -- usar para alertas. La UI puede ocultar bajos confidence.
  llm_confidence numeric default 0.0,
  extracted_by text default 'haiku-detector+sonnet-extractor',
  extracted_at timestamptz default now(),

  -- Idempotency: re-running the backfill on the same session+local_index
  -- replaces the row instead of duplicating.
  unique (session_id, votacion_local_index)
);

create index if not exists votos_extraidos_session_idx on votos_extraidos(session_id);
create index if not exists votos_extraidos_fecha_idx on votos_extraidos(fecha desc);
create index if not exists votos_extraidos_expediente_idx on votos_extraidos(expediente_numero);
-- GIN sobre votes para queries por diputado: select * where votes @> '[{"diputado":"PEREZ"}]'
create index if not exists votos_extraidos_votes_gin on votos_extraidos using gin (votes);

comment on table votos_extraidos is
  'Votos nominales extraídos de transcript_segments por LLM (Haiku detector + Sonnet extractor). Se popula con scripts/voto-inusual-backfill.ts y es la base del análisis "voto inusual".';

-- ── RLS: lectura pública (los votos legislativos son públicos) ──────────────
alter table votos_extraidos enable row level security;
drop policy if exists votos_extraidos_read on votos_extraidos;
create policy votos_extraidos_read on votos_extraidos
  for select using (true);

-- Escritura solo via service_role (el script + jobs futuros).
-- (Sin policy explícita de INSERT/UPDATE/DELETE → queda bloqueado para
-- usuarios anónimos/auth, pero abierto para service_role que bypasea RLS.)
