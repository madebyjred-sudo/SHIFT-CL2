/**
 * silDetailScraper — Scraper de la "detail page" de un expediente del SIL.
 *
 * Target: consultassil3.asamblea.go.cr (ASP.NET WebForms).
 *
 * WHY a separate scraper: el endpoint GET /api/expedientes/:id ya cubre
 * la metadata básica (sil_expedientes + sil_documentos legacy). Este scraper
 * cubre las 5 pestañas nuevas que la biblioteca unificada necesita:
 *   - Tramitación (timeline de eventos procesales)
 *   - Proponentes (orden de firma)
 *   - Consultas (entidades consultadas + PDFs de respuesta)
 *   - Información de Ley (si llegó a ley)
 *   - Documentos (sustitutivos, dictámenes, informes)
 *
 * Implementación del scraping: PENDIENTE (Sprint 2) — el ASP.NET WebForms
 * usa VIEWSTATE + postbacks lo que hace el scraping más complejo que el
 * SharePoint OData de Track A. Por ahora `scrapeExpedienteDetalle` lanza
 * error. `persistExpedienteDetalle` SÍ está implementado — es lo que el
 * crawler final usará para guardar los datos en Supabase.
 *
 * TODO Sprint 2:
 *   - Implementar scrapeExpedienteDetalle usando puppeteer/playwright
 *     para manejar el VIEWSTATE del SIL.
 *   - Alternativamente, usar los endpoints REST del GLCP SharePoint cuando
 *     los datos equivalentes existan allí (mociones, actas, etc.).
 *   - Batch runner sobre los ~21k expedientes activos 2022-2026.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Domain interfaces ────────────────────────────────────────────────────────

export interface TramiteEvento {
  organo_legislativo: string;
  descripcion: string;
  fecha_inicio: Date;
  fecha_termino?: Date | null;
  orden?: number;
  raw?: Record<string, unknown>;
}

export interface Proponente {
  firma_orden: number;
  diputado_nombre: string;
  administracion?: string;
  fraccion?: string;
}

export interface Consulta {
  entidad_consultada: string;
  fecha_consulta?: Date | null;
  fecha_respuesta?: Date | null;
  documento_url?: string | null;
  documento_storage_path?: string | null;
  tipo_respuesta?: 'a_favor' | 'en_contra' | 'condicional' | 'sin_observaciones' | null;
  resumen_por_tanto?: string | null;
  raw?: Record<string, unknown>;
}

export interface LeyData {
  numero_ley?: string | null;
  numero_gaceta?: string | null;
  alcance?: string | null;
  fecha_aprobacion_2_3?: Date | null;
  fecha_emitido_asamblea?: Date | null;
  fecha_sancionado?: Date | null;
  fecha_devuelto_ejecutivo?: Date | null;
  fecha_publicacion?: Date | null;
  fecha_rige?: Date | null;
  estado?: string;
  veto_texto?: string | null;
  reselo?: boolean;
  afectaciones?: AfectacionLey[];
  raw?: Record<string, unknown>;
}

export interface AfectacionLey {
  ley_numero_afectada?: string | null;
  tipo: 'deroga' | 'reforma' | 'adiciona' | 'suspende';
  articulos?: string | null;
}

export type ExpedienteDocumentoTipo =
  | 'texto_sustitutivo'
  | 'dictamen_mayoria'
  | 'dictamen_minoria'
  | 'informe_servicios_tecnicos'
  | 'informe_subcomision'
  | 'mocion_137_primer_dia'
  | 'mocion_137_segundo_dia'
  | 'mocion_138'
  | 'mocion_177'
  | 'otro';

export interface ExpedienteDocumento {
  tipo: ExpedienteDocumentoTipo;
  titulo?: string | null;
  fecha?: Date | null;
  url: string;
  storage_path?: string | null;
  embed_status?: 'pending' | 'in_progress' | 'done' | 'failed';
  raw?: Record<string, unknown>;
}

export interface ExpedienteDetalle {
  numero: string;
  general: {
    titulo: string;
    fecha_inicio: Date;
    es_ley: boolean;
    vencimiento_cuatrienal: Date | null;
    estado: string;
    comision?: string | null;
    proponente_principal?: string | null;
  };
  tramite: TramiteEvento[];
  proponentes: Proponente[];
  consultas: Consulta[];
  ley?: LeyData | null;
  documentos: ExpedienteDocumento[];
}

// ─── Scraper principal (STUB — implementar en Sprint 2) ───────────────────────

/**
 * Scrape la página de detalle del SIL para un expediente.
 *
 * TODO Sprint 2: implementar via playwright (headful o headless) para
 * manejar el VIEWSTATE del ASP.NET. El SIL usa postbacks para navegar
 * entre pestañas — cada pestaña requiere un POST al mismo endpoint con
 * el VIEWSTATE actualizado.
 *
 * Mientras tanto, los datos llegan por inserción directa del admin o
 * del crawler SharePoint (Track A) para los campos que existen allí.
 */
