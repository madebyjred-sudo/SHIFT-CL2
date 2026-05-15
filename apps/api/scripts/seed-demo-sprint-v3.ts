// Seed datos demo COMPLETO para Sprint v3 visual sweep — 28 pedidos cliente.
// Pobla data demostrable para cada uno de los pedidos. Se corre con .env.local.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EXP = '23.511'; // Ley Marco Recurso Hídrico — el de la sesión cliente
const EXP_LEY = '23.234'; // Medicamentos — ya es ley (Carlos lo mencionó como "leyma")
const USER = 'b8a6cbeb-8b6c-463b-8a1a-a12a2e2e9fd4'; // madebyjred

const log = (m: string) => console.log(`  ${m}`);

(async () => {
  console.log('=== CLEANUP ===');
  // Limpiar data sucia previa
  await supabase.from('sil_expediente_tramite').delete().in('expediente_id', [EXP, EXP_LEY]);
  await supabase.from('sil_expediente_proponentes').delete().in('expediente_id', [EXP, EXP_LEY]);
  await supabase.from('sil_expediente_consultas').delete().in('expediente_id', [EXP, EXP_LEY]);
  await supabase.from('sil_expediente_documentos').delete().in('expediente_id', [EXP, EXP_LEY]);
  await supabase.from('sil_expediente_convocatoria').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('centinela_alerts_v2').delete().eq('user_id', USER);
  await supabase.from('centinela_eventos').delete().in('expediente_id', [EXP, EXP_LEY]);
  await supabase.from('sil_leyes_afectaciones').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('sil_leyes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  // Limpiar TODOS los decretos sucios del ingest crashed (mantiene solo los demo)
  await supabase.from('decretos_ejecutivos').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  log('Cleaned all demo tables');

  console.log('=== TRAMITACIÓN — pedido 1 ===');
  await supabase.from('sil_expediente_tramite').insert([
    { expediente_id: EXP, organo_legislativo: 'PLENARIO', descripcion: 'PRESENTACIÓN DEL PROYECTO DE LEY', fecha_inicio: '2022-12-19', fecha_termino: '2022-12-19', orden: 1 },
    { expediente_id: EXP, organo_legislativo: 'PLENARIO', descripcion: 'ENVÍO A IMPRENTA NACIONAL PARA SU PUBLICACIÓN', fecha_inicio: '2023-01-24', fecha_termino: '2023-01-24', orden: 2 },
    { expediente_id: EXP, organo_legislativo: 'AMBIENTE (ÁREA IV)', descripcion: 'RECEPCIÓN DEL PROYECTO (COMISIÓN)', fecha_inicio: '2023-02-14', fecha_termino: '2023-02-14', orden: 3 },
    { expediente_id: EXP, organo_legislativo: 'AMBIENTE (ÁREA IV)', descripcion: 'INGRESO EN EL ORDEN DEL DÍA Y DEBATE (COMISIÓN)', fecha_inicio: '2023-02-21', fecha_termino: '2023-10-10', orden: 4 },
    { expediente_id: EXP, organo_legislativo: 'AMBIENTE (ÁREA IV)', descripcion: 'VOTACIÓN (COMISIÓN)', fecha_inicio: '2023-10-10', fecha_termino: '2023-10-10', orden: 5 },
    { expediente_id: EXP, organo_legislativo: 'PLENARIO', descripcion: 'REMISIÓN A LA SECRETARÍA DEL DIRECTORIO (PLENARIO)', fecha_inicio: '2023-10-26', fecha_termino: '2023-10-26', orden: 6 },
    { expediente_id: EXP, organo_legislativo: 'PLENARIO', descripcion: 'INGRESO EN EL ORDEN DEL DÍA (PLENARIO)', fecha_inicio: '2024-02-05', fecha_termino: '2026-05-14', orden: 7 },
    { expediente_id: EXP, organo_legislativo: 'PLENARIO', descripcion: 'REMISIÓN DE MOCIONES 137 A COMISIÓN', fecha_inicio: '2026-04-15', fecha_termino: '2026-04-15', orden: 8 },
  ]);
  log('8 hitos de tramitación insertados');

  console.log('=== PROPONENTES — pedido 2 ===');
  await supabase.from('sil_expediente_proponentes').insert([
    { expediente_id: EXP, firma_orden: 1, diputado_nombre: 'IZQUIERDO SANDÍ OSCAR', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 2, diputado_nombre: 'NICOLÁS ALVARADO JOSE FRANCISCO', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 3, diputado_nombre: 'MOREIRA BROWN KATHERINE ANDREA', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 4, diputado_nombre: 'BARQUERO BARQUERO DINORAH CRISTINA', administracion: '2022-2026', fraccion: 'PLP' },
    { expediente_id: EXP, firma_orden: 5, diputado_nombre: 'RUÍZ GUEVARA MONSERRAT', administracion: '2022-2026', fraccion: 'PLP' },
  ]);
  log('5 firmantes con orden insertados');

  console.log('=== CONSULTAS A ENTIDADES — pedido 4 ===');
  await supabase.from('sil_expediente_consultas').insert([
    {
      expediente_id: EXP,
      entidad_consultada: 'Instituto Nacional de Seguros (INS)',
      fecha_consulta: '2023-03-15',
      fecha_respuesta: '2023-05-08',
      documento_url: 'https://www.asamblea.go.cr/proyectos/23-511-respuesta-ins.pdf',
      tipo_respuesta: 'condicional',
      resumen_por_tanto: 'A favor del proyecto, pero recomienda agregar artículo sobre cobertura técnica obligatoria para implementación profesional. Solicita revisión del Capítulo III, art. 12.',
    },
    {
      expediente_id: EXP,
      entidad_consultada: 'Procuraduría General de la República',
      fecha_consulta: '2023-04-02',
      fecha_respuesta: '2023-06-21',
      documento_url: 'https://www.asamblea.go.cr/proyectos/23-511-respuesta-pgr.pdf',
      tipo_respuesta: 'a_favor',
      resumen_por_tanto: 'Por tanto, esta Procuraduría considera que el proyecto es jurídicamente viable, sin roces de constitucionalidad detectables. Sugiere mejoras de redacción en arts. 7, 14 y 22.',
    },
    {
      expediente_id: EXP,
      entidad_consultada: 'Ministerio de Ambiente y Energía (MINAE)',
      fecha_consulta: '2023-04-02',
      fecha_respuesta: null,
      tipo_respuesta: null,
      resumen_por_tanto: null,
    },
  ]);
  log('3 consultas insertadas (2 respondidas + 1 sin respuesta)');

  console.log('=== DOCUMENTOS DESCARGABLES — pedidos 5, 16k ===');
  await supabase.from('sil_expediente_documentos').insert([
    { expediente_id: EXP, tipo: 'texto_sustitutivo', titulo: 'Texto Sustitutivo aprobado por subcomisión (octubre 2023)', fecha: '2023-09-15', url: 'https://www.asamblea.go.cr/proyectos/23-511-sustitutivo.pdf' },
    { expediente_id: EXP, tipo: 'dictamen_mayoria', titulo: 'Dictamen unánime afirmativo', fecha: '2023-10-10', url: 'https://www.asamblea.go.cr/proyectos/23-511-dictamen.pdf' },
    { expediente_id: EXP, tipo: 'informe_servicios_tecnicos', titulo: 'Informe del Departamento de Servicios Técnicos', fecha: '2023-08-12', url: 'https://www.asamblea.go.cr/proyectos/23-511-informe-st.pdf' },
    { expediente_id: EXP, tipo: 'mocion_137_primer_dia', titulo: 'Informe de mociones 137 - Primer Día', fecha: '2026-04-15', url: 'https://www.asamblea.go.cr/proyectos/23-511-137-primer-dia.pdf' },
  ]);
  log('4 documentos insertados (incluye texto sustitutivo)');

  console.log('=== EXPEDIENTE QUE ES LEY — pedido 5 ===');
  // Asegurar que existe el expediente 23.234 (Medicamentos) en sil_expedientes
  const { data: existsLey } = await supabase.from('sil_expedientes').select('id').eq('numero', EXP_LEY).maybeSingle();
  if (!existsLey) {
    await supabase.from('sil_expedientes').insert({
      id: 23234,
      numero: EXP_LEY,
      titulo: 'LEY GENERAL DE MEDICAMENTOS',
      proponente: 'CARRASQUILLA HERNÁNDEZ DAYANA',
      estado: 'Vigente',
      tipo: 'Proyecto de ley',
      legislatura: '2018-2022',
      url_detalle: 'https://www.asamblea.go.cr/proyecto?numero=23.234',
      fecha_presentacion: '2018-05-22',
    });
    log('expediente 23.234 (LEY MEDICAMENTOS) creado');
  }
  // Insertar tramitación + proponentes + documentos para 23.234 también
  await supabase.from('sil_expediente_tramite').insert([
    { expediente_id: EXP_LEY, organo_legislativo: 'PLENARIO', descripcion: 'PRESENTACIÓN DEL PROYECTO DE LEY', fecha_inicio: '2018-05-22', orden: 1 },
    { expediente_id: EXP_LEY, organo_legislativo: 'SALUD', descripcion: 'RECEPCIÓN COMISIÓN DE SALUD', fecha_inicio: '2018-06-10', orden: 2 },
    { expediente_id: EXP_LEY, organo_legislativo: 'PLENARIO', descripcion: 'APROBACIÓN PRIMER DEBATE', fecha_inicio: '2021-03-15', orden: 3 },
    { expediente_id: EXP_LEY, organo_legislativo: 'PLENARIO', descripcion: 'APROBACIÓN SEGUNDO DEBATE', fecha_inicio: '2021-04-22', orden: 4 },
    { expediente_id: EXP_LEY, organo_legislativo: 'PODER EJECUTIVO', descripcion: 'SANCIÓN PRESIDENCIAL', fecha_inicio: '2021-05-10', orden: 5 },
    { expediente_id: EXP_LEY, organo_legislativo: 'IMPRENTA NACIONAL', descripcion: 'PUBLICACIÓN EN LA GACETA', fecha_inicio: '2021-05-26', orden: 6 },
  ]);

  // Insertar fila en sil_leyes para el expediente 23.234
  const { data: ley } = await supabase.from('sil_leyes').insert({
    expediente_origen_id: EXP_LEY,
    numero_ley: '9999',
    numero_gaceta: '94',
    alcance: '67',
    fecha_aprobacion_2_3: '2021-04-22',
    fecha_emitido_asamblea: '2021-04-22',
    fecha_sancionado: '2021-05-10',
    fecha_publicacion: '2021-05-26',
    fecha_rige: '2021-05-26',
    estado: 'Vigente',
    reselo: false,
  }).select('id').single();
  log(`sil_leyes row creado para 23.234 (Gaceta 94, Alcance 67)`);

  // Afectaciones — esta ley deroga ley anterior
  if (ley) {
    await supabase.from('sil_leyes_afectaciones').insert([
      {
        ley_id_origen: ley.id,
        ley_numero_afectada: 'Ley 5395',
        tipo: 'deroga',
        articulos: 'arts. 117 y 118 (régimen anterior de medicamentos)',
      },
      {
        ley_id_origen: ley.id,
        ley_numero_afectada: 'Ley 8839',
        tipo: 'reforma',
        articulos: 'art. 23, inciso c (referencias a la nueva ley)',
      },
    ]);
    log('2 afectaciones insertadas');
  }

  console.log('=== DECRETOS EJECUTIVOS DEMO — pedido 16i ===');
  // 3 decretos demo bien armados con expedientes ampliados/retirados
  const { data: decreto1 } = await supabase.from('decretos_ejecutivos').insert({
    numero_decreto: '45461-MP',
    fecha: '2026-04-21',
    tipo: 'mixto',
    periodo_legislativo: 'CUARTA LEGISLATURA 2025-2026, SEGUNDO PERÍODO DE SESIONES EXTRAORDINARIAS',
    documento_url: 'https://www.asamblea.go.cr/glcp/Decretos/...',
    sharepoint_item_id: 'demo-45461',
    raw: { demo: true },
    parser_status: 'done',
  }).select('id').single();

  const { data: decreto2 } = await supabase.from('decretos_ejecutivos').insert({
    numero_decreto: '45437-MP',
    fecha: '2026-01-26',
    tipo: 'retiro',
    periodo_legislativo: 'CUARTA LEGISLATURA 2025-2026, SEGUNDO PERÍODO DE SESIONES EXTRAORDINARIAS',
    documento_url: 'https://www.asamblea.go.cr/glcp/Decretos/...',
    sharepoint_item_id: 'demo-45437',
    raw: { demo: true },
    parser_status: 'done',
  }).select('id').single();

  const { data: decreto3 } = await supabase.from('decretos_ejecutivos').insert({
    numero_decreto: '44750-MP',
    fecha: '2024-11-12',
    tipo: 'ampliacion',
    periodo_legislativo: 'TERCERA LEGISLATURA 2024-2025, SEGUNDO PERÍODO DE SESIONES EXTRAORDINARIAS',
    documento_url: 'https://www.asamblea.go.cr/glcp/Decretos/...',
    sharepoint_item_id: 'demo-44750',
    raw: { demo: true },
    parser_status: 'done',
  }).select('id').single();
  log('3 decretos demo insertados (1 mixto, 1 retiro, 1 ampliación)');

  // Convocatoria: el último decreto (más reciente) define el estado vigente
  await supabase.from('sil_expediente_convocatoria').insert([
    // Decreto 45461 (más reciente) → convoca 23.511 y 24.696, retira 25.082
    { expediente_id: EXP, decreto_id: decreto1!.id, fecha_decreto: '2026-04-21', accion: 'convocado', sigue_vigente: true },
    { expediente_id: '24.696', decreto_id: decreto1!.id, fecha_decreto: '2026-04-21', accion: 'convocado', sigue_vigente: true },
    { expediente_id: '25.082', decreto_id: decreto1!.id, fecha_decreto: '2026-04-21', accion: 'retirado', sigue_vigente: false },
    // Decreto 45437 (antes) — retiros
    { expediente_id: '24.811', decreto_id: decreto2!.id, fecha_decreto: '2026-01-26', accion: 'retirado', sigue_vigente: false },
    // Decreto 44750 (antes) — ampliaciones
    { expediente_id: '23.766', decreto_id: decreto3!.id, fecha_decreto: '2024-11-12', accion: 'convocado', sigue_vigente: true },
    { expediente_id: '24.945', decreto_id: decreto3!.id, fecha_decreto: '2024-11-12', accion: 'convocado', sigue_vigente: true },
  ]);
  log('6 filas de convocatoria insertadas');

  console.log('=== CENTINELA EVENTOS + ALERTAS — pedidos 6, 11, 11.bis, 16d, 16e ===');
  // 5 eventos diversos para mostrar cobertura completa
  const { data: ev_audiencia } = await supabase.from('centinela_eventos').insert({
    event_type: 'audiencia_confirmada',
    priority: 'critical',
    expediente_id: EXP,
    payload: {
      asistente: 'Gabriela Chacón',
      cargo: 'Presidenta Ejecutiva',
      organizacion: 'Instituto Nacional de Seguros (INS)',
      fecha_audiencia: '2026-05-19',
      comision: 'AMBIENTE (ÁREA IV)',
    },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  const { data: ev_137_2do } = await supabase.from('centinela_eventos').insert({
    event_type: 'mocion_fondo_presentada',
    priority: 'critical',
    expediente_id: EXP,
    payload: { articulo: 137, dia_sesion: 'segundo', fecha_sesion: '2026-05-12', documento_url: 'https://www.asamblea.go.cr/...' },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  const { data: ev_137_1ro } = await supabase.from('centinela_eventos').insert({
    event_type: 'mocion_fondo_presentada',
    priority: 'high',
    expediente_id: EXP,
    payload: { articulo: 137, dia_sesion: 'primer', fecha_sesion: '2026-04-15', documento_url: 'https://www.asamblea.go.cr/...' },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  const { data: ev_decreto } = await supabase.from('centinela_eventos').insert({
    event_type: 'decreto_convocatoria',
    priority: 'high',
    expediente_id: EXP,
    payload: { decreto_numero: '45461-MP', accion: 'convocado', fecha_decreto: '2026-04-21' },
    source_url: 'demo',
  }).select('id').single();

  const { data: ev_orden_dia } = await supabase.from('centinela_eventos').insert({
    event_type: 'orden_dia_publicada',
    priority: 'medium',
    expediente_id: EXP,
    payload: { fecha_sesion: '2026-05-19', posicion: 3, comision: 'AMBIENTE (ÁREA IV)' },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  log('5 eventos centinela insertados (1 critical audiencia, 1 critical 2do día, 1 high 1er día, 1 high decreto, 1 medium orden día)');

  await supabase.from('centinela_alerts_v2').insert([
    { user_id: USER, event_id: ev_audiencia!.id, priority: 'critical', title: '🔴 Audiencia confirmada — exp 23.511', body: 'Gabriela Chacón (Presidenta Ejecutiva del INS) va a audiencia en Comisión Ambiente el jueves 19/05/2026. Cliente: cualquiera con interés en seguros/ambiente.', channel: 'in_app' },
    { user_id: USER, event_id: ev_137_2do!.id, priority: 'critical', title: '🔴 VOTACIÓN inminente (2do día 137) — exp 23.511', body: 'Las mociones art. 137 sobre el proyecto se votan HOY 12/05/2026. Última oportunidad para lobby de fracciones.', channel: 'in_app' },
    { user_id: USER, event_id: ev_137_1ro!.id, priority: 'high', title: '🟠 Moción 137 (1er día) — exp 23.511', body: 'Se presentaron mociones de fondo art. 137 sobre el proyecto (15/04/2026). Aún hay margen para presentar adicionales o preparar respuesta.', channel: 'in_app' },
    { user_id: USER, event_id: ev_decreto!.id, priority: 'high', title: '🟠 Decreto 45461-MP — exp 23.511 convocado', body: 'El Poder Ejecutivo amplió la convocatoria al expediente (21/04/2026). Puede discutirse en Plenario hasta nuevo decreto.', channel: 'in_app' },
    { user_id: USER, event_id: ev_orden_dia!.id, priority: 'medium', title: '🟡 Entró al orden del día — exp 23.511', body: 'El proyecto aparece en posición 3 del orden del día de Comisión Ambiente para el 19/05/2026.', channel: 'in_app' },
  ]);
  log('5 alertas centinela_alerts_v2 insertadas');

  console.log('=== RESUMEN ===');
  log(`Expediente principal: ${EXP} (Ley Marco Recurso Hídrico)`);
  log(`Expediente con ley: ${EXP_LEY} (Ley General de Medicamentos)`);
  log(`User demo: madebyjred@gmail.com (5 alertas: 2 critical, 2 high, 1 medium)`);
  log('3 decretos ejecutivos demo + 6 convocatorias');
})();
