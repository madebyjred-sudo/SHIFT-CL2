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
