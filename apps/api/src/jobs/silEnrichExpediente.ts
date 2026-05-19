/**
 * silEnrichExpediente — para un expediente dado, llama al SIL WebForms
 * para extraer datos enriquecidos (proponentes con orden de firma, comisiones,
 * fechas oficiales, gaceta, alcance, número de ley, etc.) y persiste a las
 * tablas dedicadas.
 *
 * Por qué este job existe:
 *   El crawler de discovery (`silDiscovery.ts`) inserta el metadata mínimo
 *   de cada expediente nuevo (numero, titulo, fecha_presentacion, estado).
 *   PERO las pantallas de detalle del producto leen de tablas dedicadas
 *   (`sil_expediente_proponentes`, etc.) que están vacías para casi todos
 *   los expedientes. Resultado: el usuario abre cualquier expediente que no
 *   sea el demo 23.511 y ve todo en blanco ("Sin proponentes registrados").
 *
 * Este enricher resuelve el gap:
 *   1. Llama `searchByNumber` + `selectExpedienteDetail` para traer el HTML
 *      enriched del expediente.
 *   2. Actualiza `sil_expedientes` con los campos descubiertos (estado,
 *      comision, proponente principal, fecha_presentacion, etc.).
 *   3. Reemplaza `sil_expediente_proponentes` con la lista de firmantes
 *      en orden — sin esto, el tab "Proponentes" queda vacío.
 *
 * Documentos y consultas requieren postbacks adicionales sobre el detalle —
 * eso queda para una segunda iteración del enricher.
 *
 * Idempotencia:
 *   - sil_expedientes upsert por `numero` (conflict key)
 *   - sil_expediente_proponentes: DELETE + INSERT (full replace) — el orden
 *     de firma puede cambiar si se rectifica, así que la única forma segura
 *     es reemplazar el set completo.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  parseDocumentsFromDetail,
  parseTramiteFromDetail,
  parseAudienciasFromDetail,
  type WebFormsSession,
  type ExpedienteEnriched,
  type ProponenteFirmante,
} from '../services/silWebFormsClient.js';
import { findAdministracionByDate } from '../services/costaRicaAdministraciones.js';
import { findDiputado } from '../services/diputadosLookup.js';
import { parseOrdenDia } from '../services/ordenDiaSectionParser.js';
import { logger } from '../services/logger.js';

export interface EnrichResult {
  numero: string;
  status: 'enriched' | 'not_found' | 'failed' | 'no_proponentes';
  proponentes_count: number;
  comisiones_count: number;
  documentos_count: number;
  audiencias_count: number;
  tramite_count: number;
  orden_dia_apariciones_count: number;
  fechas_vigentes_count: number;
  actas_indexadas_count: number;
  error?: string;
}

/**
 * Heurística para mapear "BARRANTES VARGAS DAYANA" → fracción y administración.
 * Por ahora dejamos null — el SIL no entrega fracción/administración en este
 * postback. Si el cliente lo pide, agregamos un cruce con la tabla de
 * diputados (que sí tiene esa info).
 */
/**
 * Persiste el set de firmantes del expediente.
 *
 * Acepta `ProponenteFirmante[]` (apellidos + nombre + administracion +
 * fraccion). Para iniciativas del Poder Ejecutivo el SIL solo serializa
 * "PODER" en apellidos — sin admin, sin fecha. Si pasamos
 * `fechaPresentacion`, derivamos la administración correspondiente del
 * mapping local de presidentes CR (`costaRicaAdministraciones.ts`).
 *
 * Antes del fix 2026-05-18 esta función recibía solo `string[]` y dejaba
 * administracion y fraccion siempre null — bug confirmado en prod sobre
 * 322 expedientes con rows pero 0 con admin/fraccion populados.
 */