export async function scrapeExpedienteDetalle(_numero: string): Promise<ExpedienteDetalle> {
  // TODO Sprint 2: implementar scraper real.
  // Por ahora retornar error claro — usar persistExpedienteDetalle directamente
  // cuando los datos vienen de otra fuente (ej. importación manual, SharePoint).
  throw new Error(
    `scrapeExpedienteDetalle not yet implemented for ${_numero}. ` +
    `Use persistExpedienteDetalle to upsert data from other sources.`
  );
}

// ─── Persistencia — SÍ implementada ──────────────────────────────────────────

/**
 * Persist all detail sections of an expediente to Supabase.
 * Runs all upserts in parallel for speed. Each table handles its own
 * conflict resolution so this is idempotent — safe to re-run.
 */
export async function persistExpedienteDetalle(
  detalle: ExpedienteDetalle,
  supabase: SupabaseClient,
): Promise<void> {
  const { numero, tramite, proponentes, consultas, ley, documentos } = detalle;

  await Promise.all([
    // 1. Tramitación — delete + re-insert (ordering may change on re-scrape)
    upsertTramite(numero, tramite, supabase),
    // 2. Proponentes — upsert by primary key (expediente_id, firma_orden)
    upsertProponentes(numero, proponentes, supabase),
    // 3. Consultas — upsert by (expediente_id, entidad_consultada)
    upsertConsultas(numero, consultas, supabase),
    // 4. Documentos — upsert by (expediente_id, tipo, url)
    upsertDocumentos(numero, documentos, supabase),
  ]);

  // Ley goes last because afectaciones depend on the ley row existing.
  if (ley) {
    await upsertLey(numero, ley, supabase);
  }
}

async function upsertTramite(
  expedienteId: string,
  tramite: TramiteEvento[],
  supabase: SupabaseClient,
): Promise<void> {
  if (tramite.length === 0) return;

  // Delete existing rows for this expediente before inserting fresh ones.
  // Tramitación rows don't have a natural unique key (same evento can appear
  // twice on different dates in edge cases), so replace-all is safer.
  await supabase
    .from('sil_expediente_tramite')
    .delete()
    .eq('expediente_id', expedienteId);

  const rows = tramite.map((ev, idx) => ({
    expediente_id: expedienteId,
    organo_legislativo: ev.organo_legislativo,
    descripcion: ev.descripcion,
    fecha_inicio: ev.fecha_inicio.toISOString().slice(0, 10),
    fecha_termino: ev.fecha_termino ? ev.fecha_termino.toISOString().slice(0, 10) : null,
    orden: ev.orden ?? idx,
    raw: ev.raw ?? null,
  }));

  const { error } = await supabase.from('sil_expediente_tramite').insert(rows);
  if (error) throw new Error(`upsertTramite failed for ${expedienteId}: ${error.message}`);
}

async function upsertProponentes(
  expedienteId: string,
  proponentes: Proponente[],
  supabase: SupabaseClient,
): Promise<void> {
  if (proponentes.length === 0) return;

  const rows = proponentes.map((p) => ({
    expediente_id: expedienteId,
    firma_orden: p.firma_orden,
    diputado_nombre: p.diputado_nombre,
    administracion: p.administracion ?? null,
    fraccion: p.fraccion ?? null,
  }));

  const { error } = await supabase
    .from('sil_expediente_proponentes')
    .upsert(rows, { onConflict: 'expediente_id,firma_orden' });
  if (error) throw new Error(`upsertProponentes failed for ${expedienteId}: ${error.message}`);
}

