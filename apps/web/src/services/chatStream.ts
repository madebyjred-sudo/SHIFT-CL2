/**
 * chatStream — streaming chat service layer.
 *
 * Exports:
 *   • streamChat            — existing /api/chat/stream path (session + general chat).
 *   • streamWorkspaceTurn   — NEW /api/workspace/:id/turn path (intent-routed workspace chat).
 *
 * ChatScope is imported from @/lib/chat-context (single source of truth).
 * The old local interface declaration has been removed.
 */
import { supabase } from '@/lib/supabase';
import type { ChatScope } from '@/lib/chat-context';

type Chunk = { type: string; payload?: unknown };

/**
 * A workspace turn can return a special chunk type when the server resolves
 * the intent to 'build' or 'edit_*' (JSON response, not SSE stream).
 * The `workspace_action` chunk surfaces the server payload to the parent.
 */
export type ChatChunk =
  | { type: 'token'; payload: string }
  | { type: 'citation'; payload: unknown }
  | { type: 'conversation'; payload: unknown }
  | { type: 'confidence'; payload: unknown }
  | { type: 'error'; payload: unknown }
  | { type: 'done'; payload?: unknown }
  | { type: 'workspace_action'; payload: WorkspaceActionPayload }
  | { type: 'pptx_status'; payload: { status: 'starting' | 'polling' | 'error'; code?: string; detail?: string } }
  | { type: 'pptx_ready'; payload: PptxReadyPayload }
  // Atlas-side share suggestion chips (Lovable-style). When the user
  // talks about social/LinkedIn/decks/etc., the agent can attach 1-3
  // suggestions to its reply. Frontend renders them inline; click =
  // opens the ShareAs options modal pre-selected to that kind.
  | { type: 'suggestion'; payload: ChatSuggestionPayload };

export interface ChatSuggestionPayload {
  suggestions: Array<{
    kind: 'carousel' | 'pptx_asset' | 'docx_asset' | 'podcast_asset';
    label: string;
    reason?: string;
  }>;
}

export interface PptxReadyPayload {
  filename: string;
  url: string;
  gammaUrl: string;
  generationId: string;
  cached: boolean;
  generatedAt?: string;
}

export interface WorkspaceActionPayload {
  intent: 'build' | 'edit_selected' | 'edit_by_match' | 'pptx';
  ok: boolean;
  nodes?: import('@/services/workspaceApi').WorkspaceNode[];
  node_id?: string;
  new_content?: string;
  target_match_confidence?: number;
  // pptx-specific fields, populated when intent='pptx'
  url?: string;
  gammaUrl?: string;
  filename?: string;
  generationId?: string;
  cached?: boolean;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  agentId: string;
  query: string;
  conversationId?: string;
  deepInsight?: boolean;
  modelOverride?: string;
  scope?: ChatScope;
  /** Prior turns in this conversation. Pass the messages array (excluding
   *  the current pending turn) so the model has continuity. Server caps
   *  the count downstream (~20). */
  history?: ChatHistoryMessage[];
  onChunk: (chunk: Chunk) => void;
  signal?: AbortSignal;
}

async function getAuthToken(): Promise<string | undefined> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token;
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const token = await getAuthToken();

  // Forward the scope to the BFF.
  // - session scope → legacy_session_id (drives sessionContextLoader)
  // - workspace scope → workspace_id (unlocks Atlas's generate_presentation tool)
  const scopePayload =
    opts.scope?.kind === 'session'
      ? { legacy_session_id: opts.scope.legacy_session_id }
      : opts.scope?.kind === 'workspace'
      ? { workspace_id: opts.scope.workspace_id }
      : undefined;

  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      agent_id: opts.agentId,
      query: opts.query,
      conversation_id: opts.conversationId,
      deep_insight: opts.deepInsight ?? false,
      model_override: opts.modelOverride,
      scope: scopePayload,
      history: opts.history ?? [],
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat stream failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed: Chunk = JSON.parse(payload);
        opts.onChunk(parsed);
        if (parsed.type === 'done') return;
      } catch {
        // ignore malformed
      }
    }
  }
}

// ─── Workspace turn ───────────────────────────────────────────────────────────

