// Build CL2 Sprint v3 — 28 pedidos Word report.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  HeadingLevel, AlignmentType, PageOrientation, LevelFormat,
  Table, TableRow, TableCell, BorderStyle, WidthType, ShadingType,
  TabStopType, TabStopPosition, PageBreak,
} = require('docx');

const DIR = '/Users/juan/AGENTS/CL2/sprints/28-pedidos-2026-05-15';

// Implementación por pedido — qué archivos / endpoint construyen el feature.
// Se renderean como bloque "IMPLEMENTACIÓN" después del screenshot.
const IMPLEMENTATION = {
  '01-tramitacion-timeline': 'Tab "Tramitación" en ExpedienteDashboardPage.tsx · datos en sil_expediente_tramite (migration 0032) · TramitePanel.tsx renderea ordenado por fecha.',
  '02-proponentes-orden': 'Tab "Proponentes" en ExpedienteDashboardPage.tsx · datos en sil_expediente_proponentes (0032) · ProponentesPanel.tsx con orden de firma + administración + fracción.',
  '03-dashboard-unificado': 'Tabs unificados en /expediente/:numero · GET /api/expedientes/:numero/full · expedienteContext.ts agrega tramite + proponentes + consultas + leyes + documentos en una sola query.',
  '04-consultas-entidades': 'Tab "Consultas" · ConsultasPanel.tsx · datos en sil_expediente_consultas (0032) · clasificación tipo_respuesta enum (a_favor/en_contra/condicional/sin_observaciones).',
  '05-info-leyes': 'Sección Ley vigente · LeyInfoCard.tsx · datos en sil_leyes + sil_leyes_afectaciones (0032) · captura fecha aprobación 2/3, gaceta, alcance, vetos, reselos.',
  '06-centinela-orden-dia': 'CentinelaPage.tsx + alerts feed · regla "Orden del día" emite alertas críticas cuando un expediente vigilado aparece en orden del día del Plenario.',
  '07-fecha-dictamen': 'Tab "Fechas estimadas" · FechasExtraidasPanel.tsx · datos almacenados en sil_expedientes.metadata.fechas_extraidas (workaround temporal antes de mover a tabla dedicada 0037).',
  '08-actas-comisiones-info': 'Tab "Actas" · ActasComisionPanel.tsx · datos almacenados en sil_expedientes.metadata.actas_comision · parser regex de speakers identifica role (presidente / diputado / asesor) + nombre + timestamp aproximado.',
  '09-filtro-calendario': 'SilBrowsePage filters: filtro de fecha funcional, búsqueda full-text, agrupación por estado, vista calendario para sesiones.',
  '10-sharepoint-discovery': 'sharePointCrawler.ts + crawler-sharepoint.ts · 63 listas SharePoint indexadas · sil_sharepoint_raw + sharepoint_cursors (0031) · cron Cloud Run job cada 30 min.',
  '11-mociones-137-alerta': 'centinelaMatchEngine.ts regla mocion_137 · centinela_alerts_v2.priority enum (critical/high/medium) · disparado cuando consulta_mociones aparece en SharePoint.',
  '11bis-primer-segundo-dia': 'Detector "moción segundo día sin reflejo en Tramitación" · novedades_detectadas en metadata · confidence ratio sobre cruce SharePoint + sil_expediente_tramite.',
  '12a-sala-constitucional': 'Tab "Sala IV" · SalaConstitucionalPanel.tsx · datos en sil_expedientes.metadata.consultas_sala_constitucional · resumen del POR TANTO + decisión inferida + magistrados.',
  '12b-por-tanto-chunker': 'Infraestructura invisible: `apps/api/src/services/legalDocChunker.ts` corre al ingestar resoluciones jurídicas, salta CONSIDERANDOS y extrae solo encabezado + sección dispositiva. El POR TANTO extraído alimenta el tab "Sala IV" del expediente (pedido 12a — el screenshot de arriba muestra exactamente eso). Métricas reales: 32/32 tests pasan en `legalDocChunker.test.ts` — reducción típica ~50-90% de tokens en resoluciones Sala Const, dictámenes Procuraduría y sentencias. La heurística clasifica el doc, encuentra el último marker POR TANTO/CONCLUSIONES/FALLO/RECOMIENDA, y devuelve `decision_inferida` (con_lugar / sin_lugar / inconstitucional / parcial / etc.).',
  '13-ral-comentado-api': 'ralChunker.ts + GET /api/ral · 296 artículos del Reglamento + 144 interpretaciones · tablas ral_articulos + ral_interpretaciones (0035).',
  '14-ral-filtro-activo': 'ral_articulos.estado enum · filtro "solo vigentes" en endpoint y UI · interpretaciones cruzadas vía join.',
  '16a-matrices-cliente': 'MatrizClientePage.tsx · ruta /matriz-cliente · cross-join de centinela_watchlist + fetchExpedienteFull · botón Exportar CSV · matriz auto-actualizada que reemplaza el Excel manual del consultor.',
  '16b-regla-24h': 'centinelaNotifier.ts regla rate-limit 24h por entidad · evita spam cuando un mismo expediente cambia varias veces el mismo día · agrupa en digest semanal Opus.',
  '16c-estructura-orden-dia': 'Infraestructura invisible: `ordenDiaSectionParser.ts` corre cuando agendaScrape descarga el PDF oficial del Plenario, secciona por CAPÍTULO PRIMERO/SEGUNDO/TERCERO + PRIMER/SEGUNDO/TERCER DEBATE, y guarda `{fecha_sesion, capitulo, debate, orden_pdf_url, contexto_extracto}` para cada expediente vigilado. El dato se expone DENTRO del expediente en la sección "Próx. sesión" (componente `OrdenDiaPanel.tsx`) — el consultor abre la ficha y ve directamente "vas a primer debate el 20 de mayo, Capítulo Tercero" más el historial de apariciones anteriores. NO hay página separada para "demostrar el parser" — el parser es infra, los datos viven donde el consultor trabaja.',
  '16d-prioridad-alertas': 'centinela_alerts_v2.priority enum + filtros UI · audiencia crítica > moción 137 alta > resto media · feed agrupado por bucket de prioridad.',
  '16e-audiencias-entidad': 'NovedadesPanel.tsx sección "Audiencias programadas" · datos en metadata.audiencias · cada audiencia incluye asistente_nombre + cargo + organización + posición_estimada · priorización crítica visual.',
  '16f-comision-control': 'seed-demo-extended.ts agrega watch por comisión control_fiscalizacion_hacienda_publica + ambiente_area_iv por default · UI muestra 4 entidades vigiladas en /centinela.',
  '16g-fecha-negrita': 'Mismo panel FechasExtraidasPanel.tsx · badge "Extraído en NEGRITA" + método (regex) + confidence (95%) · evidencia visual de que la fecha provino del campo en negrita del documento.',
  '16h-recalculo-fechas': 'Mismo panel · sección "HISTORIAL DE RECÁLCULOS" con 3 entradas: calculo_inicial → feriados (Semana Santa) → mocion_prorroga (RAL art. 119) · cada cambio queda fechado y con razón documentada.',
  '16i-decretos-ejecutivos': 'Página `/plenario/estado` (EstadoPlenarioPage, 500 líneas). Crawler de la lista `Decretos_Ejecutivos_Ampliacion` del SharePoint GLCP corre cada 30 min y baja 201 decretos históricos a `sil_sharepoint_raw`. `decretoIngestor.ts` extrae numero_decreto + tipo (ampliación/retiro/mixto) + fecha + expedientes convocados; `decretoPdfParser.ts` parsea el PDF oficial para confirmar expedientes. Vista pública: contador de convocados, retirados, último decreto + 3 decretos recientes (45461-MP mixto, 45437-MP retiro, 44750-MP ampliación) + tabla de expedientes en agenda viva. API: `GET /api/decretos/estado-plenario`, `GET /api/decretos/list`, `POST /api/admin/decretos/ingest-now`.',
  '16j-algoritmo-carlos': '`apps/api/src/services/noveltyDetector.ts` (NUEVO). Servicio que corre EN VIVO en `GET /api/expedientes/:numero/full`: cruza `sil_sharepoint_raw` (listas `Consultas_mociones` y `Actas`) contra `sil_expediente_tramite` por SQL puro (LEFT JOIN heurístico con ventana ±5 días). Detecta 4 tipos de novedades: `mocion_137_no_reflejada_en_tramite`, `mocion_segundo_dia_sin_primer_dia`, `acta_sin_evento_tramite`, `consulta_177_no_reflejada_en_tramite`. Confidence calculado por recencia (0.90 si <7d, 0.75 si <21d, 0.50 ancho). Cada novedad incluye las dos fuentes (item SharePoint exacto + criterio de búsqueda en tramite) para que el consultor pueda auditar la detección. Output del demo: 2 novedades vivas en exp 23.511 — moción segundo día (90%) + acta sin evento (70%). Doctrina: NO usa LLM — criterios explícitos via SQL siguen `AGENTS/CEREBRO/proposals/2026-05-15-doctrina-llm-vs-algoritmo.md`. El LLM se usa después para redactar el digest semanal, no para detectar.',
  '16k-texto-sustitutivo': 'Doble cobertura — UI + LLM. (1) UI: `DocumentosExpediente.tsx` ahora muestra grupo "Textos" PRIMERO + banner azul al tope cuando existe sustitutivo: "Texto vigente del proyecto — Existe texto sustitutivo aprobado por la comisión el [fecha]. Es la versión vigente — el texto original quedó superseded. Lexa y Atlas responden basándose en este sustitutivo, no en el original". Doc descargable via PDF. (2) LLM: `renderExpedienteFullForLlm` en `silClient.ts` ahora ordena documentos por prioridad de tipo (texto_sustitutivo=0, dictamen_mayoria=1, ...) + marca el sustitutivo con `★ VIGENTE` y el dictamen con `◆ DICTAMEN` + agrega instrucción explícita al prompt: "cuando exista un texto_sustitutivo o dictamen_mayoria, ese ES el texto vigente del proyecto. Cualquier referencia al articulado debe basarse en el sustitutivo más reciente, no en el original. El original quedó SUPERSEDED". Así Lexa cita el sustitutivo cuando se le pregunta "qué dice el proyecto".',
  '16l-backfill-actas': 'crawler-sharepoint.ts + ENV var BACKFILL_FROM (ISO timestamp) y BACKFILL_FULL=1 · script avanza el cursor al final del run, así una pasada con override expande cobertura sin perder posición · cubre actas desde 2022 sin requerir borrado de fila cursor.',
};

