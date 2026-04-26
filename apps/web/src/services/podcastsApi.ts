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
