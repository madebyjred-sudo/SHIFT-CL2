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
export type NodeType =
  | 'hoja'
  | 'note'
  | 'cite'
  | 'expediente_ref'
  | 'image'
  | 'document'
  | 'audio'
  // ─── Generated assets (Atlas exports → first-class canvas citizens) ───
  // These four types are produced by the "Compartir como" toolbar / Atlas
  // chat suggestions. They render with GeneratedAssetNode (NOT AssetNode,
  // which is for IMPORTED files). The discriminator lives on
  // `data.asset_metadata.kind` — the node-type strings here just route the
  // ReactFlow nodeType registry to the right component.
  | 'carousel'
  | 'pptx_asset'
  | 'docx_asset'
  | 'podcast_asset';

/** Asset content shape for type ∈ {image, document, audio}. */
export interface AssetContent {
  url: string;
  path: string;
  filename: string;
  size: number;
  mime: string;
  thumbnail_url?: string;
}

// ─── Generated-asset contracts ────────────────────────────────────────
// Shapes acordadas con el backend agent. El node en ReactFlow lleva esto
// dentro de `data` (no en `content`) para no chocar con el `content.md`
// que usan las hojas.
//
// IMPORTANT: estos tipos son consumidos por GeneratedAssetNode +
// AssetDetailPanel + el flujo de "Compartir como ▾". Si el contrato del
// backend cambia, este es el punto único a refactorizar.

export type GeneratedAssetKind =
  | 'carousel'
  | 'pptx_asset'
  | 'docx_asset'
  | 'podcast_asset';

/** Slide variants — cada slide del carrusel/PPTX puede ser cualquiera de
 *  estos shapes. La discriminación visual la hace el renderer. */
export type AssetSlideKind =
  | 'cover'
  | 'section'
  | 'content'
  | 'comparison'
  | 'quote'
  | 'cta'
  | 'stats'
  | 'list'
  | 'alert';

export interface AssetSlide {
  idx: number;
  kind: AssetSlideKind;
  eyebrow?: string;
  headline: string;
  body?: string;
  items?: Array<{ label: string; value: string; sub?: string }>;
  columns?: Array<{ head: string; title: string; bullets: string[] }>;
  alert?: {
    kind: 'recommendation' | 'warning' | 'note';
    title: string;
    text: string;
  };
  meta?: { footerLeft?: string; footerRight?: string };
}

export interface AssetMetadata {
  kind: GeneratedAssetKind;
  /** Signed URL (GCS/Supabase Storage). The asset's distributable artifact. */
  export_url: string;
  slides_count: number;
  /** ISO timestamp. */
  generated_at: string;
  /** Frozen options the asset was generated with — surfaces in detail panel. */
  options: Record<string, unknown>;
  source: 'atlas' | 'manual';
  /** Optional human title overriding the generic "Carrusel · 8 slides" header. */
  title?: string;
  /** Podcast / audio assets only. Seconds. */
  duration_sec?: number;
}

/** A single slide-edit entry in the per-slide history. */
export interface AssetSlideHistoryEntry {
  slide_idx: number;
  before: Pick<AssetSlide, 'headline' | 'body' | 'items' | 'columns'>;
  after: Pick<AssetSlide, 'headline' | 'body' | 'items' | 'columns'>;
  instruction: string;
  edited_at: string;
}

/** What the frontend reads off `node.data` for generated assets. */
export interface GeneratedAssetData {
  asset_metadata: AssetMetadata;
  asset_slides: AssetSlide[];
  asset_slide_history: AssetSlideHistoryEntry[];
}

/** Shape options shared with the "Compartir como" modal. Kind-specific
 *  fields are loose-typed — backend treats this as a free-form bag. */
export interface ShareAssetOptions {
  /** Tono editorial — neutro/persuasivo/explicativo/etc. */
  tono?: string;
  /** Audiencia objetivo (LinkedIn / prensa / sector financiero / etc). */
  audiencia?: string;
  /** Hook de apertura — solo carrusel/social. */
  hook?: string;
  /** Cantidad de slides — carrusel/pptx. */
  numSlides?: number;
  /** CTA final — carrusel. */
  cta?: string;
  /** Lineamientos de marca / voz. */
  marca?: string;
  /** Permitir emojis (default false). */
  emojis?: boolean;
  /** Propósito — solo pptx (qué argumenta). */
  proposito?: string;
  /** Voz del podcast — sólo podcast. */
  voice?: string;
}

