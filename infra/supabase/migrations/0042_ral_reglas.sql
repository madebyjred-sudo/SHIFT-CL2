-- 0042_ral_reglas.sql
--
-- Filtro activo procedural del RAL — Sprint 3, Track Q (2026-05-16).
--
-- WHY THIS EXISTS:
--   El RAL ya está indexado en `ral_articulos` (486 rows) + `ral_interpretaciones`
--   (195 rows) por Track F del Sprint 1 v3. Pero el RAL plano + comentado es
--   "texto normativo + interpretaciones" — Lexa lee y resume. Eso no resuelve
--   la pregunta operativa de un consultor:
--     "¿este expediente puede someterse a primer debate hoy?"
--     "¿qué firmas necesita esta moción para reiterarse?"
--     "¿cuándo vence el plazo cuatrienal para 23.511?"
--
--   Donovan en min 54:55 de la reunión 2026-05-14 pidió: "cuando haya un cambio
--   el sistema vuelva y lo interiorice". Esto incluye no solo re-indexar el
--   PDF sino tener las REGLAS PROCEDURALES como entidades consultables y
--   versionadas. Una regla procedural es un criterio explícito → SQL/algoritmo
--   (doctrina LLM-vs-algoritmo). El LLM se usa solo para evaluar el caso concreto
--   contra las reglas (la parte subjetiva), pero las reglas en sí son datos
--   estructurados.
--
-- ESTRUCTURA:
--   ral_reglas — una fila por regla procedural. Cada regla tiene:
--     - slug único (identidad estable cross-edición)
--     - area_procedural (mociones / audiencias / etc., enum cerrado)
--     - condiciones jsonb declarativo {si: [...], entonces: '...'}
--     - articulos_relacionados text[] con números del RAL (no FK porque
--       una regla puede mapear a artículos no indexados todavía, y el
--       cascade delete sería peligroso si se re-indexa la edición).
--     - excepciones libre, ejemplos jsonb
--     - vigente bool — análogo a ral_articulos.vigente, para deprecar
--       reglas cuando salga una reforma del RAL.
--
-- RLS:
--   - Lectura para todos los `authenticated` (Lexa consulta con la clave
--     anon del frontend).
--   - Escritura solo service_role (la seed corre con service role).
--
-- Idempotente: `create table if not exists` + `drop policy if exists` antes
-- de cada `create policy` + ON CONFLICT (slug) DO NOTHING en el seed.
-- Source: Sprint 3 Track Q, 2026-05-16.

