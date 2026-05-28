-- 0045_diputados.sql
--
-- Tabla de diputados activos de la Asamblea Legislativa de Costa Rica,
-- indexada por apellidos para cross-reference con `sil_expediente_proponentes`.
--
-- Por qué: el SIL serializa firmantes de proyectos de ley en formato
-- "Apellidos" (mayúsculas) sin nombre ni fracción. La columna `proponente`
-- de `sil_expedientes` y la tabla `sil_expediente_proponentes` quedaban
-- truncadas — el usuario veía "DELGADO RAMÍREZ" sin saber quién es ni
-- por qué partido firmó.
--
-- Esta tabla resuelve el cross-reference por (apellidos_canonical + periodo).
-- Cuando el enricher procesa un firmante, busca por apellidos + fecha del
-- expediente y rellena `nombre`, `fraccion`, `provincia` automáticamente.
--
-- Source 2026-05-19: Wikipedia + Tribunal Supremo de Elecciones (Anexo
-- Diputados del periodo legislativo 2026-2030 en Costa Rica). Periodo
-- 2022-2026 puede agregarse en seed posterior cuando se obtenga la lista.

create table if not exists diputados (
  id uuid primary key default gen_random_uuid(),

  -- Apellidos en MAYÚSCULAS sin tildes — match key contra SIL. Ej:
  -- "Acosta Jaén" en Wikipedia → "ACOSTA JAEN" acá.
  apellidos_canonical text not null,

  -- Apellidos con capitalización + tildes para displays. Ej: "Acosta Jaén".
  apellidos_display text not null,

  -- Nombre(s) de pila. Ej: "Nogui", "Kattia Alejandra", "Mayuli del Carmen".
  nombre text not null,

  -- Nombre + apellidos completo para mostrar en cards. Ej: "Nogui Acosta Jaén".
  nombre_completo text not null,

  -- Fracción / partido completo. Ej: "Partido Pueblo Soberano".
  fraccion text not null,

  -- Sigla corta para chips/badges. Ej: "PPS", "PLN", "FA", "AC", "PUSC".
  fraccion_corta text not null,

  -- Provincia de elección. Ej: "San José", "Alajuela", "Cartago", "Heredia",
  -- "Guanacaste", "Puntarenas", "Limón".
  provincia text not null,

  -- Curul (número de orden dentro de la provincia, 1-N). Ej: San José
  -- elige 18, Alajuela 12, Cartago 6, Heredia 5, Guanacaste 5, Puntarenas
  -- 6, Limón 5. Útil para mostrar "Diputado #3 por San José".
  curul int not null,

  -- Periodo constitucional del diputado. CR cambia cada 1 de mayo del año
  -- electoral. Ej: 2026-05-01 → 2030-04-30 para el cuatrienio actual.
  periodo_inicio date not null,
  periodo_fin date not null,

  -- Notas biográficas cortas (opcional, viene de Wikipedia).
  notas text,

  created_at timestamptz not null default now()
);

-- Índice por apellidos para los joins desde sil_expediente_proponentes
create index if not exists diputados_apellidos_idx
  on diputados (apellidos_canonical);

-- Índice por periodo para lookups date-bounded (un apellido puede repetirse
-- entre cuatrienios — Calderón, Arias, etc.)
create index if not exists diputados_periodo_idx
  on diputados (periodo_inicio, periodo_fin);

-- Constraint: un apellido_canonical puede aparecer varias veces (dos
-- diputados pueden compartir apellidos en cuatrienios distintos, o incluso
-- en el mismo periodo si son personas distintas con el mismo apellido —
-- raro pero posible). Sin UNIQUE; el matcher decide cuál usar.

-- RLS: lectura abierta para authenticated; writes solo service_role.
alter table diputados enable row level security;

create policy "service_role_write_diputados" on diputados
  for all to service_role using (true) with check (true);

create policy "authenticated_read_diputados" on diputados
  for select to authenticated using (true);

comment on table diputados is
  'Catálogo de diputados de la Asamblea Legislativa de Costa Rica por periodo. Usado por silEnrichExpediente para cross-reference apellidos → nombre + fracción + provincia. Source: Wikipedia + TSE.';
