/**
 * Workspace "Hojas" — typed API client.
 * Mirrors the BFF routes in apps/api/src/routes/workspace.ts.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/workspace';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  title: string;
  description: string;
  archived: boolean;
  node_count: number;
  created_at: string;
  updated_at: string;
}

export type NodeColor = 'default' | 'burgundy' | 'ink' | 'sage' | 'amber';
export type NodeType = 'hoja' | 'note' | 'cite' | 'expediente_ref' | 'image' | 'document' | 'audio';

/** Asset content shape for type ∈ {image, document, audio}. */
export interface AssetContent {
  url: string;
  path: string;
  filename: string;
  size: number;
  mime: string;
  thumbnail_url?: string;
}

export interface WorkspaceNode {
  id: string;
  workspace_id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  title: string;
  subtitle: string;
  color: NodeColor;
  content?: { md?: string };   // full content only when fetched individually
  created_at: string;
  updated_at: string;
}

// ─── Workspaces ───────────────────────────────────────────────────────

export async function listWorkspaces(includeArchived = false): Promise<Workspace[]> {
  const q = includeArchived ? '?archived=1' : '';
  const res = await apiFetch<{ ok: true; items: Workspace[] }>(`/${q}`);
  return res.items;
}

export async function createWorkspace(title = 'Mi espacio', description = ''): Promise<Workspace> {
  const res = await apiFetch<{ ok: true; workspace: Workspace }>('/', {
    method: 'POST',
    body: JSON.stringify({ title, description }),
  });
  return res.workspace;
}

