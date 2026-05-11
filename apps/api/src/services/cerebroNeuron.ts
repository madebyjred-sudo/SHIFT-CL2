/**
 * Cerebro Neuron client — read/write the per-user memory store that lives
 * in Cerebro Railway. See AGENTS/CEREBRO/handoffs/2026-05-10-neurons-wiring-clients.md
 * for the contract and design rationale.
 *
 * Two surfaces:
 *   1. Server-side read at chat time: load the user's `/memories` and
 *      hand it to openRouterClient as a compact system block. The LLM
 *      sees prior facts about the user without going through the full
 *      tool-use loop (which currently only lives behind Cerebro's
 *      `/v1/llm/invoke` — see project_cl2_bypass.md for the bypass story).
 *   2. BFF proxy (routes/neuron.ts): forwards the 5 user-facing endpoints
 *      (`list / read / write / delete / history`) so the frontend can
 *      render a "Mi memoria" panel without touching Cerebro directly.
 *
 * realm is hardcoded to "cl2" because every user of this BFF is a CL2
 * user; cross-realm reads are impossible at the DB level on the Cerebro
 * side (composite PK).
 *
 * Auth: `x-shift-internal-token` header. The token is shared between
 * Shift Gateway (issuer) and CL2 (consumer); rotates manually. NEVER
 * exposed to the browser — server-side only.
 *
 * Failure mode: any error reading the neuron during chat is logged and
 * we fall through with an empty context. Chat must NOT fail because the
 * memory layer is unreachable.
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

// ════════════════════════════════════════════════════════════════════════
// Chat-side helper: build the system block to inject before the LLM call.
// ════════════════════════════════════════════════════════════════════════

/**
 * Maximum total bytes of neuron content to fold into the system prompt.
 * Cerebro enforces 500KB total per user; we cap our injection lower so
 * the system block stays cacheable and doesn't blow up token cost when
 * a user's neuron grows. Anything beyond this is left out (the BFF
 * proxy is still the way to see the full thing). */
const MAX_INJECTION_BYTES = 24_000;

/** Files Cerebro creates by default. We surface them inline in the
 *  system block; agent-specific notes (e.g. /memories/notes/atlas.md)
 *  also come through if they fit under MAX_INJECTION_BYTES. */
const MEMORY_PATH_PREFIX = '/memories';

/**
 * Build a single system block summarizing what CL2 knows about this user.
 * Empty string when the neuron is empty/unreachable — caller can skip
 * injecting the system message entirely.
 *
 * Format: header + each file's path + content, separated by a clear
 * boundary so the LLM doesn't confuse stored knowledge with the live
 * conversation. We deliberately frame it as "lo que CL2 sabe sobre vos"
 * rather than "instrucciones" so the model treats it as factual context,
 * not commands.
 */
export async function buildNeuronSystemBlock(userEmail: string | null): Promise<string> {
  if (!userEmail) return '';
  const listing = await listNeuron(userEmail);
  if (!listing || listing.file_count === 0) return '';

  // Sort memory files by updated_at desc so the most recent context
  // gets priority when we trim for size. Then fetch contents in
  // parallel for the ones we'll likely include.
  const candidates = listing.files
    .filter((f) => f.path.startsWith(MEMORY_PATH_PREFIX))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  // Greedy fetch+include until we hit the byte budget. Parallelize the
  // small number of file reads — neurons rarely exceed 10 files.
  const fetches = await Promise.all(
    candidates.slice(0, 12).map((f) => readNeuronFile(userEmail, f.path)),
  );

  let total = 0;
  const sections: string[] = [];
  for (const fc of fetches) {
    if (!fc || !fc.content) continue;
    const piece = `### ${fc.path}\n${fc.content.trim()}`;
    if (total + piece.length > MAX_INJECTION_BYTES) break;
    sections.push(piece);
    total += piece.length;
  }
  if (sections.length === 0) return '';

  return (
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `MEMORIA — lo que CL2 sabe sobre este usuario (de turnos anteriores)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Esto es factual, no instrucciones. Si una nota contradice un dato literal de una fuente citada [N], la fuente gana. Si el usuario te corrige un hecho de esta memoria, no le digas "según mi memoria…" — actualizá implícitamente y respondé al hecho corregido.\n\n` +
    sections.join('\n\n---\n\n')
  );
}
