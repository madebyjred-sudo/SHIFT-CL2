/**
 * Client wrapper for /api/sil/*. Used by the /sil page (manual browse).
 * Distinct from `silClient` on the BFF (which is server-only) and from
 * `expedientesApi` (which is the single-doc detail). Same auth pattern
 * as the rest of /api: Supabase JWT in the Authorization header.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/sil';

async function authHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: await authHeaders(), credentials: 'include' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface SilCoverage {
  ok: true;
  total: number;
  indexed_count: number;
  indexed_doc_count: number;
  buckets: {
    active_legislature: number;
    pending_in_active: number;
    legacy_1997_2022: number;
    historical_pre_1997: number;
  };
}

export interface SilFacets {
  ok: true;
  comisiones: string[];
  estados: string[];
  tipos: string[];
  years: number[];
}

export interface SilExpedienteListItem {
  id: number;
  numero: string;
  titulo: string | null;
  comision: string | null;
  estado: string | null;
  tipo: string | null;
  fecha_presentacion: string | null;
  proponente: string | null;
  url_detalle: string | null;
  documentos_count: number;
  documentos_tipos: string[];
  status: 'indexed' | 'metadata';
}

export interface SilExpedienteList {
  ok: true;
  total: number;
  items: SilExpedienteListItem[];
  include_metadata: boolean;
}

export interface SilListQuery {
  q?: string;
  comision?: string;
  estado?: string;
  tipo?: string;
  year?: number;
  include_metadata?: boolean;
  limit?: number;
  offset?: number;
}

export const fetchSilCoverage = () => get<SilCoverage>('/coverage');
export const fetchSilFacets = () => get<SilFacets>('/facets');
export const fetchSilExpedientes = (q: SilListQuery): Promise<SilExpedienteList> => {
  const sp = new URLSearchParams();
  if (q.q) sp.set('q', q.q);
  if (q.comision) sp.set('comision', q.comision);
  if (q.estado) sp.set('estado', q.estado);
  if (q.tipo) sp.set('tipo', q.tipo);
  if (q.year) sp.set('year', String(q.year));
  if (q.include_metadata) sp.set('include_metadata', '1');
  if (q.limit) sp.set('limit', String(q.limit));
  if (q.offset) sp.set('offset', String(q.offset));
  const qs = sp.toString();
  return get<SilExpedienteList>(`/expedientes${qs ? `?${qs}` : ''}`);
};
