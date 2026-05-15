/**
 * Expedientes API client — fetches the SIL expediente detail from our BFF.
 * The BFF reads from sil_expedientes + sil_documentos and serves PDFs from
 * our own GCS mirror (or 302s to asamblea.go.cr for docs not yet mirrored).
 */
import { supabase } from '@/lib/supabase';

export interface ExpedienteDoc {
  id: string;
  expediente_id: number;
  tipo: string;
  titulo: string | null;
  fecha: string | null;
  source_url: string;
  status: string;
  text_chars: number | null;
  /** Relative URL to fetch the doc through our BFF (preferred over source_url). */
  view_url: string;
}

export interface Expediente {
  id: number;
  numero: string;
  titulo: string | null;
  proponente: string | null;
  comision: string | null;
  fecha_presentacion: string | null;
  estado: string | null;
  tipo: string | null;
  legislatura: string | null;
  url_detalle: string;
  documentos: ExpedienteDoc[];
}

async function authHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchExpediente(numero: number): Promise<Expediente> {
  const res = await fetch(`/api/expedientes/${numero}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error ?? `http ${res.status}`);
  }
  const json = (await res.json()) as { ok: true; expediente: Expediente };
  return json.expediente;
}

/**
 * Resolve a doc's view_url to a self-authenticating URL (GCS signed URL
 * for mirrored docs, asamblea.go.cr source URL otherwise). The BFF needs
 * a JWT, but the URL it returns does not — so we can window.open() it.
 *
 * Why a separate call instead of <a href={view_url}>: a plain browser
 * navigation can't carry the Authorization header, so it would 401.
 */
export async function resolveDocUrl(viewUrl: string): Promise<string> {
  const sep = viewUrl.includes('?') ? '&' : '?';
  const res = await fetch(`${viewUrl}${sep}json=1`, {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error ?? `http ${res.status}`);
  }
  const json = (await res.json()) as { ok: true; url: string; mirrored: boolean };
  return json.url;
}

// ─── Track B — Biblioteca de expediente unificada ────────────────────────────

export interface TramiteEvento {
  id: string;
  expediente_id: string;
  organo_legislativo: string;
  descripcion: string;
  fecha_inicio: string;
  fecha_termino: string | null;
  orden: number | null;
  created_at: string;
}

export interface Proponente {
  expediente_id: string;
  firma_orden: number;
  diputado_nombre: string;
  administracion: string | null;
  fraccion: string | null;
}

export interface Consulta {
  id: string;
  expediente_id: string;
  entidad_consultada: string;
  fecha_consulta: string | null;
  fecha_respuesta: string | null;
  documento_url: string | null;
  tipo_respuesta: 'a_favor' | 'en_contra' | 'condicional' | 'sin_observaciones' | null;
  resumen_por_tanto: string | null;
  created_at: string;
}

export interface Afectacion {
  id: string;
  ley_id_origen: string;
  ley_id_afectada: string | null;
  ley_numero_afectada: string | null;
  tipo: 'deroga' | 'reforma' | 'adiciona' | 'suspende';
  articulos: string | null;
}

export interface LeyInfo {
  id: string;
  expediente_origen_id: string;
  numero_ley: string | null;
  numero_gaceta: string | null;
  alcance: string | null;
  fecha_aprobacion_2_3: string | null;
  fecha_emitido_asamblea: string | null;
  fecha_sancionado: string | null;
  fecha_devuelto_ejecutivo: string | null;
  fecha_publicacion: string | null;
  fecha_rige: string | null;
  estado: string;
  veto_texto: string | null;
  reselo: boolean;
  sil_leyes_afectaciones: Afectacion[];
}

export interface ExpedienteDocumentoFull {
  id: string;
  expediente_id: string;
  tipo: string;
  titulo: string | null;
  fecha: string | null;
  url: string;
  storage_path: string | null;
  embed_status: 'pending' | 'in_progress' | 'done' | 'failed';
  created_at: string;
}

export interface ExpedienteGeneral {
  id: number;
  numero: string;
  titulo: string | null;
  proponente: string | null;
  comision: string | null;
  fecha_presentacion: string | null;
  estado: string | null;
  tipo: string | null;
  legislatura: string | null;
  url_detalle: string;
}

export interface ExpedienteFullData {
  general: ExpedienteGeneral;
  tramite: TramiteEvento[];
  proponentes: Proponente[];
  consultas: Consulta[];
  ley: LeyInfo | null;
  documentos: ExpedienteDocumentoFull[];
}

/**
 * Fetch the full unified expediente data from the new /full endpoint.
 * Used exclusively by ExpedienteDashboardPage (Track B).
 */
export async function fetchExpedienteFull(numero: string): Promise<ExpedienteFullData> {
  const res = await fetch(`/api/expedientes/${encodeURIComponent(numero)}/full`, {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error ?? `http ${res.status}`);
  }
  const json = (await res.json()) as { ok: true; expediente: ExpedienteFullData };
  return json.expediente;
}