export async function updateWorkspace(
  id: string,
  patch: Partial<Pick<Workspace, 'title' | 'description' | 'archived'>>,
): Promise<Workspace> {
  const res = await apiFetch<{ ok: true; workspace: Workspace }>(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.workspace;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiFetch(`/${id}`, { method: 'DELETE' });
}

// ─── Nodes ───────────────────────────────────────────────────────────

/**
 * List nodes for a workspace.
 *
 * @param workspaceId
 * @param opts.withContent — if true, server includes the JSONB `content`
 *   column so the canvas can hydrate hoja bodies on first paint. Set to
 *   `false` for list-only views (e.g. picker, sidebar) where geometry +
 *   titles suffice.
 */
export async function listNodes(
  workspaceId: string,
  opts: { withContent?: boolean } = {},
): Promise<WorkspaceNode[]> {
  const qs = opts.withContent ? '?withContent=1' : '';
  const res = await apiFetch<{ ok: true; nodes: WorkspaceNode[] }>(`/${workspaceId}/nodes${qs}`);
  return res.nodes;
}

export async function getNode(workspaceId: string, nodeId: string): Promise<WorkspaceNode> {
  const res = await apiFetch<{ ok: true; node: WorkspaceNode }>(`/${workspaceId}/nodes/${nodeId}`);
  return res.node;
}

export async function createNode(
  workspaceId: string,
  opts: Partial<Pick<WorkspaceNode, 'type' | 'x' | 'y' | 'width' | 'height' | 'title' | 'subtitle' | 'color'>> & { content?: { md?: string } },
): Promise<WorkspaceNode> {
  const res = await apiFetch<{ ok: true; node: WorkspaceNode }>(`/${workspaceId}/nodes`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  return res.node;
}

export async function updateNode(
  workspaceId: string,
  nodeId: string,
  patch: Partial<Pick<WorkspaceNode, 'title' | 'subtitle' | 'color' | 'x' | 'y' | 'width' | 'height' | 'z_index'>> & { content?: { md?: string } },
): Promise<WorkspaceNode> {
  const res = await apiFetch<{ ok: true; node: WorkspaceNode }>(`/${workspaceId}/nodes/${nodeId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.node;
}

export async function deleteNode(workspaceId: string, nodeId: string): Promise<void> {
  await apiFetch(`/${workspaceId}/nodes/${nodeId}`, { method: 'DELETE' });
}

// ─── Export ───────────────────────────────────────────────────────────

/**
 * Result for pptx exports. Backend returns JSON with a signed Gamma URL
 * (≈1 week TTL) instead of streaming bytes — generation can take 30s-3min,
 * so the API blocks server-side and returns the metadata for the UI to
 * present.
 *
 * IMPORTANT — UX choice: callers MUST NOT auto-trigger the download via an
 * anchor click. Browsers treat an `<a>.click()` after a 30s+ async block as
 * a popup (the click context is lost) and silently block it. Always render
 * a modal/card with explicit "Abrir" / "Descargar" buttons that the user
 * clicks themselves; that click context is preserved by the browser.
 */
export interface PptxExportResult {
  ok: true;
  format: 'pptx';
  cached: boolean;       // true when the API returned a cached deck (<1h old)
  generatedAt?: string;  // ISO timestamp the deck was last generated
  filename: string;
  url: string;          // signed download URL (the .pptx file)
  gammaUrl: string;     // editable deck on gamma.app
  generationId: string;
  creditsUsed?: number;
}

export async function exportNode(
  workspaceId: string,
  nodeId: string,
  format: 'md' | 'docx',
  hojaTitle?: string,
): Promise<void> {
  // pptx removed from this single-hoja endpoint — workspace-level deck is
  // the productive surface; per-hoja decks were noise.
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/${workspaceId}/nodes/${nodeId}/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ format }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string; error?: string }).detail
      ?? (body as { error?: string }).error
      ?? `HTTP ${res.status}`;
    throw new Error(`Export failed: ${detail}`);
  }

  const blob = await res.blob();
  const ext = format === 'docx' ? 'docx' : 'md';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(hojaTitle ?? 'hoja').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'hoja'}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import a file (image, audio, or document) as a new asset node on the
 * canvas. Uses multipart upload — server stores in Supabase Storage and
 * returns the created node.
 *
 * Supported MIME:
 *   image     png/jpg/gif/webp/svg
 *   audio     mp3/m4a/wav/ogg/webm
 *   document  pdf/docx/md/txt
 */
export async function importAsset(
  workspaceId: string,
  file: File,
  pos?: { x: number; y: number },
): Promise<WorkspaceNode> {
  const headers = await authHeaders();
  // Drop Content-Type so the browser sets multipart boundary correctly
  delete (headers as Record<string, string>)['Content-Type'];
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (pos) {
    fd.append('x', String(pos.x));
    fd.append('y', String(pos.y));
  }
  const res = await fetch(`${BASE}/${workspaceId}/nodes/import`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string; detail?: string }).detail
      ?? (body as { error?: string }).error
      ?? `Import failed: HTTP ${res.status}`);
  }
  const data = await res.json() as { ok: true; node: WorkspaceNode };
  return data.node;
}

/**
 * Workspace-wide export — concatenates all hojas in reading order
 * (top-to-bottom, left-to-right by canvas position) into one document.
 * Triggers a browser download.
 */
export async function exportWorkspace(
  workspaceId: string,
  format: 'md' | 'docx' | 'pptx',
  workspaceTitle?: string,
  opts?: { force?: boolean },
): Promise<PptxExportResult | void> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/${workspaceId}/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ format, force: opts?.force ?? false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string; error?: string }).detail
      ?? (body as { error?: string }).error
      ?? `HTTP ${res.status}`;
    const err = new Error(`Export failed: ${detail}`);
    // Surface the error code so the caller can branch (e.g. show a
    // billing CTA on insufficient_credits, retry CTA on timeout).
    (err as Error & { code?: string }).code = (body as { error?: string }).error;
    throw err;
  }
  const safeName = (workspaceTitle ?? 'workspace')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'workspace';

  if (format === 'pptx') {
    // No auto-download. Return the metadata; the modal renders the
    // explicit "Abrir / Descargar" buttons. See PptxExportResult docstring.
    return (await res.json()) as PptxExportResult;
  }

  const blob = await res.blob();
  const ext = format === 'docx' ? 'docx' : 'md';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Selection transform — Alt+select / ⌘K inline AI ─────────────────

export type TransformAction = 'rewrite' | 'summarize' | 'expand' | 'translate' | 'custom';

export interface TransformResult {
  text: string;
  action: TransformAction;
  model: string;
  ms: number;
}

/**
 * Transform a highlighted text fragment via AI. Used by the floating
 * selection menu inside hojas (Alt+drag selection or ⌘K).
 *
 * - rewrite/summarize/translate run on MiniMax M2.7 (cheap floor)
 * - expand runs on Sonnet (needs reasoning to add net-new content)
 * - custom takes a free-form instruction string
 */
export async function transformText(
  workspaceId: string,
  opts: {
    selection: string;
    action: TransformAction;
    instruction?: string;
    tone?: string;
  },
): Promise<TransformResult> {
  const res = await apiFetch<{ ok: true; text: string; action: TransformAction; model: string; ms: number }>(
    `/${workspaceId}/transform`,
    { method: 'POST', body: JSON.stringify(opts) },
  );
  return { text: res.text, action: res.action, model: res.model, ms: res.ms };
}

// ─── Arquitecta — multi-hoja generation ──────────────────────────────

export interface ArchitectResult {
  nodes: WorkspaceNode[];
  summary: string;
  ms: number;
}

/**
 * Lexa Arquitecta — given a high-level prompt, generates 3-6 hojas in one
 * shot, positioned on the canvas grid. Returns the created node rows so the
 * canvas can materialize them with a stagger animation.
 */
export async function architectWorkspace(
  workspaceId: string,
  prompt: string,
): Promise<ArchitectResult> {
  const res = await apiFetch<{ ok: true; nodes: WorkspaceNode[]; summary: string; ms: number }>(
    `/${workspaceId}/architect`,
    { method: 'POST', body: JSON.stringify({ prompt }) },
  );
  return { nodes: res.nodes, summary: res.summary, ms: res.ms };
}

// ─── Bulk import sources (sesiones / expedientes → hojas) ───────────

/**
 * Source descriptor for /import-sources. Two shapes:
 *   - id-based (sesion / expediente): server fetches the canonical
 *     source content + metadata before materializing the hoja.
 *   - inline (chat): client passes the assistant message body
 *     directly; server only sanitizes + frames it.
 */
export type ImportSource =
  | { type: 'sesion';     id: string | number }
  | { type: 'expediente'; id: string | number }
  | {
      type: 'chat';
      payload: {
        /** Assistant message HTML or plain text. Required. */
        html: string;
        /** Optional pre-derived title; otherwise server picks one. */
        title?: string;
        /** The user's prompt that produced this response. Renders
         *  as a blockquote above the answer. */
        prompt?: string;
        /** Agent name (Lexa / Otto / etc.) for attribution. */
        agent?: string;
        /** ISO timestamp of when the response landed. */
        timestamp?: string;
      };
    };

export interface ImportSourcesResult {
  nodes: WorkspaceNode[];
  errors: Array<{ source: ImportSource; error: string }>;
}

/**
 * Materialize one hoja per source in the target workspace. Each
 * source's full content (sesión transcript + resumen, or expediente
 * metadata + document list) lands as the new hoja's HTML body.
 *
 * Server caps at 25 sources per call. Partial failures land in
 * `errors` but the call still succeeds (201) as long as at least one
 * node was created.
 */
export async function importSourcesIntoWorkspace(
  workspaceId: string,
  sources: ImportSource[],
): Promise<ImportSourcesResult> {
  const res = await apiFetch<{ ok: true; nodes: WorkspaceNode[]; errors: ImportSourcesResult['errors'] }>(
    `/${workspaceId}/import-sources`,
    { method: 'POST', body: JSON.stringify({ sources }) },
  );
  return { nodes: res.nodes, errors: res.errors ?? [] };
}

// ─── Citations ────────────────────────────────────────────────────────

export async function saveCitation(opts: {
  chunk_id: string;
  source_label?: string;
  excerpt?: string;
  note?: string;
  node_id?: string;
}): Promise<void> {
  await apiFetch('/citations', { method: 'POST', body: JSON.stringify(opts) });
}
