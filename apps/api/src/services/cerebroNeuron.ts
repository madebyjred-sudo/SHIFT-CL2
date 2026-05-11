/**
 * Cerebro Neuron client — HTTP cliente al per-user memory store que vive
 * en Cerebro Railway. Ver
 * AGENTS/CEREBRO/handoffs/2026-05-10-neurons-wiring-clients.md
 * para el contrato y diseño.
 *
 * Para qué se usa en CL2:
 *   1. BFF proxy (routes/neuron.ts) — forwardea los 5 endpoints
 *      (list / read / write / delete / history) al SPA. Habilita el
 *      panel "Mi memoria" donde el user gestiona manualmente lo que
 *      la app sabe de él.
 *   2. Onboarding hook (admin.ts /users/:id/approve) — cuando un user
 *      pasa de pending→active, escribe templates iniciales en
 *      `/memories/onboarding/*.md`.
 *   3. Background jobs (transcriptProcess, podcastScript, etc) — si
 *      una tarea no-streaming necesita memoria, llama directo a
 *      `/v1/llm/invoke` de Cerebro con `enable_memory: true`. Esa
 *      ruta no usa este módulo — usa cerebroLlmClient.ts.
 *
 * NO se usa para:
 *   - Inyectar contenido en el system prompt del chat principal. Eso
 *     es anti-pattern. La integración correcta para el chat va a vivir
 *     en Cerebro vía memory tool, cuando Track A aterrice
 *     (`feat/oai-compat` extendido). Mientras tanto, el chat va sin
 *     memoria automática — el user puede escribir manual desde el
 *     panel.
 *
 * realm: hardcoded "cl2" — cross-realm reads imposibles a nivel DB de
 * Cerebro (composite PK).
 *
 * Auth: `x-shift-internal-token` header. Server-side only — NUNCA al
 * browser.
 *
 * Failure mode: cualquier error se traga silencioso. Los callers
 * (BFF proxy, onboarding hook) deciden cómo degradar.
 */

const CEREBRO_BASE_URL =
  process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro-production.up.railway.app';
const NEURON_TIMEOUT_MS = 4_500;
const NEURON_CACHE_TTL_MS = 30_000; // per-user, very short — facts can shift mid-session

const REALM = 'cl2';

export interface NeuronFile {
  path: string;
  size_bytes: number;
  updated_at: string;
}

export interface NeuronListing {
  user_id: string;
  realm: string;
  file_count: number;
  total_bytes: number;
  files: NeuronFile[];
}

export interface NeuronFileContent {
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

interface CacheEntry<T> {
  data: T | null;
  expiresAt: number;
}

const listCache = new Map<string, CacheEntry<NeuronListing>>();

function authHeaders(): Record<string, string> {
  const token = process.env.SHIFT_INTERNAL_TOKEN;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['x-shift-internal-token'] = token;
  return h;
}

function withTimeoutFetch(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NEURON_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

/**
 * List files in the user's neuron. Cached briefly to avoid hammering
 * Cerebro when the BFF endpoint and chat both hit on the same turn.
 * Returns null on any failure (network, 4xx, 5xx) — caller decides
 * whether to surface the error or degrade silently. */
export async function listNeuron(userEmail: string): Promise<NeuronListing | null> {
  if (!userEmail) return null;
  const key = `${REALM}:${userEmail}`;
  const cached = listCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = `${CEREBRO_BASE_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}`;
  try {
    const res = await withTimeoutFetch(url, { method: 'GET', headers: authHeaders() });
    if (!res.ok) {
      listCache.set(key, { data: null, expiresAt: Date.now() + NEURON_CACHE_TTL_MS });
      return null;
    }
    const data = (await res.json()) as NeuronListing;
    listCache.set(key, { data, expiresAt: Date.now() + NEURON_CACHE_TTL_MS });
    return data;
  } catch {
    listCache.set(key, { data: null, expiresAt: Date.now() + NEURON_CACHE_TTL_MS });
    return null;
  }
}

/** Read a single file's content. Returns null on 404 or any failure. */
export async function readNeuronFile(
  userEmail: string,
  path: string,
): Promise<NeuronFileContent | null> {
  if (!userEmail || !path) return null;
  const url = `${CEREBRO_BASE_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}/file?path=${encodeURIComponent(path)}`;
  try {
    const res = await withTimeoutFetch(url, { method: 'GET', headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as NeuronFileContent;
  } catch {
    return null;
  }
}

/** Write or replace a file. `content` is markdown/text, ≤50KB per file
 *  (Cerebro enforces; we don't pre-check). Returns true if persisted. */
export async function writeNeuronFile(
  userEmail: string,
  path: string,
  content: string,
): Promise<boolean> {
  if (!userEmail || !path) return false;
  const url = `${CEREBRO_BASE_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}/file`;
  try {
    const res = await withTimeoutFetch(url, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ path, content }),
    });
    if (res.ok) {
      // Invalidate the listing cache so the next list() reflects the write.
      listCache.delete(`${REALM}:${userEmail}`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Delete a file or a prefix (e.g. path=/memories drops every file
 *  under that dir). Use with care — no recovery. */
export async function deleteNeuronFile(userEmail: string, path: string): Promise<boolean> {
  if (!userEmail || !path) return false;
  const url = `${CEREBRO_BASE_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}/file?path=${encodeURIComponent(path)}`;
  try {
    const res = await withTimeoutFetch(url, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) {
      listCache.delete(`${REALM}:${userEmail}`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Audit log of writes to this user's neuron. Newest first. */
export async function neuronHistory(
  userEmail: string,
  limit = 50,
): Promise<NeuronHistoryEntry[]> {
  if (!userEmail) return [];
  const url = `${CEREBRO_BASE_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}/history?limit=${limit}`;
  try {
    const res = await withTimeoutFetch(url, { method: 'GET', headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: NeuronHistoryEntry[] };
    return body.items ?? [];
  } catch {
    return [];
  }
}

