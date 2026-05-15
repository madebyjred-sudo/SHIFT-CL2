// Seed datos demo para Sprint v3 visual sweep.
// Pobla 23.511 con tramitación + proponentes + consultas + ley demo +
// 3 alertas Centinela + 1 decreto ejecutivo procesado.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EXP = '23.511';
const USER = 'b8a6cbeb-8b6c-463b-8a1a-a12a2e2e9fd4'; // madebyjred@gmail.com

(async () => {
  console.log('Cleaning previous demo data...');
  await supabase.from('sil_expediente_tramite').delete().eq('expediente_id', EXP);
  await supabase.from('sil_expediente_proponentes').delete().eq('expediente_id', EXP);
  await supabase.from('sil_expediente_consultas').delete().eq('expediente_id', EXP);
  await supabase.from('sil_expediente_documentos').delete().eq('expediente_id', EXP);
  await supabase.from('sil_expediente_convocatoria').delete().eq('expediente_id', EXP);
  await supabase.from('centinela_alerts_v2').delete().eq('user_id', USER);
  await supabase.from('centinela_eventos').delete().eq('expediente_id', EXP);
  await supabase.from('decretos_ejecutivos').delete().eq('sharepoint_item_id', 'demo-sprint-v3');

  console.log('Seeding tramitación...');
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

  console.log('Seeding proponentes...');
  await supabase.from('sil_expediente_proponentes').insert([
    { expediente_id: EXP, firma_orden: 1, diputado_nombre: 'IZQUIERDO SANDÍ OSCAR', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 2, diputado_nombre: 'NICOLÁS ALVARADO JOSE FRANCISCO', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 3, diputado_nombre: 'MOREIRA BROWN KATHERINE ANDREA', administracion: '2022-2026', fraccion: 'PLN' },
    { expediente_id: EXP, firma_orden: 4, diputado_nombre: 'BARQUERO BARQUERO DINORAH CRISTINA', administracion: '2022-2026', fraccion: 'PLP' },
    { expediente_id: EXP, firma_orden: 5, diputado_nombre: 'RUÍZ GUEVARA MONSERRAT', administracion: '2022-2026', fraccion: 'PLP' },
  ]);

  console.log('Seeding consultas...');
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
      fecha_respuesta: null,
      tipo_respuesta: null,
      resumen_por_tanto: null,
    },
  ]);

  console.log('Seeding documentos descargables...');
  await supabase.from('sil_expediente_documentos').insert([
    { expediente_id: EXP, tipo: 'texto_sustitutivo', titulo: 'Texto Sustitutivo aprobado por subcomisión', fecha: '2023-09-15', url: 'https://www.asamblea.go.cr/proyectos/23-511-sustitutivo.pdf' },
    { expediente_id: EXP, tipo: 'dictamen_mayoria', titulo: 'Dictamen unánime afirmativo', fecha: '2023-10-10', url: 'https://www.asamblea.go.cr/proyectos/23-511-dictamen.pdf' },
    { expediente_id: EXP, tipo: 'mocion_137_primer_dia', titulo: 'Informe de mociones 137 - Primer Día', fecha: '2026-04-15', url: 'https://www.asamblea.go.cr/proyectos/23-511-137-primer-dia.pdf' },
  ]);

  console.log('Seeding decreto ejecutivo demo...');
  const { data: decreto } = await supabase
    .from('decretos_ejecutivos')
    .insert({
      numero_decreto: '45461-MP',
      fecha: '2026-04-21',
      tipo: 'mixto',
      periodo_legislativo: 'CUARTA LEGISLATURA 2025-2026, SEGUNDO PERÍODO DE SESIONES EXTRAORDINARIAS',
      documento_url: 'https://www.asamblea.go.cr/glcp/Decretos_Ejecutivos_Ampliacion/CUARTA LEGISLATURA 2025-2026, SEGUNDO PERÍODO DE SESIONES EXTRAORDINARIAS/DECRETO DE RETIRO %26 AMPLIACIÓN 45461-MP  21-04-2026.pdf',
      sharepoint_item_id: 'demo-sprint-v3',
      raw: { demo: true, ampliados: ['23.511', '24.696'], retirados: ['25.082'] },
      parser_status: 'done',
    })
    .select('id')
    .single();

  await supabase.from('sil_expediente_convocatoria').insert([
    { expediente_id: EXP, decreto_id: decreto!.id, fecha_decreto: '2026-04-21', accion: 'convocado', sigue_vigente: true },
  ]);

  console.log('Seeding centinela alerts...');
  const { data: ev1 } = await supabase.from('centinela_eventos').insert({
    event_type: 'audiencia_confirmada',
    priority: 'critical',
    expediente_id: EXP,
    payload: { asistente: 'Gabriela Chacón', cargo: 'Presidenta Ejecutiva', organizacion: 'INS', fecha_audiencia: '2026-05-19', comision: 'AMBIENTE (ÁREA IV)' },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  const { data: ev2 } = await supabase.from('centinela_eventos').insert({
    event_type: 'mocion_fondo_presentada',
    priority: 'high',
    expediente_id: EXP,
    payload: { articulo: 137, dia_sesion: 'primer', fecha_sesion: '2026-04-15', documento_url: 'https://www.asamblea.go.cr/...' },
    comision: 'AMBIENTE (ÁREA IV)',
    source_url: 'demo',
  }).select('id').single();

  const { data: ev3 } = await supabase.from('centinela_eventos').insert({
    event_type: 'decreto_convocatoria',
    priority: 'high',
    expediente_id: EXP,
    payload: { decreto_numero: '45461-MP', accion: 'convocado' },
    source_url: 'demo',
  }).select('id').single();

  // Migration 0033 creó centinela_alerts_v2 paralelo a la tabla legacy.
  // El endpoint nuevo /api/centinela/alertas usa _v2.
  await supabase.from('centinela_alerts_v2').insert([
    { user_id: USER, event_id: ev1!.id, priority: 'critical', title: '🔴 Audiencia confirmada — exp 23.511', body: 'Gabriela Chacón (presidenta INS) va a audiencia en Comisión Ambiente el jueves 19/05.', channel: 'in_app' },
    { user_id: USER, event_id: ev2!.id, priority: 'high', title: '🟠 Moción 137 (1er día) — exp 23.511', body: 'Se presentaron mociones de fondo art. 137 sobre el proyecto. Aún hay margen para incidir.', channel: 'in_app' },
    { user_id: USER, event_id: ev3!.id, priority: 'high', title: '🟠 Decreto 45461-MP — exp 23.511 convocado', body: 'El Poder Ejecutivo amplió la convocatoria al expediente. Puede discutirse en Plenario.', channel: 'in_app' },
  ]);

  console.log('---');
  console.log('Seed completo. Resumen:');
  console.log('  expediente 23.511 con tramite (8) + proponentes (5) + consultas (2) + documentos (3) + convocatoria');
  console.log('  3 alertas Centinela para user', USER, '(1 critical + 2 high)');
  console.log('  1 decreto ejecutivo demo procesado (45461-MP)');
})();