async function persistProponentes(
  s: SupabaseClient,
  expedienteId: string,
  proponentesFull: ProponenteFirmante[],
  fechaPresentacion: string | null,
): Promise<{ count: number }> {
  // Borrar set existente para idempotencia
  await s.from('sil_expediente_proponentes').delete().eq('expediente_id', expedienteId);
  if (proponentesFull.length === 0) return { count: 0 };

  // Mapping local de presidentes CR — para los casos Poder Ejecutivo donde
  // el SIL solo dice "PODER".
  const adminMatch = fechaPresentacion ? findAdministracionByDate(fechaPresentacion) : null;
  logger.info('persist_proponentes_start', {
    expedienteId,
    fechaPresentacion,
    proponentesFullCount: proponentesFull.length,
    adminMatchApellidos: adminMatch?.apellidos ?? null,
    firstProponenteApellidos: proponentesFull[0]?.apellidos ?? null,
  });

  // Resolver cada firmante en paralelo contra el catálogo `diputados`
  // (cache in-memory en diputadosLookup, sin pegadas extra al DB después
  // del primer load).
  const rows = await Promise.all(proponentesFull.map(async (p, idx) => {
    const isPoderEjecutivo = /^PODER( EJECUTIVO)?$/i.test(p.apellidos.trim());

    // Para iniciativas parlamentarias intentamos enriquecer con el
    // catálogo `diputados` (apellidos + fecha_presentacion → nombre +
    // fracción + provincia). Si el SIL ya nos dio nombre/fraccion no
    // sobreescribimos.
    let nombreResolved: string | null = p.nombre;
    let fraccionResolved: string | null = p.fraccion;

    if (!isPoderEjecutivo) {
      const dip = await findDiputado(s, p.apellidos, fechaPresentacion);
      if (dip) {
        if (!nombreResolved) nombreResolved = dip.nombre;
        if (!fraccionResolved) fraccionResolved = dip.fraccion;
      }
    }

    // Para Poder Ejecutivo, llenamos admin + partido del presidente.
    const administracion = p.administracion ?? (isPoderEjecutivo && adminMatch ? adminMatch.apellidos : null);
    const fraccionFinal = fraccionResolved ?? (isPoderEjecutivo && adminMatch ? adminMatch.partido : null);

    // diputado_nombre = "Apellidos Nombre" cuando ambos existen.
    // Para PODER, queda "PODER" suelto.
    const diputadoNombre = nombreResolved
      ? `${p.apellidos} ${nombreResolved}`.trim()
      : p.apellidos;

    return {
      expediente_id: expedienteId,
      firma_orden: idx + 1,
      diputado_nombre: diputadoNombre,
      administracion,
      fraccion: fraccionFinal,
    };
  }));

  const { error } = await s.from('sil_expediente_proponentes').insert(rows);
  if (error) throw new Error(`insert proponentes ${expedienteId}: ${error.message}`);
  return { count: rows.length };
}

async function persistComisiones(
  s: SupabaseClient,
  expedienteId: string,
  comisiones: Array<{ organo: string; fecha: string | null }>,
): Promise<void> {
  // Por ahora solo guardamos la PRIMERA comisión como "comision actual" en
  // sil_expedientes. La historia completa requiere una tabla de tramitación
  // que el schema actual no tiene poblada con esta info.
  if (comisiones.length === 0) return;
  const actual = comisiones[comisiones.length - 1].organo; // la última = la actual
  await s.from('sil_expedientes').update({ comision: actual }).eq('numero', expedienteId);
}

/**
 * Reemplaza el set de documentos del expediente con la lista descubierta
 * en el detail panel. Solo metadata (titulo/fecha/tipo) — la descarga del
 * PDF queda para el bulk downloader que ya existe.
 */