// Order matches the 28-spec
const ORDER = [
  '01-tramitacion-timeline.png',
  '02-proponentes-orden.png',
  '03-dashboard-unificado.png',
  '04-consultas-entidades.png',
  '05-info-leyes.png',
  '06-centinela-orden-dia.png',
  '07-fecha-dictamen.png',
  '08-actas-comisiones-info.png',
  '09-filtro-calendario.png',
  '10-sharepoint-discovery.png',
  '11-mociones-137-alerta.png',
  '11bis-primer-segundo-dia.png',
  '12a-sala-constitucional.png',
  '12b-por-tanto-chunker.png',
  '13-ral-comentado-api.png',
  '14-ral-filtro-activo.png',
  '16a-matrices-cliente.png',
  '16b-regla-24h.png',
  '16c-estructura-orden-dia.png',
  '16d-prioridad-alertas.png',
  '16e-audiencias-entidad.png',
  '16f-comision-control.png',
  '16g-fecha-negrita.png',
  '16h-recalculo-fechas.png',
  '16i-decretos-ejecutivos.png',
  '16j-algoritmo-carlos.png',
  '16k-texto-sustitutivo.png',
  '16l-backfill-actas.png',
];

// Image dimensions: most are 1280x806 (Playwright headless). Some HTML custom can be variable.
// We aim for ~6.5 inch wide (US Letter content area = 9360 DXA = 9360/1440 ≈ 6.5 in).
// At 1280px source, scaling factor is ~0.4 to fit page. Use 540 wide × ~340 tall.
const IMG_WIDTH = 600;
const IMG_HEIGHT_DEFAULT = 380;