export interface ExportAssetResult {
  ok: true;
  node: WorkspaceNode & { data?: GeneratedAssetData };
  asset: GeneratedAssetData;
}

export interface AssetSlideEditResult {
  ok: true;
  slide: AssetSlide;
  history_entry: AssetSlideHistoryEntry;
}

export interface AssetRegenerateResult {
  ok: true;
  asset: GeneratedAssetData;
}

export interface AssetHistoryResult {
  ok: true;
  history: AssetSlideHistoryEntry[];
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
export interface PptxOptions {
  tono?: string;
  audiencia?: string;
  proposito?: string;
  marca?: string;
  emojis?: boolean;
}

export async function exportWorkspace(
  workspaceId: string,
  format: 'md' | 'docx' | 'pptx',
  workspaceTitle?: string,
  opts?: { force?: boolean; options?: PptxOptions },
): Promise<PptxExportResult | void> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/${workspaceId}/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      format,
      force: opts?.force ?? false,
      ...(opts?.options ? { options: opts.options } : {}),
    }),
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

// ─── Generated assets — share-as / slide-edit / regenerate ────────────
//
// Feature flag controls whether we hit the real backend or the in-memory
// mock fixture. The backend agent is on a parallel track and the contract
// (Gamma-API based with structured AssetSlide[]) is in flight; we ship the
// frontend fully against the mock so the demo lobby can exercise every
// surface, then flip the flag once the API lands.
//
// Override at runtime via:
//   - localStorage.setItem('cl2-generated-assets-mock', '0')  → real API (default)
//   - localStorage.setItem('cl2-generated-assets-mock', '1')  → mock
// Default (when flag absent): respects VITE_GENERATED_ASSETS_MOCK env, else REAL API.
//
// Cambio 2026-05-10: el backend ya converge (commit b191f79 trajo
// /export-asset, /slides/:i/edit, /regenerate-all, /history). Default flippea
// a real para que la demo del lunes 11 arranque contra producción sin que
// nadie tenga que recordar el localStorage.setItem.

const GENERATED_ASSETS_MOCK_KEY = 'cl2-generated-assets-mock';