async function persistDocumentos(
  s: SupabaseClient,
  expedienteId: string,
  expedienteNum: number,
  docs: Array<{ tipo: string; titulo: string | null; fecha: string | null; grid: string; index: number }>,
): Promise<number> {
  await s.from('sil_expediente_documentos').delete().eq('expediente_id', expedienteId);
  if (docs.length === 0) return 0;
  const rows = docs.map((d) => ({
    expediente_id: expedienteId,
    tipo: d.tipo,
    titulo: d.titulo,
    fecha: d.fecha,
    // URL del detail del SIL — el frontend redirige acá para descargar.
    url: `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${expedienteNum}`,
    storage_path: null,
    embed_status: 'pending',
    raw: { source: 'sil_webforms_enrich', grid: d.grid, index: d.index },
  }));
  const { error } = await s.from('sil_expediente_documentos').insert(rows);
  if (error) throw new Error(`insert docs ${expedienteId}: ${error.message}`);
  return rows.length;
}

/**
 * Sincroniza audiencias programadas hacia `sil_expediente_audiencias`. La
 * fuente primaria es el grid `grvConvocatoria` del detail HTML del SIL — trae
 * el asistente real (nombre + cargo + entidad), columnas que el
 * `agenda_legislativa` no captura.
 *
 * Idempotente: full-replace por expediente_id. Se justifica porque el SIL
 * no expone un id estable para deduplicar entre corridas (idAudiencia sí pero
 * lo guardamos solo en logs).
 *
 * Limitación: el grid del SIL pagina a 10 filas; expedientes con más
 * audiencias (ej. 23.511 tiene 30+) capturan solo las primeras 10. El
 * frontend muestra disclaimer "ver más en el SIL oficial".
 */
async function persistAudienciasDesdeSil(
  s: SupabaseClient,
  expedienteId: string,
  html: string,
): Promise<number> {
  const audiencias = parseAudienciasFromDetail(html);
  await s.from('sil_expediente_audiencias').delete().eq('expediente_id', expedienteId);
  if (audiencias.length === 0) return 0;
  const rows = audiencias.map((a) => ({
    expediente_id: expedienteId,
    fecha: a.fecha,
    hora: null, // SIL no expone hora en grvConvocatoria
    comision: a.comision,
    asistente_nombre: a.asistenteNombre,
    asistente_cargo: a.asistenteCargo,
    asistente_organizacion: a.asistenteOrganizacion,
    posicion_estimada: null,
    fuente_orden_dia_url: null,
    detectada_at: new Date().toISOString(),
  }));
  const { error: insErr } = await s.from('sil_expediente_audiencias').insert(rows);
  if (insErr) {
    logger.warn('audiencias_insert_failed', { expedienteId, error: insErr.message });
    return 0;
  }
  return rows.length;
}

/**
 * Sincroniza el timeline de tramitación desde el grid `grvTramite` del SIL.
 * Cada fila del grid es un evento procesal (PRESENTACIÓN, RECEPCIÓN, VOTACIÓN,
 * etc). Alimenta `sil_expediente_tramite`.
 *
 * Idempotente: DELETE + INSERT por expediente_id. El orden viene del SIL
 * cronológicamente — usamos el índice de iteración como `orden`.
 */
async function persistTramite(
  s: SupabaseClient,
  expedienteId: string,
  html: string,
): Promise<number> {
  const eventos = parseTramiteFromDetail(html);
  await s.from('sil_expediente_tramite').delete().eq('expediente_id', expedienteId);
  if (eventos.length === 0) return 0;
  const rows = eventos.map((e, idx) => ({
    expediente_id: expedienteId,
    organo_legislativo: e.organo,
    descripcion: e.descripcion,
    fecha_inicio: e.fechaInicio,
    fecha_termino: e.fechaTermino,
    orden: idx + 1,
    raw: { source: 'sil_webforms_enrich', grid: 'grvTramite' },
  }));
  const { error } = await s.from('sil_expediente_tramite').insert(rows);
  if (error) {
    logger.warn('tramite_insert_failed', { expedienteId, error: error.message });
    return 0;
  }
  return rows.length;
}

