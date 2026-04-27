/**
 * Podcasts API client. Mirrors apps/api/src/routes/podcasts.ts.
 *
 * Polling pattern: caller calls `createPodcast()`, then `getPodcast(id)`
 * on a setInterval until status is 'ready' | 'failed'. Audio access is
 * via `audioUrl(id)` which 302s to a short-lived GCS signed URL.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/podcasts';

async function authHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: await authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface PodcastVoice {
  id: string;
  label: string;
  description: string;
}

export type PodcastStatus =
  | 'queued'
  | 'scripting'
  | 'tts'
  | 'encoding'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type PodcastSourceType =
  | 'sesion'
  | 'expediente'
  | 'chat'
  | 'hoja_workspace'
  | 'hoja_node';
/**
 * 'informativo' = single host narrating a briefing. Compact, factual.
 * 'conversacional' = host + analyst dialogue. More dynamic, slightly
 * longer per duration target since two speakers exchange shorter
 * segments. Dialogue mode uses the v3 ElevenLabs model when available.
 */
export type PodcastStyle = 'informativo' | 'conversacional';

export interface PodcastRow {
  id: string;
  source_type: PodcastSourceType;
  source_id: string;
  title: string | null;
  voice_id: string;
  duration_target_s: number;
  duration_actual_s: number | null;
  style: PodcastStyle;
  status: PodcastStatus;
  progress: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface CreatePodcastArgs {
  source_type: PodcastSourceType;
  source_id: string;
  voice_id: string;
  duration_target_s: 90 | 180 | 300;
  style: PodcastStyle;
  /** Optional ≤140-char directive Lexa weaves into the script. */
  user_prompt?: string;
}

/**
 * Ask Lexa to rewrite a 140-char user idea into a tighter directive.
 * Used by the modal's "Mejorar con Lexa" button — non-destructive, the
 * user can accept or discard the result.
 */
export async function enhancePodcastPrompt(prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/enhance-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { ok: true; prompt: string };
  return json.prompt;
}

export interface PodcastQuota {
  used: number;
  limit: number;
  remaining: number;
}

export async function getPodcastQuota(): Promise<PodcastQuota> {
  const r = await get<{ ok: true } & PodcastQuota>('/quota');
  return { used: r.used, limit: r.limit, remaining: r.remaining };
}

export async function listVoices(): Promise<PodcastVoice[]> {
  const r = await get<{ ok: true; voices: PodcastVoice[] }>('/voices');
  return r.voices;
}

export async function createPodcast(args: CreatePodcastArgs): Promise<{ id: string }> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string; error?: string }).message ??
        (body as { error?: string }).error ??
        `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as { id: string };
}

export async function getPodcast(id: string): Promise<PodcastRow> {
  const r = await get<{ ok: true; podcast: PodcastRow }>(`/${id}`);
  return r.podcast;
}

export async function listMyPodcasts(): Promise<PodcastRow[]> {
  const r = await get<{ ok: true; items: PodcastRow[] }>('/mine');
  return r.items;
}

/**
 * Podcasts attached to a specific source (e.g. all audio for a Hojas
 * workspace). Used to surface the most recent ready audio inline.
 */
export async function listPodcastsBySource(
  type: PodcastSourceType,
  id: string,
): Promise<PodcastRow[]> {
  const sp = new URLSearchParams({ type, id });
  const r = await get<{ ok: true; items: PodcastRow[] }>(`/by-source?${sp.toString()}`);
  return r.items;
}

export interface PodcastShare {
  url: string;
  token: string;
  expires_at: string;
}

/**
 * Mint or rotate a public share link for a podcast. ttlDays defaults
 * to 30, capped at 365 server-side. Calling again rotates the token.
 */
export async function createPodcastShare(id: string, ttlDays = 30): Promise<PodcastShare> {
  const res = await fetch(`${BASE}/${id}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ ttl_days: ttlDays }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PodcastShare;
}

export async function revokePodcastShare(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}/share`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function deletePodcast(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

/**
 * Resolve the audio URL for a ready podcast. Same pattern as expediente
 * docs: server returns the signed URL as JSON so the browser can play
 * it via <audio src=...> without auth headers (the URL is itself
 * authenticated via signature).
 */
export async function resolvePodcastAudioUrl(id: string): Promise<string> {
  const res = await fetch(`${BASE}/${id}/audio?json=1`, { headers: await authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { ok: true; url: string };
  return json.url;
}