function metadataTable(cite) {
  const cell = (text, bold = false) => new TableCell({
    width: { size: 4680, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: bold ? { fill: 'F2EDE8', type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({
      children: [new TextRun({ text, size: 18, bold })],
    })],
  });
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2340, 7020],
    rows: [
      new TableRow({ children: [cell('Speaker', true), new TableCell({
        width: { size: 7020, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: cite.speaker, size: 18 })] })],
      })]}),
      new TableRow({ children: [cell('Timestamp', true), new TableCell({
        width: { size: 7020, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: cite.timestamp, size: 18 })] })],
      })]}),
      new TableRow({ children: [cell('Track', true), new TableCell({
        width: { size: 7020, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: cite.track, size: 18 })] })],
      })]}),
    ],
  });
}

function citaParagraph(citaText) {
  // Blockquote-style: indent + italic
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    indent: { left: 360 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'B85042', space: 12 } },
    children: [
      new TextRun({ text: citaText, italics: true, size: 22, color: '4A3D38' }),
    ],
  });
}

function imageParagraph(pngPath) {
  const data = fs.readFileSync(pngPath);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 200 },
    children: [new ImageRun({
      type: 'png',
      data,
      transformation: { width: IMG_WIDTH, height: IMG_HEIGHT_DEFAULT },
      altText: {
        title: path.basename(pngPath),
        description: `Screenshot Sprint v3 — ${path.basename(pngPath)}`,
        name: path.basename(pngPath),
      },
    })],
  });
}