/**
 * Sincroniza las apariciones del expediente en órdenes del día del Plenario
 * usando `agenda_legislativa` como fuente. Para cada agenda row del
 * expediente, infiere capítulo + debate desde el título del documento
 * (cuando viene seccionado por el agendaScraper) o aplica heurística:
 *   - Sesión PLENARIO + título contiene un expediente → capítulo tercero,
 *     debate desconocido (frontend muestra "en orden del día sin clasificar").
 *   - Si el snippet del título contiene "SEGUNDO DEBATE" → segundo_debate. Etc.
 *
 * UNIQUE (expediente_id, fecha_sesion, capitulo, debate) — usamos UPSERT.
 */
async function persistOrdenDiaApariciones(
  s: SupabaseClient,
  expedienteId: string,
): Promise<number> {
  const { data: agendaRows, error } = await s
    .from('agenda_legislativa')
    .select('fecha, comision, hora_inicio, titulo, scraped_at')
    .eq('expediente_numero', expedienteId);
  if (error || !agendaRows || agendaRows.length === 0) return 0;

  // Build proposed rows from agenda evidence. Each agenda hit becomes one
  // aparicion. Title parsing extracts debate hint.
  const proposed: Array<{
    expediente_id: string;
    fecha_sesion: string;
    hora: string | null;
    numero_sesion: number | null;
    tipo_sesion: string;
    capitulo: string;
    capitulo_titulo: string | null;
    debate: string;
    orden_pdf_url: string | null;
    contexto_extracto: string | null;
    detectada_at: string;
  }> = [];
  for (const r of agendaRows) {
    if (!r.fecha) continue;
    const titulo = r.titulo ?? '';
    // Extract session number from titles like "2025-2026-PLENARIO-SESION-134 :: ..."
    const sesMatch = titulo.match(/SESI[ÓO]N[- ](\d+)/i);
    const numero_sesion = sesMatch ? parseInt(sesMatch[1], 10) : null;
    // Reuse the orden_dia parser: feed it the título as if it were a small
    // snippet; it'll detect debate markers + capítulo.
    const parsed = parseOrdenDia(titulo);
    let capitulo = 'sin_clasificar';
    let debate = 'sin_clasificar';
    let capitulo_titulo: string | null = null;
    for (const e of parsed.entries) {
      if (e.expediente_numero === expedienteId) {
        if (e.capitulo !== 'sin_clasificar') capitulo = e.capitulo;
        if (e.debate !== 'sin_clasificar') debate = e.debate;
        capitulo_titulo = e.capitulo_titulo || null;
        break;
      }
    }
    // Heuristic fallback: if the agenda titulo references a PLENARIO session
    // and the expediente shows up at all, treat it as capitulo_tercero (where
    // proyectos de ley se discuten) — better than "sin_clasificar" para el
    // 90% de los casos.
    if (capitulo === 'sin_clasificar' && /PLENARIO/i.test(titulo)) {
      capitulo = 'capitulo_tercero';
      capitulo_titulo = 'CAPÍTULO TERCERO (inferido)';
    }
    proposed.push({
      expediente_id: expedienteId,
      fecha_sesion: r.fecha,
      hora: r.hora_inicio ?? null,
      numero_sesion,
      tipo_sesion: 'ordinaria',
      capitulo,
      capitulo_titulo,
      debate,
      orden_pdf_url: null,
      contexto_extracto: titulo.length > 500 ? titulo.slice(0, 500) : titulo,
      detectada_at: new Date().toISOString(),
    });
  }
  if (proposed.length === 0) return 0;

  // Dedup en memoria por (fecha, capitulo, debate) antes de upsert.
  const seen = new Set<string>();
  const dedup = proposed.filter((p) => {
    const key = `${p.fecha_sesion}|${p.capitulo}|${p.debate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { error: upErr, count } = await s
    .from('sil_expediente_orden_dia_apariciones')
    .upsert(dedup, {
      onConflict: 'expediente_id,fecha_sesion,capitulo,debate',
      count: 'exact',
    });
  if (upErr) {
    logger.warn('orden_dia_apariciones_upsert_failed', { expedienteId, error: upErr.message });
    return 0;
  }
  return count ?? dedup.length;
}

/**
 * Inserta fechas vigentes (vencimientos cuatrienal/ordinario) en
 * `sil_expediente_fechas_extraidas`. La VIEW `sil_expediente_fechas_vigentes`
 * proyecta automáticamente la fila más reciente por (expediente, campo).
 *
 * Estrategia idempotente: hacemos upsert con extraction_method='regex' y un
 * extracted_at fijo basado en `valor_fecha` para evitar duplicados de la
 * misma extracción en runs sucesivos. NO usamos el superseded_by chain
 * porque el SIL no nos da historial — solo el valor actual.
 *
 * Borramos las rows previas que vinieron de este source antes de insertar
 * (full replace) — el chain de superseded_by lo manejaría el detector de
 * cambios, no el enricher inicial.
 */
async function persistFechasVigentes(
  s: SupabaseClient,
  expedienteId: string,
  enriched: ExpedienteEnriched,
): Promise<number> {
  const fechas: Array<{
    expediente_id: string;
    campo: string;
    valor_fecha: string;
    valor_texto_original: string | null;
    fuente_documento_url: string | null;
    fuente_pagina: number | null;
    extraction_method: string;
    extraction_confidence: number;
    visual_marker: string | null;
    extracted_at: string;
  }> = [];

  // Mapeo de fechas del enriched al schema canónico de campos.
  if (enriched.vencimientoCuatrienal) {
    fechas.push({
      expediente_id: expedienteId,
      campo: 'fecha_cuatrienal',
      valor_fecha: enriched.vencimientoCuatrienal,
      valor_texto_original: `Vencimiento Cuatrienal: ${enriched.vencimientoCuatrienal}`,
      fuente_documento_url: `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${expedienteId.replace('.', '')}`,
      fuente_pagina: null,
      extraction_method: 'regex',
      extraction_confidence: 0.98, // viene del SIL oficial — confianza alta
      visual_marker: 'plain',
      extracted_at: new Date().toISOString(),
    });
  }
  // El SIL expone "Vencimiento Ordinario" como deadline procesal de 60 días
  // para dictamen — coincide con el concepto de `vence_subcomision` del
  // schema. Si en el futuro queremos distinguirlos agregamos un campo nuevo
  // al enum del check constraint.
  if (enriched.vencimientoOrdinario) {
    fechas.push({
      expediente_id: expedienteId,
      campo: 'vence_subcomision',
      valor_fecha: enriched.vencimientoOrdinario,
      valor_texto_original: `Vencimiento Ordinario: ${enriched.vencimientoOrdinario}`,
      fuente_documento_url: `https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=${expedienteId.replace('.', '')}`,
      fuente_pagina: null,
      extraction_method: 'regex',
      extraction_confidence: 0.98,
      visual_marker: 'plain',
      extracted_at: new Date().toISOString(),
    });
  }

  if (fechas.length === 0) return 0;

  // Idempotencia: borrar las rows previas del expediente que vinieron de SIL
  // (extraction_method='regex' AND campo IN nuestros campos), luego insert.
  // Esto evita acumular cientos de filas duplicadas si re-corremos el job.
  await s
    .from('sil_expediente_fechas_extraidas')
    .delete()
    .eq('expediente_id', expedienteId)
    .in('campo', ['fecha_cuatrienal', 'vence_subcomision'])
    .eq('extraction_method', 'regex');
  const { error } = await s.from('sil_expediente_fechas_extraidas').insert(fechas);
  if (error) {
    logger.warn('fechas_vigentes_insert_failed', { expedienteId, error: error.message });
    return 0;
  }
  return fechas.length;
}

/**
 * Indexa actas de SharePoint que probablemente correspondan al expediente.
 * Estrategia: matchear actas de las comisiones donde el expediente estuvo
 * lodged (de `metadata.comisiones_historia` o `comision` actual), filtrando
 * por ventana temporal del expediente.
 *
 * Limitación importante: SIN parsear el PDF del acta NO sabemos si el
 * expediente fue discutido en esa sesión. Solo afirmamos "esta acta
 * PERTENECE a una comisión que tiene este expediente en su lista". El
 * frontend debe mostrar disclaimer "puede que esta sesión NO haya tocado
 * el expediente". El `speakers` JSONB queda [] hasta que un job aparte
 * extraiga voces del PDF.
 *
 * UNIQUE (expediente_id, acta_numero, comision) — usamos UPSERT.
 *
 * Por ahora limitamos a 5 actas más recientes por comisión para no inundar
 * la tabla con 600+ filas de signal bajo.
 */
async function persistActasIndexadas(
  s: SupabaseClient,
  expedienteId: string,
  enriched: ExpedienteEnriched,
): Promise<number> {
  // Build set of comisiones del expediente (excluyendo PLENARIO + ARCHIVO
  // donde no hay actas de discusión técnica del expediente).
  const comisionesSet = new Set<string>();
  for (const c of enriched.comisiones) {
    const norm = c.organo.trim();
    if (norm && !/^(PLENARIO|ARCHIVO|PARLAMENTARIOS)$/i.test(norm)) {
      comisionesSet.add(norm);
    }
  }
  if (comisionesSet.size === 0) return 0;

  // Para cada comisión, buscar actas en sharepoint_raw. Los filenames siguen
  // el patrón "YYYY-YYYY-COMISION-SESIÓN-N.pdf" — usamos el nombre normalizado
  // de la comisión sin el "(ÁREA IV)" suffix porque SharePoint no incluye eso.
  const actasInserted: Array<any> = [];
  for (const comi of comisionesSet) {
    // Normalizar: "AMBIENTE (ÁREA IV)" → "AMBIENTE"
    const baseName = comi.replace(/\s*\([^)]+\)\s*/g, '').trim();
    // SharePoint usa el nombre sin tildes en algunos casos — buscar variantes.
    const searchPatterns = [baseName.toUpperCase(), baseName.toLowerCase()];
    for (const pattern of searchPatterns) {
      const { data } = await s
        .from('sil_sharepoint_raw')
        .select('payload, item_id')
        .eq('list_title', 'Actas')
        .ilike('payload->>FileLeafRef', `%${pattern}%`)
        .order('item_id', { ascending: false })
        .limit(5);
      for (const row of data ?? []) {
        const p: any = row.payload ?? {};
        const fileRef = p.FileLeafRef ?? p.Title;
        if (!fileRef) continue;
        // Extract sesión number: "...SESIÓN-12.pdf" or "...SESION-12"
        const m = String(fileRef).match(/SESI[ÓO]N[- ](\d+)/i);
        if (!m) continue;
        const sessNum = parseInt(m[1], 10);
        // Date: prefer Modified else Created (SharePoint metadata)
        const dateRaw = p.Modified || p.Created;
        const fechaSesion = dateRaw ? String(dateRaw).slice(0, 10) : null;
        if (!fechaSesion) continue;
        // URL al PDF: si tenemos FileRef absoluto, úselo; sino construirlo.
        const pdfUrl: string = p.EncodedAbsUrl
          ?? (p.FileRef ? `https://www.asamblea.go.cr${p.FileRef}` : null);
        if (!pdfUrl) continue;
        actasInserted.push({
          expediente_id: expedienteId,
          acta_numero: sessNum,
          comision: comi,
          fecha_sesion: fechaSesion,
          acta_pdf_url: pdfUrl,
          speakers: [],
          indexed_at: new Date().toISOString(),
        });
      }
    }
  }

  if (actasInserted.length === 0) return 0;

  // Dedup en memoria por (acta_numero, comision)
  const seen = new Set<string>();
  const dedup = actasInserted.filter((a) => {
    const key = `${a.acta_numero}|${a.comision}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { error: upErr, count } = await s
    .from('sil_expediente_actas_indexadas')
    .upsert(dedup, {
      onConflict: 'expediente_id,acta_numero,comision',
      count: 'exact',
    });
  if (upErr) {
    logger.warn('actas_indexadas_upsert_failed', { expedienteId, error: upErr.message });
    return 0;
  }
  return count ?? dedup.length;
}

function emptyResult(numero: string, status: EnrichResult['status'], error?: string): EnrichResult {
  return {
    numero,
    status,
    proponentes_count: 0,
    comisiones_count: 0,
    documentos_count: 0,
    audiencias_count: 0,
    tramite_count: 0,
    orden_dia_apariciones_count: 0,
    fechas_vigentes_count: 0,
    actas_indexadas_count: 0,
    ...(error ? { error } : {}),
  };
}

export async function enrichExpediente(
  s: SupabaseClient,
  numero: string,
  preexistingSession?: WebFormsSession,
): Promise<EnrichResult> {
  const numInt = parseInt(numero.replace('.', ''), 10);
  if (!Number.isFinite(numInt) || numInt <= 0) {
    return emptyResult(numero, 'failed', 'invalid numero');
  }
  try {
    // Sesión fresca o reusable
    let session: WebFormsSession = preexistingSession ?? (await createSession());
    const searched = await searchByNumber(session, numInt);
    session = searched.session;
    if (!searched.detail) {
      return emptyResult(numero, 'not_found');
    }
    // Click sobre la fila para expandir el detalle enriched
    const enrichedRes = await selectExpedienteDetail(session, numInt);
    const enriched: ExpedienteEnriched | null = enrichedRes.enriched;
    const enrichedHtml = enrichedRes.session.lastHtml;
    if (!enriched) {
      return emptyResult(numero, 'not_found');
    }

    // Update sil_expedientes con campos descubiertos.
    // `enriched` no trae estado/legislatura — esos viven en `searched.detail`
    // (el listado del grid SIL los entrega; el postback de detalle no).
    const updates: Record<string, unknown> = {
      scraped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (searched.detail.titulo) updates.titulo = searched.detail.titulo;
    if (enriched.fechaPresentacion) updates.fecha_presentacion = enriched.fechaPresentacion;
    if (enriched.proponentes.length > 0) updates.proponente = enriched.proponentes[0];
    if (searched.detail.estado) updates.estado = searched.detail.estado;
    if (enriched.tipo) updates.tipo = enriched.tipo;
    if (searched.detail.legislatura) updates.legislatura = searched.detail.legislatura;
    // Persistir metadata extra en jsonb para que el detail page pueda leerla
    const meta: Record<string, unknown> = {};
    if (enriched.fechaPublicacion) meta.fecha_publicacion = enriched.fechaPublicacion;
    if (enriched.numeroGaceta) meta.numero_gaceta = enriched.numeroGaceta;
    if (enriched.numeroAlcance) meta.numero_alcance = enriched.numeroAlcance;
    if (enriched.numeroLey) meta.numero_ley = enriched.numeroLey;
    if (enriched.numeroAcuerdo) meta.numero_acuerdo = enriched.numeroAcuerdo;
    if (enriched.vencimientoCuatrienal) meta.vencimiento_cuatrienal = enriched.vencimientoCuatrienal;
    if (enriched.vencimientoOrdinario) meta.vencimiento_ordinario = enriched.vencimientoOrdinario;
    if (enriched.comisiones.length > 0) meta.comisiones_historia = enriched.comisiones;
    if (Object.keys(meta).length > 0) updates.metadata = meta;

    const { error: upErr } = await s.from('sil_expedientes').update(updates).eq('numero', numero);
    if (upErr) throw new Error(`update sil_expedientes ${numero}: ${upErr.message}`);

    // Persistir proponentes (full replace) — usa la forma rica con
    // apellidos + nombre + administracion + fraccion cuando el SIL los
    // expone. Para iniciativas del Poder Ejecutivo, persistProponentes
    // hace lookup contra el mapping de presidentes CR usando
    // fechaPresentacion → fila queda como apellidos="PODER" +
    // administracion="<APELLIDOS DEL PRESIDENTE>" + fraccion="<partido>".
    //
    // Fallback: si el postback no expuso fecha_presentacion (algunos
    // expedientes recientes vienen sin esa label), usamos la fecha que
    // silDiscovery ya guardó en DB. Sin fecha el mapping no resuelve.
    let fechaParaProponentes: string | null = enriched.fechaPresentacion;
    if (!fechaParaProponentes) {
      const { data: existingRow } = await s
        .from('sil_expedientes')
        .select('fecha_presentacion')
        .eq('numero', numero)
        .maybeSingle();
      fechaParaProponentes = (existingRow?.fecha_presentacion as string | null) ?? null;
    }
    const propRes = await persistProponentes(
      s,
      numero,
      enriched.proponentesFull,
      fechaParaProponentes,
    );
    await persistComisiones(s, numero, enriched.comisiones);

    // Persistir documentos (parseando los grids del detail HTML)
    const docList = enrichedHtml ? parseDocumentsFromDetail(enrichedHtml, numInt) : [];
    const docsCount = await persistDocumentos(s, numero, numInt, docList);

    // ─── Las 6 tablas auxiliares ─────────────────────────────────────────
    // Audiencias desde grid grvConvocatoria del SIL (datos reales con
    // asistente + cargo + entidad, no solo fecha+comisión).
    const audCount = enrichedHtml ? await persistAudienciasDesdeSil(s, numero, enrichedHtml) : 0;

    // Tramite desde grid grvTramite del SIL (timeline procesal).
    const tramCount = enrichedHtml ? await persistTramite(s, numero, enrichedHtml) : 0;

    // Apariciones en orden del día desde agenda_legislativa (no SIL call).
    const ordCount = await persistOrdenDiaApariciones(s, numero);

    // Fechas vigentes desde enriched (vencimientos cuatrienal + ordinario).
    const fechCount = await persistFechasVigentes(s, numero, enriched);

    // Actas indexadas desde sharepoint_raw matched por comisiones (sin
    // speakers — eso requiere parsing del PDF aparte).
    const actCount = await persistActasIndexadas(s, numero, enriched);

    // Nota: `sil_expediente_convocatoria` NO se llena aquí — la alimenta
    // `decretoIngestor.ts` cuando llega un decreto ejecutivo nuevo del
    // SharePoint GLCP. Es un flujo independiente al SIL del expediente.

    return {
      numero,
      status: propRes.count === 0 ? 'no_proponentes' : 'enriched',
      proponentes_count: propRes.count,
      comisiones_count: enriched.comisiones.length,
      documentos_count: docsCount,
      audiencias_count: audCount,
      tramite_count: tramCount,
      orden_dia_apariciones_count: ordCount,
      fechas_vigentes_count: fechCount,
      actas_indexadas_count: actCount,
    };
  } catch (e) {
    const message = (e as Error).message;
    logger.warn('enrich_expediente_failed', { numero, error: message });
    return emptyResult(numero, 'failed', message);
  }
}

/**
 * Bulk enrich: para cada numero pasa por enrichExpediente con politeness
 * delay y reinicio de sesión si el SIL devuelve error.
 */
export async function enrichExpedientesBulk(
  s: SupabaseClient,
  numeros: string[],
  options: { politenessMs?: number; maxFailuresInARow?: number } = {},
): Promise<{ enriched: number; not_found: number; failed: number; no_proponentes: number }> {
  const delay = options.politenessMs ?? 800;
  const stopAfter = options.maxFailuresInARow ?? 8;
  const counters = { enriched: 0, not_found: 0, failed: 0, no_proponentes: 0 };
  let consecutiveFailed = 0;

  for (const numero of numeros) {
    const result = await enrichExpediente(s, numero);
    counters[result.status]++;
    if (result.status === 'failed') {
      consecutiveFailed++;
      if (consecutiveFailed >= stopAfter) {
        logger.error('enrich_bulk_aborted_after_consecutive_failures', { last_numero: numero, consecutive: consecutiveFailed });
        break;
      }
    } else {
      consecutiveFailed = 0;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  return counters;
}