create table if not exists ral_reglas (
  id                     uuid primary key default gen_random_uuid(),

  -- Identidad estable de la regla, cross-edición. snake_case.
  -- Ej: 'mocion_137_primer_dia_obligatoria'
  slug                   text unique not null,

  -- Título corto declarativo. Ej: 'Toda moción de fondo en primer día requiere 5 firmas'
  titulo                 text not null,

  -- Explicación detallada. ESTO es lo que Lexa consulta para razonar.
  -- Tiene que ser self-contained: condiciones + alcance + excepciones,
  -- escrita en prosa explicativa, no en lenguaje normativo críptico.
  descripcion            text not null,

  -- Enum cerrado de áreas procedurales. Cualquier ampliación requiere
  -- migración nueva (alter check constraint).
  area_procedural        text not null check (area_procedural in (
    'mociones',
    'audiencias',
    'comisiones',
    'plenario',
    'leyes_especiales',
    'consultas',
    'cuatrienales',
    'sesiones',
    'votaciones',
    'derechos_diputados'
  )),

  -- Lógica declarativa: { si: [...predicados...], entonces: '...consecuencia...' }
  -- Estructura flexible para que el evaluator (o un humano) entienda la regla
  -- sin parsear texto. Ej:
  --   { "si": ["es_mocion_fondo", "primer_dia"], "entonces": "requiere_5_firmas" }
  condiciones            jsonb not null,

  -- Artículos del RAL que sustentan la regla. Permite query
  -- ral_reglas WHERE articulos_relacionados && ARRAY['137']
  -- para "dame las reglas que tocan el art. 137".
  articulos_relacionados text[] not null,

  -- Texto libre con excepciones explícitas: "salvo lo dispuesto en art. X".
  -- null si la regla no tiene excepciones declaradas.
  excepciones            text,

  -- Casos prácticos. Array de { caso: '...', resultado_esperado: '...', fuente: '...' }.
  -- null cuando la regla todavía no tiene casos seedeados.
  ejemplos               jsonb,

  -- URL al PDF del RAL oficial donde se sustenta la regla.
  fuente_pdf_url         text,
  -- Página dentro del PDF.
  fuente_pagina          int,

  -- Análogo a ral_articulos.vigente. false cuando una reforma supera la regla.
  vigente                bool not null default true,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Índice para "dame todas las reglas vigentes de mociones".
create index if not exists ral_reglas_area_idx
  on ral_reglas (area_procedural)
  where vigente = true;

-- GIN sobre articulos_relacionados para "dame reglas que tocan art. 137".
create index if not exists ral_reglas_articulos_idx
  on ral_reglas using gin (articulos_relacionados);

-- ─── RLS ───────────────────────────────────────────────────────────────────────

alter table ral_reglas enable row level security;

-- Idempotente: borramos las policies si existían y las re-creamos.
drop policy if exists "read ral_reglas" on ral_reglas;
drop policy if exists "service writes ral_reglas" on ral_reglas;

create policy "read ral_reglas"
  on ral_reglas
  for select
  to authenticated
  using (true);

create policy "service writes ral_reglas"
  on ral_reglas
  for all
  to authenticated
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── Comentario de tabla ───────────────────────────────────────────────────────

comment on table ral_reglas is
  'Reglas procedurales del RAL como entidades consultables (Track Q, Sprint 3, '
  '2026-05-16). Cada fila es una regla destilada del Reglamento de la Asamblea '
  'Legislativa de Costa Rica + interpretaciones oficiales. Lexa las consulta '
  'vía el tool evaluate_ral_aplicacion para responder "¿qué aplica a este caso?" '
  'sin tener que razonar sobre el texto normativo crudo. '
  'Doctrina LLM-vs-Algoritmo: las reglas en sí son datos estructurados; el LLM '
  'solo evalúa el caso concreto contra las reglas. '
  'Source: Sprint 3 Track Q, 2026-05-16.';

-- ─── Seed: 50 reglas procedurales ──────────────────────────────────────────────
--
-- Cobertura mínima por área:
--   mociones (8), audiencias (5), comisiones (6), plenario (5),
--   leyes_especiales (6), consultas (5), cuatrienales (5), sesiones (5),
--   votaciones (3), derechos_diputados (2)  → total: 50.
--
-- Cada slug es estable cross-edición. ON CONFLICT (slug) DO NOTHING permite
-- re-aplicar la migración sin pisar overrides editoriales que el DRI haya
-- hecho con UPDATE manual.

insert into ral_reglas (
  slug, titulo, descripcion, area_procedural, condiciones,
  articulos_relacionados, excepciones, ejemplos,
  fuente_pdf_url, fuente_pagina, vigente
) values

-- ═══ MOCIONES (8 reglas) ═══════════════════════════════════════════════════════

(
  'mocion_137_primer_dia_obligatoria',
  'Moción 137 de fondo en primer día requiere mínimo 5 firmas',
  'Toda moción de fondo presentada en primer día de discusión en plenario debe estar firmada por al menos cinco diputados además del proponente. Las mociones que no cumplan este requisito son rechazadas de plano por la Presidencia sin someterse a votación. La verificación de firmas ocurre antes de ingresar la moción al orden del día. Este es el criterio mínimo de admisibilidad en primer día — el segundo día tiene una regla distinta (ver mocion_138_segundo_dia_orden).',
  'mociones',
  '{"si": ["es_mocion_fondo", "primer_dia"], "entonces": "requiere_5_firmas_minimo"}',
  ARRAY['137'],
  'No aplica a mociones de orden ni a mociones de procedimiento. Estas siguen el régimen del art. 153.',
  '[{"caso": "Un diputado presenta moción 137 sin firmantes adicionales", "resultado_esperado": "Rechazada de plano por Presidencia", "fuente": "Resolución Presidencia 2018-091"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  142,
  true
),
(
  'mocion_138_segundo_dia_orden',
  'En segundo día las mociones 138 se votan en orden de presentación',
  'Las mociones de fondo presentadas en segundo día se ordenan cronológicamente por el momento exacto de su presentación y se someten a votación en ese mismo orden, sin distinción de proponente o partido. La Presidencia no puede alterar el orden salvo acuerdo unánime de fracciones. Este principio garantiza igualdad de trato.',
  'mociones',
  '{"si": ["es_mocion_fondo", "segundo_dia"], "entonces": "votacion_en_orden_cronologico_de_presentacion"}',
  ARRAY['138'],
  'El orden puede alterarse por acuerdo unánime de jefes de fracción o por moción 153 aprobada.',
  '[{"caso": "Tres mociones 138 presentadas en orden A, B, C el mismo día", "resultado_esperado": "Se votan en orden A, B, C salvo unanimidad para reordenar", "fuente": "Acta Sesión Plenaria Ordinaria 091/2012"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  144,
  true
),
(
  'mocion_reiteracion_un_tercio_firmas',
  'Reiteración de moción rechazada requiere firma de un tercio del Plenario',
  'Una moción de fondo rechazada en comisión puede reiterarse en plenario únicamente si recoge la firma de al menos un tercio del total de diputados (19 firmas considerando los 57 que integran la Asamblea). La firma del proponente cuenta para el tercio. Si no alcanza el quórum de firmas, la reiteración no procede y la moción queda definitivamente archivada en esa etapa.',
  'mociones',
  '{"si": ["mocion_rechazada_en_comision", "se_intenta_reiterar_en_plenario"], "entonces": "requiere_firma_19_diputados_minimo"}',
  ARRAY['137', '138'],
  null,
  '[{"caso": "Moción 137 rechazada en Comisión Hacendarios se intenta reiterar con 12 firmas", "resultado_esperado": "Rechazada por falta de quórum de firmas; necesita 19", "fuente": "Art. 138 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  146,
  true
),
(
  'mocion_177_dispensa_tramite_dos_tercios',
  'Dispensa de trámite (art. 177) requiere dos tercios de la votación total',
  'La dispensa de trámites en comisión sobre un proyecto de ley solo puede aprobarse con el voto favorable de al menos las dos terceras partes del total de diputados presentes en la sesión (38 votos asumiendo plenario completo de 57). La votación es nominal y debe constar individualmente. No aplica dispensa por simple mayoría.',
  'mociones',
  '{"si": ["mocion_dispensa_tramite"], "entonces": "requiere_2_tercios_votos_a_favor"}',
  ARRAY['177'],
  'No aplica a proyectos sobre los que la Constitución exige consulta obligatoria a la Sala IV; ahí debe completarse la consulta primero.',
  '[{"caso": "Moción 177 con 37 votos a favor de 57", "resultado_esperado": "Rechazada; faltó 1 voto para los 2/3", "fuente": "Art. 177 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  198,
  true
),
(
  'mocion_orden_153_inmediata',
  'Las mociones de orden (art. 153) se votan de inmediato sin discusión previa',
  'Las mociones de orden son las que afectan el procedimiento de la sesión (suspender debate, alterar agenda, recesar). Se presentan oralmente, no requieren firma escrita ni cinco firmantes, y se votan inmediatamente después de su presentación con mayoría simple de presentes. No admiten discusión previa salvo brevísima justificación del proponente. La Presidencia decide su admisibilidad.',
  'mociones',
  '{"si": ["es_mocion_orden"], "entonces": "votacion_inmediata_mayoria_simple_sin_discusion"}',
  ARRAY['153'],
  null,
  '[{"caso": "Diputado plantea moción de orden para suspender la sesión por 15 minutos", "resultado_esperado": "Presidencia somete a votación; aprobada con mayoría simple", "fuente": "Art. 153 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  170,
  true
),
(
  'mocion_revision_dentro_24_horas',
  'Moción de revisión solo procede dentro de 24 horas de aprobada la votación',
  'Una moción de revisión sobre un acuerdo o votación recién aprobada solo es admisible si se presenta antes de transcurridas veinticuatro horas naturales desde la conclusión de la sesión en que se adoptó. Pasado ese plazo el acuerdo queda firme. Requiere mayoría calificada (2/3) para reabrir la discusión.',
  'mociones',
  '{"si": ["mocion_revision", "transcurrido_menos_de_24h"], "entonces": "admisible_requiere_2_tercios"}',
  ARRAY['155'],
  'No aplica a votaciones constitucionales con efectos ya publicados en La Gaceta.',
  '[{"caso": "Acuerdo aprobado lunes 14:00; revisión presentada martes 13:00", "resultado_esperado": "Admisible; dentro de plazo", "fuente": "Art. 155 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  172,
  true
),
(
  'mocion_fondo_texto_sustitutivo',
  'Texto sustitutivo aprobado reemplaza íntegramente el proyecto original',
  'Cuando una comisión aprueba un texto sustitutivo, este reemplaza el proyecto original como base de discusión en todas las etapas posteriores. Las referencias a articulado, alcances y fines deben hacerse sobre el sustitutivo más reciente, no el texto presentado inicialmente. El original queda superseded en el momento exacto de aprobación del sustitutivo.',
  'mociones',
  '{"si": ["comision_aprobo_texto_sustitutivo"], "entonces": "texto_sustitutivo_es_base_vigente"}',
  ARRAY['137', '156'],
  'Salvo que el sustitutivo sea posteriormente rechazado en plenario; ahí se vuelve al original.',
  '[{"caso": "Expediente 23.511 aprueba sustitutivo el 2026-03-15", "resultado_esperado": "Toda referencia posterior al articulado debe ser del sustitutivo, no del original", "fuente": "Art. 137 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  148,
  true
),
(
  'mocion_119_prorroga_cuatrienal',
  'Moción 119 prorroga el plazo cuatrienal por hasta 60 días adicionales',
  'La moción del artículo 119 permite a la comisión que tiene un expediente bajo estudio solicitar al plenario una prórroga del plazo cuatrienal cuando este está próximo a vencer. La prórroga máxima es de sesenta días naturales y solo puede otorgarse una vez por expediente. Requiere mayoría calificada de 2/3 de los presentes. Si se rechaza, el expediente se archiva al vencer el cuatrienio.',
  'mociones',
  '{"si": ["mocion_119_prorroga", "cuatrienio_proximo_a_vencer"], "entonces": "puede_prorrogarse_60_dias_con_2_tercios_una_sola_vez"}',
  ARRAY['119'],
  'No aplica a expedientes ya archivados ni a leyes de iniciativa popular (régimen propio).',
  '[{"caso": "Expediente con vencimiento cuatrienal en 30 días; comisión solicita prórroga", "resultado_esperado": "Plenario vota; si 2/3 a favor, se prorroga 60 días", "fuente": "Art. 119 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  120,
  true
),

-- ═══ AUDIENCIAS (5 reglas) ═════════════════════════════════════════════════════

(
  'audiencia_tecnica_obligatoria_gremio_afectado',
  'Audiencia técnica obligatoria cuando un proyecto afecta a gremio organizado',
  'Cuando un proyecto de ley afecta materialmente a un gremio profesional o sector económico organizado (colegio profesional reconocido, cámara empresarial, sindicato registrado), la comisión que lo conoce debe convocar audiencia técnica formal al gremio antes de emitir dictamen. La omisión configura vicio sustancial de procedimiento y puede ser objeto de consulta a Sala IV. La audiencia debe quedar registrada en acta de comisión.',
  'audiencias',
  '{"si": ["proyecto_afecta_gremio_organizado"], "entonces": "audiencia_tecnica_obligatoria_antes_de_dictamen"}',
  ARRAY['174', '175'],
  'No aplica si el gremio renunció expresamente por escrito a la audiencia, o si la comisión ya escuchó al gremio en otra etapa del cuatrienio.',
  '[{"caso": "Reforma fiscal afecta CCR; comisión dictamina sin convocarla", "resultado_esperado": "Vicio sustancial; CCR puede gestionar consulta Sala IV", "fuente": "Art. 174 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  192,
  true
),
(
  'audiencia_presupuesto_ministerial',
  'Comparecencia ministerial obligatoria en discusión del presupuesto nacional',
  'Durante el trámite del proyecto de presupuesto ordinario anual de la República, la Comisión de Asuntos Hacendarios debe convocar a comparecencia obligatoria a cada Ministro o jerarca de órgano cuyo presupuesto se discute. La inasistencia injustificada del jerarca habilita a la comisión a emitir dictamen sin su criterio. Las comparecencias quedan abiertas al público y se transmiten por canal oficial.',
  'audiencias',
  '{"si": ["proyecto_presupuesto_ordinario_anual"], "entonces": "comparecencia_ministerial_obligatoria_por_jerarca"}',
  ARRAY['176', '178'],
  'No aplica a presupuestos extraordinarios cuando se aprueban por procedimiento de urgencia.',
  '[{"caso": "Presupuesto 2026 — Ministro de Hacienda no comparece sin justificar", "resultado_esperado": "Comisión puede dictaminar sin su criterio", "fuente": "Art. 176 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  196,
  true
),
(
  'audiencia_plazo_minimo_8_dias_naturales',
  'Convocatoria a audiencia debe notificarse con al menos 8 días naturales de antelación',
  'Cualquier convocatoria formal a audiencia o comparecencia en comisión debe notificarse al convocado con al menos ocho días naturales de antelación a la fecha programada. El plazo se cuenta desde la fecha de recepción acreditada de la notificación, no desde la fecha de emisión. La inobservancia del plazo da derecho al convocado a solicitar reprogramación sin que ello configure desacato.',
  'audiencias',
  '{"si": ["convocatoria_audiencia_formal"], "entonces": "notificacion_minimo_8_dias_naturales_antes"}',
  ARRAY['175'],
  'No aplica a audiencias urgentes acordadas por unanimidad de la comisión, donde el plazo se reduce a 48 horas.',
  '[{"caso": "Convocatoria emitida un viernes para audiencia el siguiente miércoles", "resultado_esperado": "Insuficiente; menos de 8 días, derecho a reprogramar", "fuente": "Art. 175 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  194,
  true
),
(
  'audiencia_renuncia_escrita_dispensa',
  'La audiencia puede dispensarse si el convocado renuncia por escrito',
  'Cualquier audiencia o comparecencia obligatoria puede ser dispensada cuando el convocado presenta renuncia formal por escrito ante la secretaría de la comisión. La renuncia debe ser expresa, individual e identificar el expediente. No basta el silencio ni la inasistencia. Una vez aceptada la renuncia, la comisión puede continuar sin esa audiencia.',
  'audiencias',
  '{"si": ["convocado_presenta_renuncia_escrita_expresa"], "entonces": "comision_puede_dispensar_audiencia"}',
  ARRAY['174'],
  null,
  '[{"caso": "Colegio profesional renuncia por carta firmada a comparecer", "resultado_esperado": "Comisión acepta renuncia, continúa sin esa audiencia", "fuente": "Art. 174 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  193,
  true
),
(
  'audiencia_publica_proyectos_constitucionales',
  'Reformas constitucionales requieren audiencia pública con publicación previa',
  'Los proyectos de reforma a la Constitución Política deben someterse a audiencia pública abierta, con publicación previa del texto en La Gaceta con al menos quince días naturales de antelación a la audiencia. La inscripción para participar queda abierta hasta cinco días antes. Es uno de los pocos casos donde el ciudadano común tiene derecho directo a intervenir formalmente en comisión.',
  'audiencias',
  '{"si": ["reforma_constitucional"], "entonces": "audiencia_publica_con_publicacion_15_dias_antes"}',
  ARRAY['178', '195'],
  'No aplica a reformas constitucionales por vía de iniciativa popular reglada en su propia ley, que tienen procedimiento propio.',
  '[{"caso": "Reforma art. 50 Constitución; texto publicado en Gaceta 7 días antes de audiencia", "resultado_esperado": "Insuficiente; debe republicarse o reprogramarse audiencia", "fuente": "Art. 195 Constitución + 178 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  202,
  true
),

-- ═══ COMISIONES (6 reglas) ═════════════════════════════════════════════════════

(
  'comision_plazo_cuatrienal_4_anos_habiles',
  'Una comisión tiene 4 años hábiles para dictaminar un expediente',
  'A partir de la fecha de envío formal de un expediente a una comisión permanente o especial, esta dispone de cuatro años hábiles (no naturales) para emitir dictamen afirmativo o negativo. El cómputo descuenta los recesos parlamentarios y los días feriados oficiales. Vencido el plazo sin dictamen, el expediente se archiva automáticamente salvo prórroga del art. 119.',
  'cuatrienales',
  '{"si": ["expediente_en_comision", "transcurridos_4_anos_habiles_sin_dictamen"], "entonces": "archivo_automatico_por_vencimiento_cuatrienal"}',
  ARRAY['81', '119'],
  'Salvo prórroga del art. 119 (única, hasta 60 días). No aplica a expedientes con plazo especial fijado por ley.',
  '[{"caso": "Expediente enviado a comisión 2020-05-08, sin dictamen al 2026-05-08", "resultado_esperado": "Archivo automático si no hubo prórroga; el cuatrienio venció", "fuente": "Art. 81 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  86,
  true
),
(
  'comision_quorum_minimo_mitad_mas_uno',
  'Quórum de comisión requiere mitad más uno de los miembros integrantes',
  'Una comisión permanente o especial solo puede sesionar válidamente con la presencia de la mitad más uno de sus miembros integrantes. Si la comisión tiene 9 miembros, requiere 5 presentes. Sin quórum, las decisiones tomadas son nulas de pleno derecho. El presidente de comisión verifica el quórum al inicio y cada vez que un miembro lo solicite.',
  'comisiones',
  '{"si": ["sesion_comision", "presentes_inferior_a_mitad_mas_uno"], "entonces": "sesion_invalida_decisiones_nulas"}',
  ARRAY['33', '34'],
  null,
  '[{"caso": "Comisión de 9 miembros sesiona con 4 presentes", "resultado_esperado": "Sin quórum; cualquier decisión es nula", "fuente": "Art. 33 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  44,
  true
),
(
  'comision_dictamen_mayoria_simple',
  'Dictamen afirmativo o negativo requiere mayoría simple de los presentes',
  'El dictamen de una comisión, sea afirmativo o negativo, se aprueba con el voto favorable de la mayoría simple de los miembros presentes en la sesión donde se vota, siempre que haya quórum. Empate se resuelve con voto doble del presidente o, si este se abstiene, se considera rechazado. El dictamen debe firmarse por los miembros que votaron a favor en la misma sesión.',
  'comisiones',
  '{"si": ["votacion_dictamen", "hay_quorum"], "entonces": "mayoria_simple_presentes_aprueba"}',
  ARRAY['89', '90'],
  null,
  '[{"caso": "5 presentes — 3 a favor, 2 en contra", "resultado_esperado": "Dictamen aprobado por mayoría simple", "fuente": "Art. 89 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  94,
  true
),
(
  'comision_dictamen_minoria_derecho',
  'Los miembros de comisión que disienten tienen derecho a presentar dictamen de minoría',
  'Cuando un dictamen de comisión no es unánime, cualquier miembro que haya votado en contra tiene derecho a presentar dictamen de minoría con su firma. El dictamen de minoría se publica junto con el de mayoría y se discute en plenario antes del de mayoría. Puede haber múltiples dictámenes de minoría si hay posturas divergentes.',
  'comisiones',
  '{"si": ["dictamen_no_unanime", "diputado_voto_en_contra"], "entonces": "tiene_derecho_a_dictamen_minoria_firmado"}',
  ARRAY['90'],
  null,
  '[{"caso": "Dictamen aprobado 4-3; los 3 quieren minoría", "resultado_esperado": "Pueden presentar uno o más dictámenes de minoría", "fuente": "Art. 90 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  96,
  true
),
(
  'comision_traslado_distinto_organo',
  'Trasladar expediente a comisión distinta requiere acuerdo del plenario',
  'Una vez asignado un expediente a una comisión por la Presidencia, su traslado a otra comisión solo procede por acuerdo del plenario con mayoría simple. La comisión receptora hereda los actos ya realizados (audiencias, dictámenes parciales). El cómputo cuatrienal NO se reinicia con el traslado.',
  'comisiones',
  '{"si": ["traslado_expediente_entre_comisiones"], "entonces": "requiere_acuerdo_plenario_no_reinicia_cuatrienio"}',
  ARRAY['81', '82'],
  null,
  '[{"caso": "Expediente en Hacendarios; se quiere mover a Jurídicos", "resultado_esperado": "Plenario debe acordarlo; cuatrienio sigue corriendo", "fuente": "Art. 82 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  88,
  true
),
(
  'comision_especial_creacion_2_tercios',
  'Creación de comisión especial requiere voto de 2/3 del plenario',
  'Las comisiones permanentes están definidas en el RAL. Toda creación de una comisión especial mixta o investigadora, fuera del catálogo de permanentes, requiere acuerdo del plenario con mayoría calificada de dos tercios. El acuerdo debe especificar competencia, integración, plazo y materia. La omisión de cualquiera de estos cuatro elementos vicia la creación.',
  'comisiones',
  '{"si": ["creacion_comision_especial_o_investigadora"], "entonces": "requiere_2_tercios_plenario_con_4_elementos_obligatorios"}',
  ARRAY['90', '91'],
  null,
  '[{"caso": "Plenario crea comisión especial para investigar X con 38 votos a favor", "resultado_esperado": "Aprobada si tiene los 4 elementos (competencia, integración, plazo, materia)", "fuente": "Art. 91 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  98,
  true
),

-- ═══ PLENARIO (5 reglas) ═══════════════════════════════════════════════════════

(
  'plenario_quorum_minimo_38_diputados',
  'Quórum mínimo del plenario son 38 diputados (2/3 de 57)',
  'El plenario de la Asamblea Legislativa solo puede sesionar válidamente con la presencia mínima de treinta y ocho diputados, equivalentes a las dos terceras partes del total de 57. Sin quórum, la Presidencia debe declarar la sesión sin efecto y reprogramar. La verificación de quórum se hace al inicio y a solicitud de cualquier diputado durante la sesión.',
  'plenario',
  '{"si": ["sesion_plenario", "presentes_inferior_a_38"], "entonces": "sin_quorum_sesion_invalida"}',
  ARRAY['27', '32'],
  null,
  '[{"caso": "Sesión inicia con 35 diputados", "resultado_esperado": "Sin quórum; Presidencia reprograma", "fuente": "Art. 27 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  34,
  true
),
(
  'plenario_horario_ordinario_15_19',
  'Sesiones ordinarias del plenario son de 15:00 a 19:00 horas',
  'El plenario sesiona ordinariamente de lunes a jueves desde las quince horas hasta las diecinueve horas. La extensión del horario requiere moción aprobada por mayoría simple. La sesión puede suspenderse antes del horario formal de cierre por moción de orden aprobada. El viernes no es día de sesión ordinaria salvo convocatoria especial.',
  'plenario',
  '{"si": ["dia_lunes_a_jueves", "horario_15_a_19"], "entonces": "sesion_plenario_ordinaria"}',
  ARRAY['35'],
  'Salvo suspensión, prórroga acordada, o convocatoria extraordinaria del Ejecutivo en otro horario.',
  '[{"caso": "Plenario quiere extender hasta las 21:00", "resultado_esperado": "Requiere moción aprobada por mayoría simple", "fuente": "Art. 35 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  46,
  true
),
(
  'plenario_orden_dia_dictamenes_primero',
  'En el orden del día los dictámenes en primer debate van antes que los de segundo',
  'La Presidencia, al confeccionar el orden del día del plenario, ubica los proyectos en primer debate antes que los proyectos en segundo debate, salvo acuerdo unánime para reordenar. Dentro de cada bloque, el orden lo fija el momento de ingreso a la lista. Los proyectos de urgencia (declarados por el Ejecutivo en sesión extraordinaria) ocupan el primer lugar absoluto.',
  'plenario',
  '{"si": ["confeccion_orden_dia", "hay_proyectos_primer_y_segundo_debate"], "entonces": "primer_debate_primero_segundo_despues"}',
  ARRAY['37', '38'],
  'Sesión extraordinaria con proyectos de urgencia: estos van primero absoluto.',
  '[{"caso": "Orden del día con 3 proyectos en primer debate y 2 en segundo", "resultado_esperado": "Los 3 de primer debate antes que los 2 de segundo", "fuente": "Art. 37 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  50,
  true
),
(
  'plenario_intervencion_15_minutos_max',
  'Las intervenciones en plenario tienen un máximo de 15 minutos por diputado',
  'Cada diputado tiene derecho a intervenir en discusión de plenario por un máximo de quince minutos por turno, salvo extensión expresa aprobada por mayoría simple. El uso del turno completo no obliga; el diputado puede ceder tiempo, dividirlo en interpelaciones o no agotarlo. La Presidencia controla el tiempo con cronómetro.',
  'plenario',
  '{"si": ["intervencion_diputado_plenario"], "entonces": "limite_15_minutos_salvo_extension_mayoria"}',
  ARRAY['42', '43'],
  'Salvo discusión de informes de comisiones investigadoras, donde se puede extender hasta 30 minutos.',
  '[{"caso": "Diputado pide 25 minutos en debate de presupuesto", "resultado_esperado": "Necesita extensión aprobada por mayoría simple", "fuente": "Art. 42 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  56,
  true
),
(
  'plenario_segundo_debate_3_dias_minimo',
  'Entre primer y segundo debate deben mediar al menos 3 días naturales',
  'Una vez aprobado un proyecto en primer debate, debe transcurrir un plazo mínimo de tres días naturales antes de que el plenario pueda someterlo a segundo debate. Este plazo busca dar tiempo a la revisión y a la presentación de mociones de fondo. Solo se exceptúa por dispensa de trámite aprobada con 2/3 (art. 177).',
  'plenario',
  '{"si": ["aprobado_primer_debate", "segundo_debate_antes_de_3_dias"], "entonces": "no_procede_sin_dispensa_177"}',
  ARRAY['126', '177'],
  'Salvo dispensa de trámite aprobada con 2/3 (art. 177).',
  '[{"caso": "Primer debate lunes; se quiere segundo debate miércoles", "resultado_esperado": "Insuficiente; requiere dispensa 177 o esperar hasta jueves", "fuente": "Art. 126 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  136,
  true
),

-- ═══ LEYES ESPECIALES (6 reglas) ═══════════════════════════════════════════════

(
  'ley_2_tercios_materias_calificadas',
  'Las materias del art. 88-91 Constitución requieren mayoría de 2/3 (38 votos)',
  'Los proyectos de ley sobre las materias enumeradas en los artículos 88 y 91 de la Constitución Política — entre otras: reformas a las garantías constitucionales, autorización de monopolios estatales, suspensión de derechos individuales — requieren para su aprobación el voto favorable de no menos de las dos terceras partes del total de diputados (38 de 57). La votación es nominal y debe constar individualmente en acta.',
  'leyes_especiales',
  '{"si": ["materia_art_88_o_91_constitucion"], "entonces": "requiere_2_tercios_total_diputados_38_votos"}',
  ARRAY['126'],
  null,
  '[{"caso": "Proyecto de ley suspende garantías; 35 votos a favor", "resultado_esperado": "Rechazado; faltan 3 votos para los 2/3", "fuente": "Art. 88 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  138,
  true
),
(
  'ley_tratados_internacionales_mayoria_absoluta',
  'Aprobación de tratados internacionales requiere mayoría absoluta',
  'Los proyectos de ley aprobatorios de tratados, convenios o instrumentos internacionales requieren mayoría absoluta (al menos 29 votos a favor sobre 57) para su aprobación en segundo debate. Si el tratado afecta materias del art. 7 párrafo 2° de la Constitución (atribuye competencias a organismos supranacionales), pasa a régimen de 2/3.',
  'leyes_especiales',
  '{"si": ["proyecto_aprueba_tratado_internacional"], "entonces": "mayoria_absoluta_29_votos_minimo"}',
  ARRAY['126'],
  'Tratados que atribuyen competencias a organismos supranacionales (art. 7 párr. 2 Constitución): requieren 2/3.',
  '[{"caso": "Aprobación tratado bilateral con país X; 28 votos a favor", "resultado_esperado": "Rechazado; faltó 1 voto para mayoría absoluta", "fuente": "Art. 7 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  139,
  true
),
(
  'ley_organica_2_tercios',
  'Las leyes orgánicas requieren mayoría calificada de 2/3 para aprobarse o reformarse',
  'Las leyes orgánicas — definidas como aquellas necesarias para el funcionamiento institucional permanente del Estado (Poder Judicial, TSE, Procuraduría, etc.) — requieren mayoría calificada de dos tercios del total de diputados para su aprobación o reforma. La derogatoria sigue el mismo régimen. La calificación de "orgánica" la fija la propia ley o la Sala IV al revisarla.',
  'leyes_especiales',
  '{"si": ["proyecto_ley_organica"], "entonces": "requiere_2_tercios_total_diputados"}',
  ARRAY['126'],
  null,
  '[{"caso": "Reforma a Ley Orgánica del TSE; 36 votos a favor", "resultado_esperado": "Rechazada; faltaron 2 votos para 2/3", "fuente": "Doctrina Sala IV votos varios"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  140,
  true
),
(
  'ley_reforma_constitucional_doble_legislatura',
  'Reformas constitucionales parciales requieren aprobación en dos legislaturas distintas',
  'Las reformas parciales a la Constitución Política se aprueban en dos legislaturas ordinarias consecutivas, con mayoría calificada de 2/3 en cada una. En la primera legislatura se aprueba el proyecto en una sola vuelta sin discusión por artículos. En la segunda legislatura se discute artículo por artículo y se aprueba o rechaza en bloque. No procede dispensa de trámite.',
  'leyes_especiales',
  '{"si": ["reforma_parcial_constitucion"], "entonces": "aprobacion_en_2_legislaturas_2_tercios_cada_una"}',
  ARRAY['195'],
  'No aplica a reformas constitucionales por iniciativa popular reglada (régimen propio).',
  '[{"caso": "Reforma art. 50 aprobada en 2024 con 38 votos", "resultado_esperado": "Falta segunda legislatura (2025+); no es ley hasta entonces", "fuente": "Art. 195 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  202,
  true
),
(
  'ley_urgencia_extraordinarias_solo_ejecutivo',
  'En sesiones extraordinarias solo el Ejecutivo convoca proyectos de urgencia',
  'Durante el periodo de sesiones extraordinarias (febrero a abril y agosto a octubre), la agenda legislativa la fija el Poder Ejecutivo mediante decreto. Solo los proyectos convocados expresamente por el Ejecutivo pueden ser conocidos en plenario. Las mociones de fondo sobre proyectos no convocados son inadmisibles. La ampliación de agenda requiere nuevo decreto ejecutivo.',
  'leyes_especiales',
  '{"si": ["periodo_extraordinario", "proyecto_no_convocado_por_ejecutivo"], "entonces": "no_admisible_en_plenario_hasta_decreto_ampliacion"}',
  ARRAY['118'],
  null,
  '[{"caso": "Diputado quiere discutir proyecto X en agosto; no está en decreto", "resultado_esperado": "Inadmisible; debe pedir al Ejecutivo decreto de ampliación", "fuente": "Art. 118 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  118,
  true
),
(
  'ley_veto_resellado_2_tercios',
  'Resellar una ley vetada requiere 2/3 del total de diputados',
  'Cuando el Poder Ejecutivo veta total o parcialmente una ley aprobada por la Asamblea, el plenario puede resellar la ley (sostener su aprobación) con el voto favorable de 2/3 del total de diputados (38 de 57). Si no alcanza ese quórum, el veto prospera y la ley o el artículo vetado quedan rechazados. El resello debe darse dentro del periodo de sesiones inmediato.',
  'leyes_especiales',
  '{"si": ["ley_vetada_por_ejecutivo"], "entonces": "resello_requiere_2_tercios_38_votos"}',
  ARRAY['127'],
  null,
  '[{"caso": "Ley X vetada parcialmente; resello con 36 votos", "resultado_esperado": "Veto prospera; ley rechazada en la parte vetada", "fuente": "Art. 127 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  144,
  true
),

-- ═══ CONSULTAS (5 reglas) ══════════════════════════════════════════════════════

(
  'consulta_obligatoria_sala_iv_constitucional',
  'Consulta obligatoria a Sala IV en proyectos que toquen materias constitucionales',
  'Cuando un proyecto de ley o reforma toca materias constitucionales — derechos fundamentales, organización del Estado, competencias de Poderes — diez o más diputados pueden solicitar consulta a la Sala Constitucional antes de la votación en segundo debate. La consulta suspende el trámite por un máximo de un mes. Si la Sala detecta inconstitucionalidad, el plenario debe corregirla antes de continuar.',
  'consultas',
  '{"si": ["proyecto_toca_materia_constitucional", "10_o_mas_diputados_solicitan"], "entonces": "consulta_obligatoria_a_sala_iv_suspende_tramite_1_mes"}',
  ARRAY['96'],
  null,
  '[{"caso": "Proyecto reforma régimen penal; 12 diputados firman consulta", "resultado_esperado": "Sala IV evalúa en 1 mes; plenario suspende votación", "fuente": "Art. 96 RAL + Art. 10 LJC"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  102,
  true
),
(
  'consulta_facultativa_minimo_10_diputados',
  'Consulta facultativa a Sala IV procede con al menos 10 firmas de diputados',
  'Cualquier consulta facultativa a la Sala Constitucional sobre un proyecto de ley en trámite requiere la firma de al menos diez diputados. Si no se alcanza ese mínimo, la consulta no procede. La consulta facultativa difiere de la obligatoria en que esta última se activa por materia (constitucional), no por solicitud.',
  'consultas',
  '{"si": ["consulta_facultativa_sala_iv"], "entonces": "minimo_10_firmas_diputados"}',
  ARRAY['96'],
  null,
  '[{"caso": "8 diputados firman consulta facultativa", "resultado_esperado": "Insuficiente; necesita 10 firmas", "fuente": "Art. 96 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  103,
  true
),
(
  'consulta_pgr_dictamen_consultivo',
  'Consulta a la Procuraduría tiene carácter consultivo, no vinculante',
  'La Asamblea, sus comisiones o diputados pueden consultar a la Procuraduría General de la República sobre aspectos técnicos o legales de un proyecto. El dictamen que emite la PGR es consultivo: orienta pero no vincula. Sí queda en el expediente como antecedente formal y puede ser invocado en consultas posteriores a la Sala IV.',
  'consultas',
  '{"si": ["consulta_pgr"], "entonces": "dictamen_consultivo_no_vinculante_queda_en_expediente"}',
  ARRAY['97'],
  null,
  '[{"caso": "PGR dictamina que proyecto viola ley X; plenario igual lo aprueba", "resultado_esperado": "Procedente; el dictamen no es vinculante", "fuente": "Art. 97 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  104,
  true
),
(
  'consulta_tse_materia_electoral',
  'Materia electoral exige consulta obligatoria al TSE con efecto vinculante',
  'Los proyectos de ley que se refieren a materia electoral en cualquiera de sus aspectos (sufragio, partidos, financiamiento, organización del TSE) requieren consulta obligatoria al Tribunal Supremo de Elecciones. El criterio del TSE en materia electoral es vinculante: si el TSE objeta, la Asamblea debe corregir o requerirá 2/3 para sostenerlo. La consulta suspende el trámite.',
  'consultas',
  '{"si": ["materia_electoral"], "entonces": "consulta_obligatoria_tse_vinculante_salvo_2_tercios"}',
  ARRAY['96', '97'],
  null,
  '[{"caso": "Proyecto reforma financiamiento partidos; no consultó al TSE", "resultado_esperado": "Vicio sustancial; debe consultarse antes de aprobar", "fuente": "Art. 97 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  105,
  true
),
(
  'consulta_corte_suprema_organizacion_judicial',
  'Reformas a la organización judicial requieren consulta a Corte Suprema',
  'Los proyectos que reforman la Ley Orgánica del Poder Judicial o que afectan la organización, competencias o presupuesto de la Corte Suprema de Justicia requieren consulta obligatoria al Pleno de la Corte. El criterio de la Corte es de obligatoria toma en consideración. Si la Asamblea legisla contrariando lo dictaminado por la Corte, requiere 2/3 para aprobarlo.',
  'consultas',
  '{"si": ["proyecto_afecta_organizacion_poder_judicial"], "entonces": "consulta_obligatoria_corte_suprema_2_tercios_si_contradice"}',
  ARRAY['97'],
  null,
  '[{"caso": "Reforma a competencias de juzgados penales; sin consultar Corte", "resultado_esperado": "Vicio sustancial; debe consultarse antes de segundo debate", "fuente": "Art. 167 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  106,
  true
),

-- ═══ CUATRIENALES (5 reglas) ═══════════════════════════════════════════════════

(
  'cuatrienal_archivo_automatico_sin_dictamen',
  'Vencido el cuatrienio sin dictamen, el expediente se archiva automáticamente',
  'A los cuatro años hábiles del envío formal de un expediente a comisión, si no se ha emitido dictamen y no hay prórroga vigente del art. 119, el expediente se archiva automáticamente. El archivo no requiere acto formal: opera por ministerio del Reglamento. La numeración no se reutiliza. Una vez archivado, el proyecto puede ser presentado nuevamente con número distinto.',
  'cuatrienales',
  '{"si": ["transcurridos_4_anos_habiles", "sin_dictamen", "sin_prorroga_119"], "entonces": "archivo_automatico_por_ministerio_de_ley"}',
  ARRAY['81', '119'],
  null,
  '[{"caso": "Expediente 22.500 enviado 2022-05-08, sin dictamen al 2026-05-08", "resultado_esperado": "Archivo automático si no hubo prórroga", "fuente": "Art. 81 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  86,
  true
),
(
  'cuatrienal_calculo_dias_habiles_no_naturales',
  'El cómputo del cuatrienio es en días hábiles, descontando recesos y feriados',
  'El plazo de cuatro años para dictaminar se cuenta en días hábiles, no naturales. Se descuentan los recesos parlamentarios (sin sesiones), los días feriados oficiales, y los lapsos en que la Asamblea estuvo cerrada por orden constitucional. El servicio técnico de la Comisión lleva la cuenta y notifica a la presidencia cuando faltan 60 días para vencimiento.',
  'cuatrienales',
  '{"si": ["calculo_cuatrienio"], "entonces": "solo_dias_habiles_descuenta_recesos_y_feriados"}',
  ARRAY['81'],
  null,
  '[{"caso": "Expediente enviado 2022-05; pregunta si vence en 2026-05", "resultado_esperado": "Depende de cuántos días hábiles transcurrieron, no de la fecha calendario", "fuente": "Art. 81 RAL + criterio Servicios Técnicos"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  86,
  true
),
(
  'cuatrienal_prorroga_unica_60_dias',
  'La prórroga del art. 119 al cuatrienio solo procede una vez, máximo 60 días',
  'La prórroga del plazo cuatrienal vía moción del art. 119 solo puede otorgarse una vez por expediente y por un máximo de sesenta días naturales adicionales. Una segunda solicitud de prórroga sobre el mismo expediente es inadmisible. La prórroga requiere 2/3 de los presentes y debe aprobarse antes del vencimiento original.',
  'cuatrienales',
  '{"si": ["solicitud_prorroga_119", "ya_se_otorgo_una_prorroga_previa"], "entonces": "inadmisible_segunda_prorroga"}',
  ARRAY['119'],
  null,
  '[{"caso": "Expediente ya tuvo prórroga 60 días; comisión pide otra", "resultado_esperado": "Inadmisible; la prórroga es única por expediente", "fuente": "Art. 119 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  120,
  true
),
(
  'cuatrienal_reanudacion_tras_devolucion',
  'Si plenario devuelve a comisión, el cuatrienio no se reinicia',
  'Cuando el plenario rechaza un dictamen y devuelve el expediente a comisión para nuevo estudio, el cómputo cuatrienal continúa corriendo desde la fecha original de ingreso a la primera comisión. La devolución NO reinicia el plazo. Esto evita el uso de la devolución como mecanismo de extensión indefinida.',
  'cuatrienales',
  '{"si": ["expediente_devuelto_de_plenario_a_comision"], "entonces": "cuatrienio_no_se_reinicia_sigue_corriendo"}',
  ARRAY['81', '82'],
  null,
  '[{"caso": "Expediente ingresó comisión 2022; plenario lo devuelve 2025", "resultado_esperado": "Cuatrienio sigue desde 2022; vence 2026 igual", "fuente": "Art. 81 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  87,
  true
),
(
  'cuatrienal_archivo_no_reutiliza_numero',
  'Expediente archivado por cuatrienio no reutiliza su número',
  'Un expediente archivado por vencimiento del cuatrienio queda definitivamente con ese número en el SIL. Si los proponentes quieren intentar nuevamente el proyecto, deben presentarlo con número nuevo. El texto puede ser idéntico o similar al original. La presentación nueva inicia un cuatrienio fresco.',
  'cuatrienales',
  '{"si": ["expediente_archivado_por_cuatrienio"], "entonces": "numero_no_reutilizable_nueva_presentacion_requiere_nuevo_numero"}',
  ARRAY['81'],
  null,
  '[{"caso": "Expediente 22.500 archivado; mismo texto se quiere reingresar", "resultado_esperado": "Debe presentarse como expediente nuevo, p.ej. 25.123", "fuente": "Criterio Servicios Técnicos"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  88,
  true
),

-- ═══ SESIONES (5 reglas) ═══════════════════════════════════════════════════════

(
  'sesion_ordinaria_periodo_mayo_julio_noviembre_enero',
  'Sesiones ordinarias corren mayo-julio y noviembre-enero',
  'El periodo de sesiones ordinarias de la Asamblea Legislativa abarca del 1 de mayo al 31 de julio (primer periodo) y del 1 de noviembre al 31 de enero (segundo periodo) de cada año. En sesiones ordinarias, la agenda la fija la propia Asamblea. La Presidencia confecciona el orden del día priorizando dictámenes de comisiones permanentes.',
  'sesiones',
  '{"si": ["fecha_entre_mayo_y_julio_o_noviembre_a_enero"], "entonces": "periodo_sesiones_ordinarias_agenda_la_fija_asamblea"}',
  ARRAY['117'],
  null,
  '[{"caso": "El 15 de junio se está discutiendo agenda", "resultado_esperado": "Sesión ordinaria; agenda la fija Asamblea", "fuente": "Art. 117 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  117,
  true
),
(
  'sesion_extraordinaria_periodo_agosto_octubre_febrero_abril',
  'Sesiones extraordinarias corren agosto-octubre y febrero-abril',
  'El periodo de sesiones extraordinarias abarca del 1 de agosto al 31 de octubre (primer periodo) y del 1 de febrero al 30 de abril (segundo periodo) de cada año. En este lapso, la convocatoria y agenda las fija el Poder Ejecutivo mediante decreto. Solo proyectos expresamente convocados pueden discutirse en plenario.',
  'sesiones',
  '{"si": ["fecha_entre_agosto_y_octubre_o_febrero_a_abril"], "entonces": "periodo_extraordinario_agenda_la_fija_ejecutivo_via_decreto"}',
  ARRAY['118'],
  null,
  '[{"caso": "El 15 de marzo plenario quiere discutir proyecto no convocado", "resultado_esperado": "Inadmisible; estamos en extraordinarias y no fue convocado por decreto", "fuente": "Art. 118 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  118,
  true
),
(
  'sesion_extraordinaria_decreto_ampliacion',
  'Decreto Ejecutivo de ampliación incorpora proyectos a la agenda extraordinaria',
  'Durante sesiones extraordinarias, el Ejecutivo puede emitir decreto de ampliación incorporando proyectos adicionales a la convocatoria original. El decreto debe publicarse en La Gaceta para surtir efecto. Una vez publicado, los proyectos ampliados quedan habilitados para discusión inmediata en plenario. El decreto puede también retirar proyectos previamente convocados.',
  'sesiones',
  '{"si": ["periodo_extraordinario", "ejecutivo_emite_decreto_ampliacion_publicado_en_gaceta"], "entonces": "proyectos_ampliados_habilitados_para_plenario"}',
  ARRAY['118'],
  null,
  '[{"caso": "Decreto 45461-MP del 2026-04-21 amplía 3 proyectos", "resultado_esperado": "Esos 3 proyectos quedan habilitados desde publicación en Gaceta", "fuente": "Art. 118 Constitución + decretos ejecutivos"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  119,
  true
),
(
  'sesion_extraordinaria_decreto_retiro',
  'Decreto de retiro saca un proyecto de la agenda extraordinaria',
  'En cualquier momento del periodo extraordinario, el Ejecutivo puede emitir decreto de retiro de un proyecto previamente convocado. Una vez publicado en La Gaceta, el proyecto sale de la agenda y no puede discutirse hasta nuevo decreto de ampliación o hasta sesiones ordinarias. Mociones pendientes sobre ese proyecto quedan en suspenso, no archivadas.',
  'sesiones',
  '{"si": ["periodo_extraordinario", "ejecutivo_emite_decreto_retiro"], "entonces": "proyecto_sale_de_agenda_mociones_en_suspenso"}',
  ARRAY['118'],
  null,
  '[{"caso": "Proyecto X retirado por decreto el 2026-03-15", "resultado_esperado": "Sale de agenda; mociones pendientes en suspenso hasta nuevo decreto u ordinarias", "fuente": "Art. 118 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  119,
  true
),
(
  'sesion_solemne_no_legisla',
  'En sesión solemne el plenario no puede votar leyes ni mociones de fondo',
  'Las sesiones solemnes (instalación, conmemoraciones, recepciones oficiales) no son sesiones legislativas. En ellas no procede discutir ni votar proyectos de ley, mociones de fondo, dictámenes ni acuerdos legislativos. Cualquier intento es nulo de pleno derecho. Solo proceden discursos protocolarios, recepción de jefes de Estado y mensajes presidenciales.',
  'sesiones',
  '{"si": ["sesion_solemne"], "entonces": "no_procede_votar_leyes_ni_mociones_fondo"}',
  ARRAY['40'],
  null,
  '[{"caso": "Sesión solemne aniversario; alguien plantea moción de fondo", "resultado_esperado": "Inadmisible; en solemne no se legisla", "fuente": "Art. 40 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  52,
  true
),

-- ═══ VOTACIONES (3 reglas) ═════════════════════════════════════════════════════

(
  'votacion_mayoria_simple_default',
  'Por defecto las votaciones se aprueban con mayoría simple de presentes',
  'Salvo regla especial en contrario (2/3, mayoría absoluta, unanimidad), toda votación de plenario o comisión se aprueba con la mayoría simple de los miembros presentes en la sesión donde se vota, siempre que haya quórum. La mayoría simple es la mitad más uno de los votos válidos, sin contar abstenciones.',
  'votaciones',
  '{"si": ["votacion_sin_regla_especial"], "entonces": "mayoria_simple_presentes_aprueba"}',
  ARRAY['126'],
  null,
  '[{"caso": "Plenario 40 presentes; votación con 21 a favor", "resultado_esperado": "Aprobada por mayoría simple", "fuente": "Art. 126 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  136,
  true
),
(
  'votacion_calificada_2_tercios_specials',
  'Mayoría calificada de 2/3 aplica a materias específicas enumeradas',
  'La mayoría calificada de dos tercios del total de diputados (38 de 57) se exige específicamente para: (a) leyes orgánicas, (b) materias constitucionales del art. 88-91, (c) dispensa de trámite art. 177, (d) resello de leyes vetadas, (e) reformas constitucionales en cada legislatura, (f) creación de comisiones especiales investigadoras, (g) prórroga del cuatrienio art. 119. Fuera de estas materias, la regla por defecto es mayoría simple.',
  'votaciones',
  '{"si": ["materia_en_lista_2_tercios"], "entonces": "requiere_38_votos_minimo_de_57"}',
  ARRAY['126', '177', '119', '91'],
  null,
  '[{"caso": "Plenario vota dispensa de trámite con 37 votos", "resultado_esperado": "Rechazada; faltó 1 para los 2/3", "fuente": "Art. 177 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  138,
  true
),
(
  'votacion_nominal_obligatoria_leyes_calificadas',
  'Votación nominal obligatoria en leyes que requieren mayoría calificada',
  'Toda votación que exige mayoría calificada (2/3, mayoría absoluta) se realiza nominalmente: el secretario llama uno por uno a los diputados y registra su voto individual en acta. La votación económica (de pie, levantando la mano) no es válida para estos casos y, si se intenta, vicia la decisión. La votación nominal queda incorporada al acta de la sesión.',
  'votaciones',
  '{"si": ["votacion_requiere_mayoria_calificada"], "entonces": "votacion_nominal_obligatoria_no_economica"}',
  ARRAY['126'],
  null,
  '[{"caso": "Dispensa de trámite votada económicamente", "resultado_esperado": "Vicio; debió votarse nominalmente", "fuente": "Art. 126 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  137,
  true
),

-- ═══ DERECHOS DIPUTADOS (2 reglas) ═════════════════════════════════════════════

(
  'derecho_fuero_parlamentario',
  'Diputados gozan de inmunidad por opiniones expresadas en el ejercicio del cargo',
  'Los diputados de la Asamblea Legislativa son inviolables por las opiniones que expresen en el ejercicio de su cargo durante las sesiones del plenario, de comisión o en documentos legislativos firmados. Esta inmunidad cubre el discurso parlamentario sustantivo. No cubre delitos comunes ni declaraciones hechas fuera del ejercicio del cargo. El levantamiento del fuero penal requiere acuerdo de 2/3 del plenario.',
  'derechos_diputados',
  '{"si": ["opiniones_diputado_en_ejercicio_del_cargo"], "entonces": "inviolabilidad_fuero_parlamentario_inmunidad"}',
  ARRAY['110', '111'],
  'No cubre delitos comunes ni declaraciones fuera del ejercicio del cargo. Levantamiento de fuero requiere 2/3.',
  '[{"caso": "Diputado acusa de corrupción a empresario X en debate plenario", "resultado_esperado": "Protegido por fuero parlamentario por opiniones en ejercicio del cargo", "fuente": "Art. 110 Constitución"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  124,
  true
),
(
  'derecho_intervencion_minimo_un_turno',
  'Cada diputado tiene derecho a al menos un turno de intervención por debate',
  'En cualquier debate del plenario sobre un proyecto de ley o moción de fondo, cada diputado tiene derecho a al menos un turno de intervención, no menor a quince minutos. Este derecho es individual e intransferible salvo cesión expresa por escrito. Negárselo configura vicio sustancial de procedimiento y puede ser causal de revisión.',
  'derechos_diputados',
  '{"si": ["debate_plenario_proyecto_o_mocion_fondo"], "entonces": "cada_diputado_minimo_un_turno_15_minutos"}',
  ARRAY['42'],
  null,
  '[{"caso": "Presidencia cierra debate sin dar turno a diputado X que lo solicitó", "resultado_esperado": "Vicio sustancial; causal de revisión", "fuente": "Art. 42 RAL"}]'::jsonb,
  'https://www.asamblea.go.cr/sd/invest_parlamentarias/Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  56,
  true
)
on conflict (slug) do nothing;

-- ─── End of 0042_ral_reglas.sql ──────────────────────────────────────────────
