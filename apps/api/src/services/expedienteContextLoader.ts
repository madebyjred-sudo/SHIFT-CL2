/**
 * Expediente context loader — builds the system message that scopes a chat
 * conversation to a specific SIL expediente.
 *
 * Why: when the user opens chat from `/expediente/:numero`, every turn must
 * know which expediente it's about. Mirrors the sessionContextLoader pattern
 * but for SIL expedientes instead of plenarias.
 *
 * Data sources:
 *   - sil_expedientes (general metadata)
 *   - sil_expediente_tramite (top 10 most recent events)
 *   - sil_expediente_proponentes (ordered list)
 *   - sil_expediente_documentos (available docs by type)
 *   - sil_expediente_fechas_vigentes (key dates)
 *   - sil_leyes (if this became law)
 *   - sil_expediente_metadata (enrichment jsonb)
 *
 * Cache: same LRU pattern as sessionContextLoader — 10 min TTL, 50 entries max.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

export interface ExpedienteContext {
  numero: string;
  titulo: string;
  estado: string | null;
  comision: string | null;
  proponente_principal: string | null;
  fecha_presentacion: string | null;
  tipo: string | null;
  legislatura: string | null;
  url_detalle: string | null;
  /** Executive summary from metadata.resumen if available */
  resumen_ejecutivo: string | null;
  /** Top N tramite events (most recent first) */
  tramite_resumen: string | null;
  /** Proponentes in signature order */
  proponentes_resumen: string | null;
  /** Available documents grouped by type */
  documentos_resumen: string | null;
  /** Key dates (dictamen estimates, etc.) */
  fechas_resumen: string | null;
  /** Ley info if this became law */
  ley_resumen: string | null;
}

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('expedienteContextLoader: supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

const CACHE_MAX = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { ctx: ExpedienteContext; expiresAt: number }>();

interface GeneralRow {
  numero: string;
  titulo: string | null;
  estado: string | null;
  comision: string | null;
  proponente: string | null;
  fecha_presentacion: string | null;
  tipo: string | null;
  legislatura: string | null;
  url_detalle: string | null;
  metadata: Record<string, unknown> | null;
}

interface TramiteRow {
  fecha_inicio: string | null;
  organo_legislativo: string | null;
  descripcion: string | null;
}

interface ProponenteRow {
  diputado_nombre: string | null;
  firma_orden: number | null;
}

interface DocRow {
  tipo: string | null;
  titulo: string | null;
  fecha: string | null;
}

interface FechaRow {
  campo: string | null;
  valor_fecha: string | null;
  valor_texto_original: string | null;
  fuente_documento_url: string | null;
}

interface LeyRow {
  numero_ley: string | null;
  numero_gaceta: string | null;
  alcance: string | null;
  fecha_publicacion: string | null;
}

async function fetchGeneral(numero: string): Promise<GeneralRow | null> {
  const { data, error } = await supa()
    .from('sil_expedientes')
    .select('numero, titulo, estado, comision, proponente, fecha_presentacion, tipo, legislatura, url_detalle, metadata')
    .eq('numero', numero)
    .maybeSingle();
  if (error) {
    logger.warn('expediente_ctx_general_failed', { numero, error: error.message });
    return null;
  }
  return data as GeneralRow | null;
}

async function fetchTramite(numero: string): Promise<TramiteRow[]> {
  const { data, error } = await supa()
    .from('sil_expediente_tramite')
    .select('fecha_inicio, organo_legislativo, descripcion')
    .eq('expediente_id', numero)
    .order('fecha_inicio', { ascending: false })
    .limit(10);
  if (error) {
    logger.warn('expediente_ctx_tramite_failed', { numero, error: error.message });
    return [];
  }
  return (data ?? []) as TramiteRow[];
}

async function fetchProponentes(numero: string): Promise<ProponenteRow[]> {
  const { data, error } = await supa()
    .from('sil_expediente_proponentes')
    .select('diputado_nombre, firma_orden')
    .eq('expediente_id', numero)
    .order('firma_orden', { ascending: true })
    .limit(20);
  if (error) {
    logger.warn('expediente_ctx_proponentes_failed', { numero, error: error.message });
    return [];
  }
  return (data ?? []) as ProponenteRow[];
}

async function fetchDocumentos(numero: string): Promise<DocRow[]> {
  // Merge both tables: enrichment docs + bulk docs
  const [{ data: enrichDocs, error: e1 }, { data: bulkDocs, error: e2 }] = await Promise.all([
    supa()
      .from('sil_expediente_documentos')
      .select('tipo, titulo, fecha')
      .eq('expediente_id', numero)
      .limit(30),
    supa()
      .from('sil_documentos')
      .select('tipo, titulo, fecha')
      .eq('expediente_id', parseInt(numero.replace('.', ''), 10))
      .limit(30),
  ]);
  if (e1) logger.warn('expediente_ctx_docs_enrich_failed', { numero, error: e1.message });
  if (e2) logger.warn('expediente_ctx_docs_bulk_failed', { numero, error: e2.message });

  const seen = new Set<string>();
  const out: DocRow[] = [];
  for (const d of [...(enrichDocs ?? []), ...(bulkDocs ?? [])] as DocRow[]) {
    const key = `${d.tipo ?? ''}::${(d.titulo ?? '').slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= 20) break;
  }
  return out;
}

async function fetchFechas(numero: string): Promise<FechaRow[]> {
  const { data, error } = await supa()
    .from('sil_expediente_fechas_vigentes')
    .select('campo, valor_fecha, valor_texto_original, fuente_documento_url')
    .eq('expediente_id', numero)
    .limit(10);
  if (error) {
    logger.warn('expediente_ctx_fechas_failed', { numero, error: error.message });
    return [];
  }
  return (data ?? []) as FechaRow[];
}

async function fetchLey(numero: string): Promise<LeyRow | null> {
  const { data, error } = await supa()
    .from('sil_leyes')
    .select('numero_ley, numero_gaceta, alcance, fecha_publicacion')
    .eq('expediente_origen_id', numero)
    .maybeSingle();
  if (error) {
    logger.warn('expediente_ctx_ley_failed', { numero, error: error.message });
    return null;
  }
  return data as LeyRow | null;
}

export async function loadExpedienteContext(numero: string): Promise<ExpedienteContext | null> {
  const now = Date.now();
  const hit = cache.get(numero);
  if (hit && hit.expiresAt > now) {
    cache.delete(numero);
    cache.set(numero, hit);
    return hit.ctx;
  }

  const general = await fetchGeneral(numero);
  if (!general) return null;

  const [tramite, proponentes, documentos, fechas, ley] = await Promise.all([
    fetchTramite(numero),
    fetchProponentes(numero),
    fetchDocumentos(numero),
    fetchFechas(numero),
    fetchLey(numero),
  ]);

  const meta = general.metadata ?? {};
  const resumenEjecutivo =
    (meta.resumen as string | undefined) ??
    (meta.resumen_ejecutivo as string | undefined) ??
    null;

  const tramiteResumen = tramite.length
    ? tramite
        .map((t) => {
          const parts: string[] = [];
          if (t.fecha_inicio) parts.push(t.fecha_inicio.slice(0, 10));
          if (t.organo_legislativo) parts.push(t.organo_legislativo);
          if (t.descripcion) parts.push(t.descripcion);
          return `- ${parts.join(' · ')}`;
        })
        .join('\n')
    : null;

  const proponentesResumen = proponentes.length
    ? proponentes.map((p) => `- ${p.diputado_nombre ?? 'Desconocido'}`).join('\n')
    : null;

  const documentosResumen = documentos.length
    ? documentos
        .map((d) => {
          const tipo = d.tipo ?? 'doc';
          const titulo = d.titulo ?? 'sin título';
          return `- ${tipo}: ${titulo}`;
        })
        .join('\n')
    : null;

  const fechasResumen = fechas.length
    ? fechas.map((f) => `- ${f.campo ?? 'fecha'}: ${f.valor_texto_original ?? f.valor_fecha ?? '?'}`).join('\n')
    : null;

  const leyResumen = ley
    ? `Ley N°${ley.numero_ley ?? '?'}${ley.alcance ? ` — ${ley.alcance}` : ''}${ley.numero_gaceta ? ` (Gaceta ${ley.numero_gaceta})` : ''}${ley.fecha_publicacion ? `, publicada ${ley.fecha_publicacion}` : ''}`
    : null;

  const ctx: ExpedienteContext = {
    numero: general.numero,
    titulo: general.titulo ?? 'Sin título',
    estado: general.estado,
    comision: general.comision,
    proponente_principal: general.proponente,
    fecha_presentacion: general.fecha_presentacion,
    tipo: general.tipo,
    legislatura: general.legislatura,
    url_detalle: general.url_detalle,
    resumen_ejecutivo: resumenEjecutivo,
    tramite_resumen: tramiteResumen,
    proponentes_resumen: proponentesResumen,
    documentos_resumen: documentosResumen,
    fechas_resumen: fechasResumen,
    ley_resumen: leyResumen,
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(numero, { ctx, expiresAt: now + CACHE_TTL_MS });
  return ctx;
}

export function invalidateExpedienteContext(numero: string): boolean {
  return cache.delete(numero);
}

export function clearExpedienteContextCache(): void {
  cache.clear();
}

export function expedienteContextCacheStats(): { size: number; max: number; ttl_ms: number } {
  return { size: cache.size, max: CACHE_MAX, ttl_ms: CACHE_TTL_MS };
}

function fmtDateCR(ymd: string | null): string {
  if (!ymd) return 's/f';
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' });
}

/**
 * Build the system message that scopes the conversation to this expediente.
 *
 * CRITICAL: Lexa's persona is trained on numbered extracts [N] from
 * transcripts. When we pass the expediente context as a flat bullet list,
 * the model ignores it and falls back to tools (get_sil_expediente).
 *
 * Fix: format the context as NUMBERED EXTRACTS [N] so the model treats
 * them as first-class sources, exactly like transcript chunks. This
 * leverages the existing citation training without modifying lexa.yaml.
 */
export function buildExpedienteSystemPrompt(ctx: ExpedienteContext): string {
  const extracts: string[] = [];
  let idx = 1;

  const pushExtract = (label: string, body: string) => {
    extracts.push(`[${idx}] ${label}\n${body.trim()}`);
    idx += 1;
  };

  // Extract 1 — Identidad
  const identityParts = [
    `Expediente ${ctx.numero} — ${ctx.titulo}`,
    `Estado: ${ctx.estado ?? 's/f'}`,
  ];
  if (ctx.comision) identityParts.push(`Comisión: ${ctx.comision}`);
  if (ctx.proponente_principal) identityParts.push(`Proponente principal: ${ctx.proponente_principal}`);
  if (ctx.fecha_presentacion) identityParts.push(`Presentado: ${fmtDateCR(ctx.fecha_presentacion)}`);
  if (ctx.tipo) identityParts.push(`Tipo: ${ctx.tipo}`);
  if (ctx.legislatura) identityParts.push(`Legislatura: ${ctx.legislatura}`);
  pushExtract('Identidad del expediente', identityParts.join('. '));

  // Extract 2 — Resumen ejecutivo (if available)
  if (ctx.resumen_ejecutivo) {
    pushExtract('Resumen ejecutivo', ctx.resumen_ejecutivo);
  }

  // Extract 3 — Proponentes
  if (ctx.proponentes_resumen) {
    pushExtract('Proponentes (orden de firma)', ctx.proponentes_resumen);
  }

  // Extract 4 — Trámite reciente
  if (ctx.tramite_resumen) {
    pushExtract('Trámite reciente (eventos más recientes primero)', ctx.tramite_resumen);
  }

  // Extract 5 — Fechas clave
  if (ctx.fechas_resumen) {
    pushExtract('Fechas clave', ctx.fechas_resumen);
  }

  // Extract 6 — Documentos disponibles
  if (ctx.documentos_resumen) {
    pushExtract('Documentos disponibles en el expediente', ctx.documentos_resumen);
  }

  // Extract 7 — Ley (if applicable)
  if (ctx.ley_resumen) {
    pushExtract('Información de ley publicada', ctx.ley_resumen);
  }

  const blocks: string[] = [
    `=== CONTEXTO DEL EXPEDIENTE ${ctx.numero} — USAR COMO FUENTE PRINCIPAL ===`,
    '',
    ...extracts,
    '',
    `=== INSTRUCCIONES ===`,
    `• ESTÁS EN UNA CONVERSACIÓN SOBRE EL EXPEDIENTE ${ctx.numero}. NO le pidas al usuario el número de expediente.`,
    `• Respondé directamente usando los extractos [${extracts.map((_, i) => i + 1).join('][')}] de arriba. Citá [N] cuando cites datos.`,
    `• Para el CONTENIDO de documentos (texto base, dictámenes, mociones), usá \`search_sil_corpus\` con \`expediente_numero: "${ctx.numero}"\`.`,
    `• Si no tenés la info, decilo: "No tengo información sobre X para este expediente."`,
  ];

  return blocks.join('\n');
}