export interface StreamWorkspaceTurnArgs {
  workspaceId: string;
  query: string;
  /** 2026-04-28: el agent picker del workspace solo expone Lexa+Atlas.
   *  Cuando se manda este field, el backend deriva el intent del agente
   *  + estado de selección — Lexa→chat, Atlas→build|edit_selected. El
   *  classifier se saltea. Ver docs/AGENTS.md §Atlas. */
  agentId?: 'lexa' | 'atlas';
  selectedNodeId: string | null;
  hojaTitles: Array<{ id: string; title: string; subtitle?: string | null }>;
  deepInsight: boolean;
  /** Legacy fields — deprecated en favor de agentId, mantenidos para
   *  back-compat si algún caller no migró. El backend prioriza agentId. */
  mode?: 'auto' | 'manual';
  forcedIntent?: 'chat' | 'build' | 'edit_selected' | 'edit_by_match';
  /** Prior turns in this workspace's chat. Same contract as streamChat. */
  history?: ChatHistoryMessage[];
  signal?: AbortSignal;
  onChunk: (chunk: ChatChunk) => void;
  onIntent?: (info: {
    intent: string;
    intent_confidence?: number;
    target_node_id?: string | null;
  }) => void;
}

/**
 * streamWorkspaceTurn — sends a turn to /api/workspace/:id/turn.
 *
 * The server can respond in two ways:
 *   • SSE (text/event-stream) when intent='chat'. First event is an optional
 *     `event: meta` line with intent info, then OpenAI-compatible data chunks,
 *     ending with `data: [DONE]`.
 *   • JSON when intent is 'build' | 'edit_selected' | 'edit_by_match'. We
 *     detect by content-type, fire onIntent, and surface via workspace_action
 *     chunk so the parent (WorkspaceCanvasPage) can handle node mutations.
 */
export async function streamWorkspaceTurn(args: StreamWorkspaceTurnArgs): Promise<void> {
  const token = await getAuthToken();

  const res = await fetch(`/api/workspace/${args.workspaceId}/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      query: args.query,
      agent_id: args.agentId,
      selected_node_id: args.selectedNodeId,
      hoja_titles: args.hojaTitles,
      deep_insight: args.deepInsight,
      // Legacy mode/forced_intent — solo se mandan si están presentes
      // (back-compat con callers que no migraron a agent_id).
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.forcedIntent ? { forced_intent: args.forcedIntent } : {}),
      history: args.history ?? [],
    }),
    signal: args.signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(`Workspace turn failed: ${msg}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  // ── JSON response (build / edit) ─────────────────────────────────────
  if (!contentType.includes('text/event-stream')) {
    const body = await res.json() as Record<string, unknown>;
    const intent = (body.intent as string) ?? 'build';
    args.onIntent?.({
      intent,
      intent_confidence: body.intent_confidence as number | undefined,
      target_node_id: body.target_node_id as string | null | undefined,
    });
    args.onChunk({
      type: 'workspace_action',
      payload: body as WorkspaceActionPayload,
    });
    return;
  }

  // ── SSE stream (chat) ─────────────────────────────────────────────────
  if (!res.body) throw new Error('No response body for SSE stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let metaFired = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split on double newline (SSE event boundary)
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const evt of events) {
      const lines = evt.trim().split('\n');
      // Check for named event (e.g. "event: meta")
      const eventLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
      const payload = dataLine ? dataLine.slice(5).trim() : '';

      if (!payload) continue;

      // ── meta event — intent routing info ──────────────────────────────
      if (eventName === 'meta' && !metaFired) {
        metaFired = true;
        try {
          const meta = JSON.parse(payload) as {
            intent?: string;
            intent_confidence?: number;
            target_node_id?: string | null;
          };
          args.onIntent?.({
            intent: meta.intent ?? 'chat',
            intent_confidence: meta.intent_confidence,
            target_node_id: meta.target_node_id,
          });
        } catch { /* ignore malformed */ }
        continue;
      }

      // ── data events — OpenAI-compatible token stream ──────────────────
      if (payload === '[DONE]') return;

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          delta?: { text?: string };
          type?: string;
          payload?: unknown;
        };

        // Standard OpenAI chunk
        const tokenText =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.delta?.text ??
          '';
        if (tokenText) {
          args.onChunk({ type: 'token', payload: tokenText });
          continue;
        }

        // Fall through: the server might also emit structured chunks
        // (citation, confidence, error, done) in the same format as /chat/stream.
        if (parsed.type) {
          args.onChunk(parsed as ChatChunk);
          if (parsed.type === 'done') return;
        }
      } catch {
        // ignore malformed
      }
    }
  }
}