function isGeneratedAssetsMock(): boolean {
  if (typeof window !== 'undefined') {
    const v = window.localStorage.getItem(GENERATED_ASSETS_MOCK_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  }
  // Vite-style env access; default OFF (real API) ahora que backend converge.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_GENERATED_ASSETS_MOCK === '1') return true;
  return false;
}

/** Generate a new asset and (optionally) drop it on the canvas. */
export async function exportAsset(
  workspaceId: string,
  kind: GeneratedAssetKind,
  options: ShareAssetOptions,
  opts: { sendToCanvas?: boolean } = {},
): Promise<ExportAssetResult> {
  if (isGeneratedAssetsMock()) {
    return mockExportAsset(workspaceId, kind, options, opts);
  }
  return apiFetch<ExportAssetResult>(`/${workspaceId}/export-asset`, {
    method: 'POST',
    body: JSON.stringify({
      kind,
      options,
      sendToCanvas: opts.sendToCanvas ?? true,
    }),
  });
}

/** Edit a single slide of an existing asset. Replaces the slide in place
 *  and appends to the per-slide history. */
export async function editAssetSlide(
  workspaceId: string,
  nodeId: string,
  slideIdx: number,
  instruction: string,
): Promise<AssetSlideEditResult> {
  if (isGeneratedAssetsMock()) {
    return mockEditAssetSlide(workspaceId, nodeId, slideIdx, instruction);
  }
  return apiFetch<AssetSlideEditResult>(
    `/${workspaceId}/assets/${nodeId}/slides/${slideIdx}/edit`,
    { method: 'POST', body: JSON.stringify({ instruction }) },
  );
}

/** Regenerate the entire asset. Per-slide history is conserved. */
export async function regenerateAsset(
  workspaceId: string,
  nodeId: string,
  options: ShareAssetOptions,
): Promise<AssetRegenerateResult> {
  if (isGeneratedAssetsMock()) {
    return mockRegenerateAsset(workspaceId, nodeId, options);
  }
  return apiFetch<AssetRegenerateResult>(
    `/${workspaceId}/assets/${nodeId}/regenerate-all`,
    { method: 'POST', body: JSON.stringify({ options }) },
  );
}

/** Fetch the per-slide edit history for an asset. */
export async function getAssetHistory(
  workspaceId: string,
  nodeId: string,
): Promise<AssetHistoryResult> {
  if (isGeneratedAssetsMock()) {
    return mockGetAssetHistory(workspaceId, nodeId);
  }
  return apiFetch<AssetHistoryResult>(`/${workspaceId}/assets/${nodeId}/history`);
}

// ─── Mock fixture ─────────────────────────────────────────────────────
// In-memory store keyed by nodeId. We seed lazily on first read and
// mutate in place so multiple panel re-mounts share state. Persisting to
// localStorage is overkill for a demo session — a refresh wipes the mock,
// which is actually desirable because the backend agent's real schema
// will eventually own the persistent storage.

type MockStore = Record<string, GeneratedAssetData>;
const _mockStore: MockStore = {};

function makeMockSlides(kind: GeneratedAssetKind, opts: ShareAssetOptions): AssetSlide[] {
  // Demo content tuned to the CL2 universe — reforma fiscal expediente,
  // because that is what Ronald shows clients on Mondays. Each variant
  // hits a different slide.kind so the renderer's branching is exercised.
  const n = opts.numSlides ?? (kind === 'podcast_asset' ? 1 : 8);
  const baseTitle = 'Reforma fiscal 2026 — análisis CL2';
  if (kind === 'podcast_asset') {
    return [{
      idx: 0,
      kind: 'cover',
      eyebrow: 'Audio editorial',
      headline: baseTitle,
      body: 'Lectura narrada del board, con voz de Lexa.',
      meta: { footerLeft: 'CL2 · Audio', footerRight: '14 min' },
    }];
  }
  if (kind === 'docx_asset') {
    return [{
      idx: 0,
      kind: 'cover',
      eyebrow: 'Documento ejecutivo',
      headline: baseTitle,
      body: 'Brief de 6 páginas con resumen, contexto, riesgos y recomendaciones.',
      meta: { footerLeft: 'CL2 · DOCX', footerRight: '6 páginas' },
    }];
  }
  // carousel / pptx_asset — N slides editoriales
  const out: AssetSlide[] = [];
  out.push({
    idx: 0, kind: 'cover',
    eyebrow: 'Reforma fiscal 2026',
    headline: 'Lo que la prensa no leyó del expediente 23.583',
    body: 'Un análisis CL2 del proyecto en discusión. Sin emojis, sin clickbait.',
    meta: { footerLeft: 'CL2 · ' + (kind === 'pptx_asset' ? 'Presentación' : 'Carrusel'), footerRight: '01' },
  });
  out.push({
    idx: 1, kind: 'section',
    eyebrow: 'Contexto',
    headline: 'Por qué 2026 es distinto',
    body: 'Tres factores nuevos: convergencia con OCDE, déficit estructural y narrativa preelectoral.',
  });
  out.push({
    idx: 2, kind: 'stats',
    eyebrow: 'Datos',
    headline: 'El tablero, en números',
    items: [
      { label: 'Recaudación proyectada', value: '+₡640 mil M', sub: 'estimación Hacienda 2026' },
      { label: 'Diputados a favor', value: '28', sub: 'sin contar el bloque B' },
      { label: 'Plazo de comisión', value: '90 días', sub: 'reglamento art. 98' },
    ],
  });
  out.push({
    idx: 3, kind: 'comparison',
    eyebrow: 'Posiciones',
    headline: 'Oficialismo vs. oposición fiscal',
    columns: [
      {
        head: 'Oficialismo',
        title: 'Reforma como ancla',
        bullets: [
          'Alinea con OCDE',
          'Sostiene calificación país',
          'Genera margen para inversión social',
        ],
      },
      {
        head: 'Oposición fiscal',
        title: 'Costo político',
        bullets: [
          'Carga sobre clase media',
          'Mensaje regresivo en año electoral',
          'Falta de gradualidad',
        ],
      },
    ],
  });
  out.push({
    idx: 4, kind: 'quote',
    eyebrow: 'Lo que dijeron',
    headline: '"Sin esta reforma, el gobierno cierra 2026 con un déficit del 5.8%"',
    body: 'Ministerio de Hacienda · Comparecencia 14 abr.',
  });
  out.push({
    idx: 5, kind: 'list',
    eyebrow: 'Riesgos',
    headline: 'Cinco frentes que CL2 monitorea',
    items: [
      { label: '01', value: 'Reservas del bloque B en sala' },
      { label: '02', value: 'Movilización del sector público' },
      { label: '03', value: 'Intervención de Sala IV' },
      { label: '04', value: 'Cobertura de El Financiero / La Nación' },
      { label: '05', value: 'Reacción de gremios empresariales' },
    ],
  });
  out.push({
    idx: 6, kind: 'alert',
    eyebrow: 'Recomendación CL2',
    headline: 'Mover ahora, no en agosto',
    alert: {
      kind: 'recommendation',
      title: 'Lobby anticipado con bloque B',
      text:
        'Las dos enmiendas críticas se firman antes de la última semana de junio. Después, la ventana se cierra por agenda electoral.',
    },
  });
  out.push({
    idx: 7, kind: 'cta',
    eyebrow: 'Conversemos',
    headline: '¿Cómo afecta esto a su sector?',
    body: opts.cta ?? 'cl2.cr · contacto@cl2.cr',
    meta: { footerLeft: 'CL2 · Asuntos públicos', footerRight: String(n).padStart(2, '0') },
  });
  return out.slice(0, n);
}

function mockExportAsset(
  workspaceId: string,
  kind: GeneratedAssetKind,
  options: ShareAssetOptions,
  opts: { sendToCanvas?: boolean },
): Promise<ExportAssetResult> {
  return new Promise((resolve) => {
    // Simulate generation latency — feels like Gamma without being annoying.
    const delay = kind === 'podcast_asset' ? 4500 : 2800;
    setTimeout(() => {
      const slides = makeMockSlides(kind, options);
      const id = `mock-${kind}-${Date.now().toString(36)}`;
      const metadata: AssetMetadata = {
        kind,
        export_url:
          kind === 'docx_asset'
            ? 'https://example.com/mock/cl2-reforma-fiscal.docx'
            : kind === 'pptx_asset'
              ? 'https://example.com/mock/cl2-reforma-fiscal.pptx'
              : kind === 'podcast_asset'
                ? 'https://example.com/mock/cl2-reforma-fiscal.mp3'
                : 'https://example.com/mock/cl2-reforma-fiscal-carrusel.pdf',
        slides_count: slides.length,
        generated_at: new Date().toISOString(),
        options: options as Record<string, unknown>,
        source: 'manual',
        title: 'Reforma fiscal 2026 · CL2',
        duration_sec: kind === 'podcast_asset' ? 14 * 60 : undefined,
      };
      const data: GeneratedAssetData = {
        asset_metadata: metadata,
        asset_slides: slides,
        asset_slide_history: [],
      };
      _mockStore[id] = data;
      const node: WorkspaceNode & { data?: GeneratedAssetData } = {
        id,
        workspace_id: workspaceId,
        type: kind as NodeType,
        x: 80, y: 80, width: 480, height: 380, z_index: 0,
        title: metadata.title ?? labelForKind(kind),
        subtitle: '',
        color: 'default',
        created_at: metadata.generated_at,
        updated_at: metadata.generated_at,
      };
      // Stash the asset data on the node payload — the canvas hydrates it
      // into `node.data` exactly as toRFNode does for the real path.
      (node as { data?: GeneratedAssetData }).data = data;
      resolve({ ok: true, node, asset: data });
    }, delay);
  });
}

function labelForKind(kind: GeneratedAssetKind): string {
  switch (kind) {
    case 'carousel':       return 'Carrusel social';
    case 'pptx_asset':     return 'Presentación';
    case 'docx_asset':     return 'Documento';
    case 'podcast_asset':  return 'Podcast del board';
  }
}

function mockEditAssetSlide(
  _workspaceId: string,
  nodeId: string,
  slideIdx: number,
  instruction: string,
): Promise<AssetSlideEditResult> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const data = _mockStore[nodeId];
      if (!data) {
        reject(new Error('mock: asset not found'));
        return;
      }
      const slide = data.asset_slides.find((s) => s.idx === slideIdx);
      if (!slide) {
        reject(new Error('mock: slide not found'));
        return;
      }
      const before: AssetSlideHistoryEntry['before'] = {
        headline: slide.headline,
        body: slide.body,
        items: slide.items,
        columns: slide.columns,
      };
      // Naive transform: append a marker so the user sees something
      // happened, plus tweak headline so the "before/after" diff has signal.
      slide.headline = applyMockInstruction(slide.headline, instruction);
      if (slide.body) slide.body = applyMockInstruction(slide.body, instruction);
      const after: AssetSlideHistoryEntry['after'] = {
        headline: slide.headline,
        body: slide.body,
        items: slide.items,
        columns: slide.columns,
      };
      const entry: AssetSlideHistoryEntry = {
        slide_idx: slideIdx,
        before,
        after,
        instruction,
        edited_at: new Date().toISOString(),
      };
      data.asset_slide_history.push(entry);
      resolve({ ok: true, slide: { ...slide }, history_entry: entry });
    }, 900);
  });
}