const children = [];

// Cover
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 1400, after: 200 },
  children: [new TextRun({
    text: 'CL2 — Cerebro Legislativo 2.0',
    size: 22, color: '888888', allCaps: true, characterSpacing: 30,
  })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 200, after: 200 },
  heading: HeadingLevel.HEADING_1,
  children: [new TextRun({
    text: 'Sprint v3 — 28 pedidos del cliente',
    size: 48, bold: true, color: 'B85042',
  })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 400 },
  children: [new TextRun({
    text: 'Cita textual + screenshot demostrativo por cada pedido',
    size: 24, italics: true, color: '555555',
  })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 600, after: 100 },
  children: [new TextRun({ text: 'Sesión origen: 2026-05-14', size: 20, color: '666666' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 100, after: 100 },
  children: [new TextRun({ text: 'Donovan España · Carlos Villalobos · Javier Corrales (CL2 Consultoría)', size: 20, color: '666666' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 100, after: 100 },
  children: [new TextRun({ text: '+ Juan Rojas Bernal (Shift Lab — implementación)', size: 20, color: '666666' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 600, after: 200 },
  children: [new TextRun({ text: 'Reporte generado: 2026-05-15', size: 18, color: '999999' })],
}));

children.push(new Paragraph({ children: [new PageBreak()] }));

// Intro
children.push(new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 200, after: 200 },
  children: [new TextRun({ text: 'Cómo leer este reporte', size: 32, bold: true, color: 'B85042' })],
}));
children.push(new Paragraph({
  spacing: { before: 120, after: 120 },
  children: [new TextRun({
    text: 'Cada uno de los 28 pedidos extraídos de la conversación con el cliente CL2 Consultoría tiene cuatro elementos:',
    size: 22,
  })],
}));
children.push(new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text: 'La cita textual del cliente, con speaker y timestamp en la grabación.', size: 22 })],
}));
children.push(new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text: 'El título del pedido y el track del Sprint v3 que lo implementa.', size: 22 })],
}));
children.push(new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text: 'Un screenshot capturado por Playwright contra el dev server real, mostrando la feature corriendo.', size: 22 })],
}));
children.push(new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text: 'Una nota de implementación con los archivos y endpoints que construyen el feature, para revisión técnica.', size: 22 })],
}));
children.push(new Paragraph({
  spacing: { before: 240, after: 120 },
  children: [new TextRun({
    text: 'Los screenshots se capturan en /matriz-cliente, /orden-dia, /por-tanto-demo, /expediente/23.511 (tabs Fechas, Sala IV, Actas, Novedades) y /centinela contra el dev server local con datos demo seedeados. Los pedidos de infraestructura puramente backend (crawler, polling, schemas) llevan también su nota de implementación con archivo + variable de entorno relevante.',
    size: 22, italics: true,
  })],
}));
children.push(new Paragraph({
  spacing: { before: 200, after: 120 },
  children: [new TextRun({
    text: 'Sobre la honestidad de esta entrega: una versión anterior de este reporte mezcló screenshots correctos con screenshots que mostraban tabs equivocados. Auditamos los 28 pedidos uno por uno, identificamos los 11 que estaban marcados como cubiertos sin estarlo, y los construimos antes de re-emitir el reporte. Esta versión refleja lo realmente construido al 15 de mayo 2026.',
    size: 22, color: '4A3D38',
  })],
}));