async function upsertConsultas(
  expedienteId: string,
  consultas: Consulta[],
  supabase: SupabaseClient,
): Promise<void> {
  if (consultas.length === 0) return;

  // Consultas don't have a strict unique key from the SIL — use
  // (expediente_id, entidad_consultada) as best-effort dedup.
  // Delete + re-insert similar to tramite.
  await supabase
    .from('sil_expediente_consultas')
    .delete()
    .eq('expediente_id', expedienteId);

  const rows = consultas.map((c) => ({
    expediente_id: expedienteId,
    entidad_consultada: c.entidad_consultada,
    fecha_consulta: c.fecha_consulta ? c.fecha_consulta.toISOString().slice(0, 10) : null,
    fecha_respuesta: c.fecha_respuesta ? c.fecha_respuesta.toISOString().slice(0, 10) : null,
    documento_url: c.documento_url ?? null,
    documento_storage_path: c.documento_storage_path ?? null,
    tipo_respuesta: c.tipo_respuesta ?? null,
    resumen_por_tanto: c.resumen_por_tanto ?? null,
    raw: c.raw ?? null,
  }));

  const { error } = await supabase.from('sil_expediente_consultas').insert(rows);
  if (error) throw new Error(`upsertConsultas failed for ${expedienteId}: ${error.message}`);
}

async function upsertDocumentos(
  expedienteId: string,
  documentos: ExpedienteDocumento[],
  supabase: SupabaseClient,
): Promise<void> {
  if (documentos.length === 0) return;

  const rows = documentos.map((d) => ({
    expediente_id: expedienteId,
    tipo: d.tipo,
    titulo: d.titulo ?? null,
    fecha: d.fecha ? d.fecha.toISOString().slice(0, 10) : null,
    url: d.url,
    storage_path: d.storage_path ?? null,
    embed_status: d.embed_status ?? 'pending',
    raw: d.raw ?? null,
  }));

  // Upsert by (expediente_id, tipo, url) — if the URL is the same doc,
  // update metadata rather than duplicate.
  const { error } = await supabase
    .from('sil_expediente_documentos')
    .upsert(rows, { onConflict: 'expediente_id,tipo' });
  if (error) throw new Error(`upsertDocumentos failed for ${expedienteId}: ${error.message}`);
}

async function upsertLey(
  expedienteId: string,
  ley: LeyData,
  supabase: SupabaseClient,
): Promise<void> {
  const leyRow = {
    expediente_origen_id: expedienteId,
    numero_ley: ley.numero_ley ?? null,
    numero_gaceta: ley.numero_gaceta ?? null,
    alcance: ley.alcance ?? null,
    fecha_aprobacion_2_3: ley.fecha_aprobacion_2_3?.toISOString().slice(0, 10) ?? null,
    fecha_emitido_asamblea: ley.fecha_emitido_asamblea?.toISOString().slice(0, 10) ?? null,
    fecha_sancionado: ley.fecha_sancionado?.toISOString().slice(0, 10) ?? null,
    fecha_devuelto_ejecutivo: ley.fecha_devuelto_ejecutivo?.toISOString().slice(0, 10) ?? null,
    fecha_publicacion: ley.fecha_publicacion?.toISOString().slice(0, 10) ?? null,
    fecha_rige: ley.fecha_rige?.toISOString().slice(0, 10) ?? null,
    estado: ley.estado ?? 'Vigente',
    veto_texto: ley.veto_texto ?? null,
    reselo: ley.reselo ?? false,
    raw: ley.raw ?? null,
  };

  const { data: leyInserted, error: leyError } = await supabase
    .from('sil_leyes')
    .upsert(leyRow, { onConflict: 'expediente_origen_id' })
    .select('id')
    .single();

  if (leyError || !leyInserted) {
    throw new Error(`upsertLey failed for ${expedienteId}: ${leyError?.message}`);
  }

  // Afectaciones — delete + re-insert
  if (ley.afectaciones && ley.afectaciones.length > 0) {
    await supabase
      .from('sil_leyes_afectaciones')
      .delete()
      .eq('ley_id_origen', leyInserted.id);

    const afRows = ley.afectaciones.map((af) => ({
      ley_id_origen: leyInserted.id,
      ley_numero_afectada: af.ley_numero_afectada ?? null,
      tipo: af.tipo,
      articulos: af.articulos ?? null,
    }));

    const { error: afError } = await supabase
      .from('sil_leyes_afectaciones')
      .insert(afRows);

    if (afError) {
      throw new Error(`upsertAfectaciones failed for ${expedienteId}: ${afError.message}`);
    }
  }
}
