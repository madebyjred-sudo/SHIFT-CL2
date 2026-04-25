/**
 * Uploads API client — submits a YouTube URL to the BFF and polls until the
 * legacy worker finishes ingesting the session. See routes/uploads.ts for
 * the contract.
 */
import { supabase } from '@/lib/supabase';

export interface SubmitArgs {
  youtube_url: string;
  titulo: string;
  fecha: string;            // YYYY-MM-DD
  comision?: string;
  tipo?: 'plenario' | 'comision' | 'extraordinaria';
}

export interface SubmitResult {
  ok: true;
  legacy_id: number;
  poll_url: string;
  kick_error: string | null;
}

export interface SessionInfo {
  id: number;
  titulo: string;
  fecha: string;
  duration_s: number;
  estado: number;
  has_transcript: boolean;
  has_resumen: boolean;
}

export interface StatusReady {
  ok: true;
  status: 'ready';
  detail?: string;
  session: SessionInfo;
}

/** Legacy worker marked the row PROCESADO but transcripcion url is empty.
 * The session technically exists but is unusable for chat — surface to UI
 * so the user can retry / open ticket instead of waiting forever. */
export interface StatusPartial {
  ok: true;
  status: 'partial';
  detail: string;
  session: SessionInfo;
}

export interface StatusPending {
  ok: true;
  status: 'pending';
  detail?: string;
  session?: SessionInfo;
}

export type StatusResponse = StatusReady | StatusPartial | StatusPending;

async function authHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export async function submitYoutubeUpload(args: SubmitArgs): Promise<SubmitResult> {
  const res = await fetch('/api/uploads/youtube', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const detail = json?.detail ?? json?.error ?? `http ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return json as SubmitResult;
}

export async function fetchUploadStatus(legacyId: number): Promise<StatusResponse> {
  const res = await fetch(`/api/uploads/${legacyId}/status`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`status http ${res.status}`);
  return res.json();
}
