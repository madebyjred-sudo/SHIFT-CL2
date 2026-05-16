// Seed extendido — pone data demostrable en `sil_expedientes.metadata` (jsonb)
// para los pedidos 07, 16g, 16h, 12a, 16c, 16j, 16e que aún no tienen
// tablas propias (migrations pendientes).
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

(async () => {
  const EXP = '23.511';

  // Construir metadata enriquecida
  const metadata = {
    // ── Pedido 07 + 16g (fecha negrita) + 16h (recálculo histórico)
    fechas_extraidas: {
      vigente: {
        campo: 'fecha_dictamen_estimada',
        valor_fecha: '2026-05-08',
        valor_texto_original: 'Fecha para dictaminar (ESTIMADA): 8 de mayo de 2026',
        fuente_documento_url: 'https://www.asamblea.go.cr/glcp/Ordenes_dia/.../OD-AMBIENTE-15-04-2026.pdf',
        fuente_pagina: 2,
        extraction_method: 'regex',
        extraction_confidence: 0.95,
        visual_marker: 'bold',   // pedido 16g — la fecha aparece EN NEGRITA en el doc
        extracted_at: '2026-04-15T10:30:00Z',
      },
      historial: [
        {
          valor_fecha: '2026-03-10',
          extracted_at: '2025-11-28T08:00:00Z',
          superseded_reason: 'calculo_inicial — 120 días hábiles desde inicio',
        },
        {
          valor_fecha: '2026-04-05',
          extracted_at: '2026-02-12T14:20:00Z',
          superseded_reason: 'feriados — Semana Santa + 2 sesiones canceladas',
        },
        {
          valor_fecha: '2026-05-08',
          extracted_at: '2026-04-15T10:30:00Z',
          superseded_reason: 'mocion_prorroga — Comisión aprobó art. 119 RAL para nuevo plazo',
        },
      ],
      otras_fechas: {
        fecha_cuatrienal: { valor: '2029-04-15', texto: 'Fecha cuatrienal: 15 de abril de 2029' },
        vence_subcomision: { valor: '2026-03-25', texto: 'vence el 25/03/2026' },
      },
    },
    // ── Pedido 12a — consultas a Sala Constitucional asociadas
    consultas_sala_constitucional: [
      {
        fecha_consulta: '2024-08-15',
        fecha_resolucion: '2024-10-22',
        decision: 'sin_lugar',
        por_tanto: 'Esta Sala evacua la consulta facultativa de constitucionalidad sin lugar. La normativa consultada no presenta vicios de constitucionalidad detectables.',
        magistrados: 'Hernández López, Castillo Víquez, Salazar Alvarado',
        documento_url: 'https://www.asamblea.go.cr/glcp/Votos%20de%20la%20Sala%20Constitucional/Votos/23.511/voto-23-511.pdf',
      },
    ],
    // ── Pedido 16e — audiencias detectadas para el expediente
    audiencias: [
      {
        fecha: '2026-05-19',
        hora: '10:00',
        comision: 'AMBIENTE (ÁREA IV)',
        asistente_nombre: 'Gabriela Chacón',
        asistente_cargo: 'Presidenta Ejecutiva',
        asistente_organizacion: 'Instituto Nacional de Seguros (INS)',
        posicion_estimada: 'condicional',
      },
    ],
    // ── Pedido 16j — algoritmo Carlos: detección novedad mociones
    novedades_detectadas: [
      {
        fecha_deteccion: '2026-05-12T15:42:00Z',
        tipo: 'mocion_segundo_dia_no_reflejada_en_tramitacion',
        descripcion: 'Se detectó moción 137 (segundo día) en la lista del SharePoint, pero no aparece reflejada como "remisión a comisión" en la pestaña Tramitación. Probable: votación se decidió en sesión sin acta cargada todavía.',
        algoritmo: 'cruce LEFT JOIN entre lista_mociones (SharePoint) y sil_expediente_tramite, filtrando WHERE descripcion NOT ILIKE remisión_mociones',
        confidence: 0.88,
      },
    ],
    // ── Pedido 16c — apariciones del expediente en órdenes del día parseados
    // por capítulo + debate (ordenDiaSectionParser.ts). El parser corre cuando
    // agendaScrape descarga el PDF oficial. Acá seedeamos 3 entradas demo:
    // próxima (futuro) + 2 anteriores, así el panel muestra hero + historial.
    orden_dia_apariciones: [
      {
        fecha_sesion: '2026-05-20',
        hora: '15:00',
        numero_sesion: 147,
        tipo_sesion: 'ordinaria',
        capitulo: 'capitulo_tercero',
        capitulo_titulo: 'CAPÍTULO TERCERO',
        debate: 'primer_debate',
        orden_pdf_url: 'https://www.asamblea.go.cr/orden-dia/2026-05-20-plenario.pdf',
        contexto_extracto: '23.511 LEY MARCO PARA LA GESTIÓN INTEGRADA DEL RECURSO HÍDRICO. Expediente dictaminado afirmativamente por la Comisión Permanente de Ambiente, listo para primer debate.',
      },
      {
        fecha_sesion: '2026-05-13',
        hora: '15:00',
        numero_sesion: 143,
        tipo_sesion: 'ordinaria',
        capitulo: 'capitulo_segundo',
        capitulo_titulo: 'CAPÍTULO SEGUNDO',
        debate: 'mocion_orden',
        orden_pdf_url: 'https://www.asamblea.go.cr/orden-dia/2026-05-13-plenario.pdf',
        contexto_extracto: 'Moción de orden — solicitud de prórroga al plazo cuatrienal del expediente 23.511.',
      },
      {
        fecha_sesion: '2026-04-22',
        hora: '15:00',
        numero_sesion: 131,
        tipo_sesion: 'ordinaria',
        capitulo: 'capitulo_tercero',
        capitulo_titulo: 'CAPÍTULO TERCERO',
        debate: 'sin_clasificar',
        orden_pdf_url: 'https://www.asamblea.go.cr/orden-dia/2026-04-22-plenario.pdf',
        contexto_extracto: 'Discusión preliminar — pendiente clasificación de debate (acta sin cargar).',
      },
    ],
  };

  const { error } = await sb
    .from('sil_expedientes')
    .update({ metadata })
    .eq('numero', EXP);

  if (error) {
    console.error('UPDATE error:', error.message);
    process.exit(1);
  }

  console.log('Metadata enriquecida en exp', EXP, '→ pedidos 07, 12a, 16e, 16g, 16h, 16j cubiertos');

  // ── Pedido 08 — actas comisiones quien dijo qué (transcript_segments)
  // Insertar algunas filas demo con source_type='acta_comision' + speakers
  // Si transcript_segments NO acepta source_type='acta_comision', insertamos
  // en metadata.acta_speakers como fallback.
  await sb.from('sil_expediente_consultas')
    .delete()
    .eq('expediente_id', EXP)
    .eq('entidad_consultada', 'Acta sintética demo'); // limpia previos

  // Probar insertar en transcript_segments con campo source_type / acta_comision
  const transcriptRows = [
    {
      session_id: null,
      speaker_role: 'Diputado',
      speaker_full_name: 'Mario Redondo Poveda',
      start_seconds: 0,
      end_seconds: 65,
      text: 'Compañeras y compañeros, esta moción 137 que estamos discutiendo busca incorporar al artículo 12 una salvaguarda específica para los usos prioritarios del recurso hídrico. Considero indispensable apoyarla, pero quiero observar que faltó coordinación con el Ministerio.',
    },
    {
      session_id: null,
      speaker_role: 'Diputada',
      speaker_full_name: 'Natalia Díaz Quintana',
      start_seconds: 65,
      end_seconds: 132,
      text: 'Gracias, presidente. Sobre el expediente 23.511, quiero dejar constancia de mi posición a favor con reservas. La moción del diputado Redondo es válida pero deberíamos abrir audiencia técnica al INS antes de cerrar el dictamen.',
    },
    {
      session_id: null,
      speaker_role: 'Presidente',
      speaker_full_name: 'Antonio Álvarez Desanti',
      start_seconds: 132,
      end_seconds: 198,
      text: 'Tomado nota. Se acuerda convocar a audiencia técnica a Gabriela Chacón, Presidenta del INS, para la sesión del 19 de mayo. Procedemos a votar la moción.',
    },
  ];

  // Intentar insertar; si schema no soporta, se ignora
  try {
    for (const row of transcriptRows) {
      const { error: tsErr } = await sb.from('transcript_segments').insert({
        ...row,
        // campos adicionales si la tabla los soporta
      });
      if (tsErr) {
        // OK, falló — guardamos como fallback en metadata
        break;
      }
    }
  } catch {}

  // Fallback: guardar las "actas demo" en metadata del expediente
  const { data: current } = await sb
    .from('sil_expedientes')
    .select('metadata')
    .eq('numero', EXP)
    .single();

  const meta = { ...(current?.metadata as any || {}) };
  meta.actas_comision = [
    {
      acta_numero: 14,
      comision: 'AMBIENTE (ÁREA IV)',
      fecha_sesion: '2026-04-15',
      url: 'https://www.asamblea.go.cr/glcp/Actas/2025-2026-AMBIENTE-SESION-14.pdf',
      speakers: transcriptRows.map(r => ({
        role: r.speaker_role,
        nombre: r.speaker_full_name,
        timestamp_aprox: `${Math.floor(r.start_seconds / 60)}:${String(r.start_seconds % 60).padStart(2, '0')}`,
        texto: r.text,
      })),
    },
  ];

  await sb.from('sil_expedientes').update({ metadata: meta }).eq('numero', EXP);
  console.log('Actas comisión demo (3 speakers) → pedido 08 cubierto');

  // ─── Pedido 16k — texto sustitutivo descargable + prioridad Lexa ─────
  // Insertamos un texto_sustitutivo + dictamen_mayoria + texto original.
  // En `renderExpedienteFullForLlm` el sustitutivo se rankea PRIMERO con
  // marker ★ VIGENTE para que el LLM sepa cuál es el texto operante.
  await sb.from('sil_expediente_documentos')
    .delete()
    .eq('expediente_id', EXP)
    .in('tipo', ['texto_sustitutivo', 'dictamen_mayoria', 'mocion_137_segundo_dia', 'mocion_137_primer_dia']);

  const docs = [
    {
      expediente_id: EXP,
      tipo: 'texto_sustitutivo',
      titulo: 'Texto sustitutivo aprobado por la Comisión de Ambiente — versión 3 (4 may 2026)',
      fecha: '2026-05-04',
      url: 'https://www.asamblea.go.cr/glcp/Documentos/23.511/texto-sustitutivo-v3-2026-05-04.pdf',
      storage_path: null,
      embed_status: 'done',
    },
    {
      expediente_id: EXP,
      tipo: 'dictamen_mayoria',
      titulo: 'Dictamen afirmativo de mayoría — Comisión Permanente de Ambiente',
      fecha: '2026-05-05',
      url: 'https://www.asamblea.go.cr/glcp/Documentos/23.511/dictamen-mayoria-2026-05-05.pdf',
      storage_path: null,
      embed_status: 'done',
    },
    {
      expediente_id: EXP,
      tipo: 'mocion_137_segundo_dia',
      titulo: 'Moción 137 (segundo día) — Mociones de fondo presentadas por dip. Redondo Poveda',
      fecha: '2026-05-10',
      url: 'https://www.asamblea.go.cr/glcp/Documentos/23.511/mocion-137-2do-dia-2026-05-10.pdf',
      storage_path: null,
      embed_status: 'done',
    },
    {
      expediente_id: EXP,
      tipo: 'mocion_137_primer_dia',
      titulo: 'Moción 137 (primer día) — Mociones aprobadas en comisión',
      fecha: '2026-04-29',
      url: 'https://www.asamblea.go.cr/glcp/Documentos/23.511/mocion-137-1er-dia-2026-04-29.pdf',
      storage_path: null,
      embed_status: 'done',
    },
  ];

  const { error: docsErr } = await sb.from('sil_expediente_documentos').insert(docs);
  if (docsErr) {
    console.error('docs insert error:', docsErr.message);
  } else {
    console.log('Documentos demo (4: sustitutivo, dictamen, 2 mociones) → pedido 16k cubierto');
  }

  // ─── Pedido 16j — datos para que el detector vivo encuentre novedades ──
  // Insertamos 2 rows en sil_sharepoint_raw con tipos:
  //   1) Una moción 137 SEGUNDO DÍA del 12-may → SIN reflejo en
  //      sil_expediente_tramite → el detector debe disparar novedad.
  //   2) Una consulta de actas del 14-may → SIN evento en tramite → novedad.
  // Estas filas viven en sil_sharepoint_raw para que el detector las
  // encuentre EN VIVO cuando el frontend pida /api/expedientes/23.511/full.
  await sb.from('sil_sharepoint_raw')
    .delete()
    .in('item_id', ['demo-mocion-23511-1', 'demo-acta-23511-1']);

  await sb.from('sil_sharepoint_raw').insert([
    {
      list_id: 'demo-consultas-mociones-guid',
      item_id: 'demo-mocion-23511-1',
      list_title: 'Consultas_mociones',
      payload: {
        Title:
          'Moción art. 137 segundo día — Expediente 23.511 LEY MARCO RECURSO HÍDRICO — presentada en comisión de Ambiente',
        FechaConsulta: '2026-05-12',
        Modified: '2026-05-12T15:30:00Z',
        Asunto: 'Mociones de fondo segundo día',
      },
      etag: 'demo-etag-1',
      scraped_at: new Date().toISOString(),
    },
    {
      list_id: 'demo-actas-guid',
      item_id: 'demo-acta-23511-1',
      list_title: 'Actas',
      payload: {
        Title:
          'Acta sesión #17 Comisión de Ambiente — discusión expediente 23.511 LEY MARCO RECURSO HÍDRICO',
        FechaSesion: '2026-05-14',
        Modified: '2026-05-14T18:00:00Z',
      },
      etag: 'demo-etag-2',
      scraped_at: new Date().toISOString(),
    },
  ]);
  console.log('SharePoint demo (2 rows) → detector vivo va a disparar 2 novedades para pedido 16j');
})();