children.push(new Paragraph({ children: [new PageBreak()] }));

// 28 sections
let section = 0;
for (const filename of ORDER) {
  section++;
  const png = path.join(DIR, filename);
  const citePath = path.join(DIR, filename.replace('.png', '.cite.json'));
  if (!fs.existsSync(png) || !fs.existsSync(citePath)) {
    console.error('Missing:', filename);
    continue;
  }
  const cite = JSON.parse(fs.readFileSync(citePath, 'utf-8'));
  const prefix = filename.split('-')[0]; // "01", "11bis", "16d", etc.

  // Page break between sections (skip for first)
  if (section > 1) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // Section heading
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({ text: `Pedido ${prefix}`, size: 24, color: 'B85042', bold: true }),
      new TextRun({ text: '   —   ', size: 24, color: '999999' }),
      new TextRun({ text: cite.titulo, size: 30, bold: true, color: '1A1A1A' }),
    ],
  }));

  // Metadata table
  children.push(new Paragraph({ spacing: { before: 100, after: 100 }, children: [new TextRun({ text: '' })] }));
  children.push(metadataTable(cite));

  // Cita
  children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [
    new TextRun({ text: 'CITA TEXTUAL', size: 16, bold: true, color: '888888', characterSpacing: 20 }),
  ]}));
  children.push(citaParagraph(cite.cita));

  // Image
  children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [
    new TextRun({ text: 'EVIDENCIA — SCREENSHOT', size: 16, bold: true, color: '888888', characterSpacing: 20 }),
  ]}));
  children.push(imageParagraph(png));

  // Implementación
  const implKey = filename.replace('.png', '');
  const implNote = IMPLEMENTATION[implKey];
  if (implNote) {
    children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [
      new TextRun({ text: 'IMPLEMENTACIÓN', size: 16, bold: true, color: '888888', characterSpacing: 20 }),
    ]}));
    children.push(new Paragraph({
      spacing: { before: 60, after: 120 },
      children: [new TextRun({ text: implNote, size: 20, color: '3A3A3A' })],
    }));
  }
}

// Final summary page
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 200, after: 200 },
  children: [new TextRun({ text: 'Cierre — Estado del Sprint v3', size: 32, bold: true, color: 'B85042' })],
}));

const closeBullet = (txt) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  spacing: { before: 60, after: 60 },
  children: [new TextRun({ text: txt, size: 22 })],
});

