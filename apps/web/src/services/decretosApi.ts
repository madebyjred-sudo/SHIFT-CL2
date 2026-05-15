/**
 * Decretos Ejecutivos — cliente tipado para los endpoints de usuario.
 * Espeja apps/api/src/routes/decretos.ts (decretoUserRouter).
 *
 * Source: Track D, Sprint 1. Jred 2026-05-14.
 */

import { supabase } from '@/lib/supabase';

const BASE = '/api/decretos';

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type DecretoTipo = 'ampliacion' | 'retiro' | 'mixto';
export type ParserStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'manual_review';

export interface DecretoRow {
  id: string;
  numero_decreto: string | null;
  fecha: string;              // 'YYYY-MM-DD'
  tipo: DecretoTipo;
  parser_status: ParserStatus;
  procesado_at: string | null;
  documento_url: string;
  periodo_legislativo: string | null;
}

export interface DecretoDetalle extends DecretoRow {
  sharepoint_item_id: string | null;
  raw: Record<string, unknown> | null;
  parser_error: string | null;
  created_at: string;
  expedientes_ampliados: Array<{ expediente_id: string; sigue_vigente: boolean }>;
  expedientes_retirados: Array<{ expediente_id: string; sigue_vigente: boolean }>;
}

export interface UltimoDecretoSummary {
  id: string;
  numero_decreto: string | null;
  fecha: string;
  tipo: DecretoTipo;
  procesado_at: string | null;
}

export interface TopRecienteItem {
  expediente_id: string;
  fecha_decreto: string;
}

export interface EstadoPlenario {
  total_convocados: number;
  total_retirados: number;
  ultimo_decreto: UltimoDecretoSummary | null;
  top_recientes: TopRecienteItem[];
  en_sesiones_extraordinarias: boolean;
  calculado_at: string;
}

export interface DecretosListResponse {
  data: DecretoRow[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

// ─── Funciones ────────────────────────────────────────────────────────────────

/**
 * Obtiene el resumen del estado actual del Plenario:
 * cuántos expedientes están vivos (convocados), cuántos retirados,
 * y el último decreto procesado.
 */
export async function getEstadoPlenario(): Promise<EstadoPlenario> {
  const res = await apiFetch<{ ok: boolean; data: EstadoPlenario }>('/estado-plenario');
  return res.data;
}

/**
 * Lista paginada de decretos procesados.
 * @param opts.page       Página (1-indexed, default 1)
 * @param opts.per_page   Items por página (max 50, default 20)
 * @param opts.tipo       Filtrar por tipo (ampliacion|retiro|mixto)
 */
export async function listDecretos(opts: {
  page?: number;
  per_page?: number;
  tipo?: DecretoTipo;
} = {}): Promise<DecretosListResponse> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.per_page) params.set('per_page', String(opts.per_page));
  if (opts.tipo) params.set('tipo', opts.tipo);
  const qs = params.toString();
  return apiFetch<DecretosListResponse>(`/list${qs ? `?${qs}` : ''}`);
}

/**
 * Detalle de un decreto por UUID:
 * metadata completa + expedientes ampliados + expedientes retirados.
 */
export async function getDecretoDetalle(id: string): Promise<DecretoDetalle> {
  const res = await apiFetch<{ ok: boolean; data: DecretoDetalle }>(`/${id}`);
  return res.data;
}

/**
 * Trigger manual del ingestor (admin/dev).
 * Requiere usuario autenticado.
 */
export async function triggerIngestNow(): Promise<{
  processed: number;
  errors: number;
  manual_review: number;
  skipped: number;
}> {
  const headers = await authHeaders();
  const res = await fetch('/api/admin/decretos/ingest-now', {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  type IngestResult = { processed: number; errors: number; manual_review: number; skipped: number };
  const json = (await res.json()) as { ok: boolean; result: IngestResult };
  return json.result;
}
