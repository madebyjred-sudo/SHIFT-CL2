/**
 * Neuron API — typed client del BFF proxy `/api/neuron/*`.
 *
 * Espejo de apps/api/src/routes/neuron.ts (5 endpoints REST). El
 * backend resuelve el `user_id` desde el JWT verificado de Supabase y
 * fija `realm="cl2"` server-side — el SPA no elige a quién consulta.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/neuron';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export interface NeuronFileMeta {
  path: string;
  size_bytes: number;
  updated_at: string;
}

export interface NeuronListing {
  ok: true;
  realm?: string;
  user_id?: string;
  file_count: number;
  total_bytes: number;
  quota_bytes?: number;
  quota_files?: number;
  files: NeuronFileMeta[];
}

export interface NeuronFileContent {
  ok: true;
  path: string;
  content: string;
  size_bytes: number;
  updated_at: string;
}

export interface NeuronHistoryEntry {
  command: string;
  agent_id: string | null;
  app_id: string | null;
  call_id: string | null;
  diff_excerpt: string | null;
  created_at: string;
}

export async function listMyMemory(): Promise<NeuronListing> {
  return call<NeuronListing>('/');
}

export async function readMyMemoryFile(path: string): Promise<NeuronFileContent> {
  const qs = `?path=${encodeURIComponent(path)}`;
  return call<NeuronFileContent>(`/file${qs}`);
}

export async function writeMyMemoryFile(path: string, content: string): Promise<void> {
  await call('/file', {
    method: 'PATCH',
    body: JSON.stringify({ path, content }),
  });
}

export async function deleteMyMemoryFile(path: string): Promise<void> {
  const qs = `?path=${encodeURIComponent(path)}`;
  await call(`/file${qs}`, { method: 'DELETE' });
}

export async function getMyMemoryHistory(limit = 50): Promise<NeuronHistoryEntry[]> {
  const r = await call<{ ok: true; items: NeuronHistoryEntry[] }>(`/history?limit=${limit}`);
  return r.items;
}