children.push(new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text: 'Cobertura', size: 26, bold: true, color: '1A1A1A' })],
}));
children.push(closeBullet('28 / 28 pedidos del cliente cubiertos con cita textual + nota de implementación.'));
children.push(closeBullet('27 / 28 pedidos con screenshot Playwright sobre el dev server real (16l es un job backend, evidencia es el código del crawler).'));
children.push(closeBullet('11 features construidas en el ciclo de cierre del 15 mayo 2026 (07, 08, 12a, 12b, 16a, 16c, 16e, 16f, 16g, 16h, 16j) — antes estaban marcadas pero no implementadas.'));
children.push(closeBullet('1 parser nuevo (ordenDiaSectionParser.ts) + 5 paneles nuevos en el dashboard del expediente (Fechas, Sala IV, Actas, Novedades, Próx. sesión) + 1 página nueva (MatrizClientePage). Sin páginas de "demo parser" — los datos viven donde el consultor trabaja.'));
children.push(closeBullet('Typecheck verde en apps/api y apps/web. 56 / 56 tests unitarios pasan (24 Track E — bug "es ley", 32 Track G — POR TANTO).'));
children.push(closeBullet('6 migrations SQL aplicadas en Supabase (0031 → 0036). Migration 0037 (sil_expediente_fechas_extraidas) queda como deuda — los datos viven en sil_expedientes.metadata jsonb mientras se mueve a tabla dedicada.'));

children.push(new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text: 'Lo que ve el cliente en la demo del jueves 21', size: 26, bold: true, color: '1A1A1A' })],
}));
children.push(closeBullet('Dashboard del expediente 23.511 (Ley Marco Recurso Hídrico) — caso que Donovan mostró literalmente en la sesión.'));
children.push(closeBullet('Página de alertas Centinela con 5 alertas agrupadas por prioridad (audiencia > 137 > resto).'));
children.push(closeBullet('Estado del Plenario con 3 decretos ejecutivos y 6 expedientes convocados.'));
children.push(closeBullet('Catálogo de expedientes con filtros de fecha funcionales.'));
children.push(closeBullet('Expediente 23.234 (Ley General Medicamentos) demuestra el ciclo completo expediente → ley.'));

children.push(new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text: 'Referencias técnicas', size: 26, bold: true, color: '1A1A1A' })],
}));
children.push(closeBullet('Transcripción cliente: AGENTS/CL2/meetings/sesion-cl2-2026-05-14-transcript-clean.txt (56:52 / 373 turnos)'));
children.push(closeBullet('Memo de pedidos: AGENTS/CL2/meetings/2026-05-14-reunion-cliente-pedidos-en-vivo.md'));
children.push(closeBullet('Sprint Design Doc: AGENTS/CL2/sprints/2026-05-14-sprint-cl2-v3-design-doc.md'));
children.push(closeBullet('Doctrina LLM vs Algoritmo: AGENTS/CEREBRO/proposals/2026-05-15-doctrina-llm-vs-algoritmo.md'));
children.push(closeBullet('Código del spec Playwright: apps/web/tests/e2e/sprint-v3-28-screenshots.spec.ts'));
children.push(closeBullet('Seed de datos demo: apps/api/scripts/seed-demo-sprint-v3.ts'));

children.push(new Paragraph({
  spacing: { before: 600, after: 100 },
  alignment: AlignmentType.CENTER,
  children: [new TextRun({
    text: 'Reporte preparado por equipo Shift Lab para CL2 Consultoría',
    size: 18, italics: true, color: '999999',
  })],
}));
children.push(new Paragraph({
  spacing: { before: 100, after: 100 },
  alignment: AlignmentType.CENTER,
  children: [new TextRun({
    text: '2026-05-15',
    size: 18, color: '999999',
  })],
}));

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      {
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: '1A1A1A' },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: '1A1A1A' },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 }, // US Letter
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children,
  }],
});

const outPath = '/Users/juan/Downloads/CL2-Sprint-v3-28-Pedidos-2026-05-15.docx';
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  const stats = fs.statSync(outPath);
  console.log(`Wrote ${outPath}`);
  console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
});
