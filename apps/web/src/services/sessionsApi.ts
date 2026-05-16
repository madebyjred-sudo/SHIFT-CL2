/**
 * Sessions API client — hits the BFF /api/sessions endpoints.
 *
 * Returns parsed shapes that match what the BFF emits. Auth header is
 * always sent when a Supabase session exists; the BFF gates these routes
 * (no anon access).
 */
import { supabase } from '@/lib/supabase';

export interface SessionListItem {
  /** int para sesiones legacy MariaDB, UUID string para sesiones nuevas Supabase. */
  id: number | string;
  titulo: string;
  youtube_url: string;
  youtube_id: string | null;
  fecha: string;
  duration_s: number;
  estado: number;
  has_resumen: boolean;
}

export interface ResumenSections {
  ejecutivo: string | null;
  puntos_clave: string | null;
  acuerdos: string | null;
  raw: string;
}

export interface SessionDetail {
  id: number;
  titulo: string;
  youtube_url: string;
  youtube_id: string | null;
  fecha: string;
  duration_s: number;
  estado: number;
  transcript_url: string;
  resumen: ResumenSections;
}

export interface TranscriptSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  word_count: number;
}

export interface TranscriptPayload {
  id: number;
  language: string;
  duration_s: number;
  segment_count: number;
  word_count: number;
  segments: TranscriptSegment[];
}

async function authHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const err = new Error(`api ${url} ${res.status}`);
    (err as Error & { body?: unknown }).body = body;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface FetchSessionsArgs {
  from?: string;
  to?: string;
  /** Si 'plenario', solo plenarias/comisiones largas (≥30min). Cualquier otro
   *  valor (o ausente) = sin filtro de tipo (incluye clips, entrevistas, shorts). */
  type?: 'plenario' | 'all';
  /** Si true, incluye sesiones en pending_review/processing (admin use).
   *  Default false → solo sesiones ya publicadas al equipo. */
  includePending?: boolean;
}

export async function fetchSessions(args: FetchSessionsArgs = {}): Promise<SessionListItem[]> {
  const qs = new URLSearchParams();
  if (args.from) qs.set('from', args.from);
  if (args.to) qs.set('to', args.to);
  if (args.type && args.type !== 'all') qs.set('type', args.type);
  if (args.includePending) qs.set('include_pending', 'true');
  const q = qs.toString();
  const data = await getJson<{ ok: true; sessions: SessionListItem[] }>(
    `/api/sessions${q ? `?${q}` : ''}`,
  );
  return data.sessions;
}

export async function fetchSessionDetail(id: number | string): Promise<SessionDetail> {
  const data = await getJson<{ ok: true; session: SessionDetail }>(`/api/sessions/${id}`);
  return data.session;
}

export async function fetchSessionTranscript(id: number | string): Promise<TranscriptPayload> {
  const data = await getJson<{ ok: true; transcript: TranscriptPayload }>(
    `/api/sessions/${id}/transcript`,
  );
  return data.transcript;
}