function applyMockInstruction(text: string, instruction: string): string {
  // Intentionally simple — the mock doesn't pretend to be an LLM.
  // Surfaces the instruction so QA can verify the round-trip visually.
  const trimmed = instruction.trim();
  if (!trimmed) return text;
  if (/más cort|acort|conciso|breve/i.test(trimmed)) {
    return text.split(/[.,]/)[0].trim().slice(0, 70);
  }
  if (/más largo|expand|elabor|detall/i.test(trimmed)) {
    return text + ' (con más contexto pedido por el editor: ' + trimmed.slice(0, 60) + '…)';
  }
  return text + ' — ' + trimmed.slice(0, 80);
}

function mockRegenerateAsset(
  workspaceId: string,
  nodeId: string,
  options: ShareAssetOptions,
): Promise<AssetRegenerateResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const prev = _mockStore[nodeId];
      const kind: GeneratedAssetKind = prev?.asset_metadata.kind ?? 'carousel';
      const slides = makeMockSlides(kind, options);
      const newData: GeneratedAssetData = {
        asset_metadata: {
          ...(prev?.asset_metadata ?? {
            kind,
            export_url: '',
            slides_count: slides.length,
            generated_at: new Date().toISOString(),
            options: options as Record<string, unknown>,
            source: 'manual',
          }),
          slides_count: slides.length,
          generated_at: new Date().toISOString(),
          options: options as Record<string, unknown>,
        },
        asset_slides: slides,
        // Conserve prior history per spec
        asset_slide_history: prev?.asset_slide_history ?? [],
      };
      _mockStore[nodeId] = newData;
      // Touch workspaceId param so eslint no-unused stays quiet for the
      // mock branch; in real backend the workspace scopes the auth.
      void workspaceId;
      resolve({ ok: true, asset: newData });
    }, 2000);
  });
}

function mockGetAssetHistory(
  _workspaceId: string,
  nodeId: string,
): Promise<AssetHistoryResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const data = _mockStore[nodeId];
      resolve({ ok: true, history: data?.asset_slide_history ?? [] });
    }, 200);
  });
}

/** Public helper so callers (e.g. the canvas) can hydrate a freshly-
 *  generated mock asset back into the in-memory store after a reload. */
export function _seedMockAsset(nodeId: string, data: GeneratedAssetData): void {
  _mockStore[nodeId] = data;
}
