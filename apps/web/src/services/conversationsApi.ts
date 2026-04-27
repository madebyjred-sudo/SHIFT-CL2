/**
 * conversationsApi — server-backed chat history.
 *
 * Backed by the BFF route /api/conversations (which reads the
 * `conversations` + `messages` Supabase tables created in migration 0001).
 *
 * Why this exists: the chat sidebar used to be localStorage-only, which
 * silently broke for multi-device users and anyone clearing cache. Every
 * chat turn IS persisted server-side — this client simply lets the UI
 * read what's already there.
 *
 * Design notes:
 *   - We DON'T fetch messages with the list call (kept light for the
 *     sidebar). Messages are lazy-loaded when the user opens a thread.
 *   - The shape returned matches what ChatSession on the client expects,
 *     plus a few enrichments for previews. The chat-context provider
 *     does the final mapping to ChatSession.
 */
import { supabase } from '@/lib/supabase';
import type { Message, ChunkCitation, Confidence } from '@/lib/chat-context';

const BASE = '/api/conversations';

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

/**
 * Wire shape for a single conversation row in the sidebar list.
 * Matches the BFF's GET /api/conversations response.
 */
export interface ConversationListItem {
  id: string;
  agent_id: string;
  title: string;
  last_user_preview: string | null;
  last_assistant_preview: string | null;
  message_count: number;
  scope_legacy_session_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Wire shape for a single message row. Maps 1:1 to the `messages` DB
 * table; the `citations` field is JSONB and may be null or [].
 */
export interface ServerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent_id: string | null;
  model: string | null;
  deep_insight: boolean;
  citations: ChunkCitation[] | null;
  confidence: { score: number; level: 'high' | 'medium' | 'low'; rationale: string } | null;
  created_at: string;
}

// ─── List ────────────────────────────────────────────────────────────

export async function listConversations(opts: {
  limit?: number;
  offset?: number;
  scope?: 'all' | 'general' | 'session';
} = {}): Promise<ConversationListItem[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.scope) params.set('scope', opts.scope);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch<{ ok: true; items: ConversationListItem[] }>(`/${qs}`);
  return res.items;
}

// ─── Messages ────────────────────────────────────────────────────────

export async function getConversationMessages(id: string): Promise<ServerMessage[]> {
  const res = await apiFetch<{ ok: true; messages: ServerMessage[] }>(`/${id}/messages`);
  return res.messages;
}

/**
 * Convert a server message row into the client's Message shape.
 * The chat-context's reducer expects this exact shape — keep it in
 * sync if Message ever grows new fields.
 */
export function serverMessageToClient(m: ServerMessage): Message {
  return {
    id: m.id,
    role: m.role === 'system' ? 'assistant' : m.role,  // sidebar collapses system into assistant
    content: m.content,
    agent: (m.agent_id as Message['agent']) ?? undefined,
    model: (m.model as Message['model']) ?? undefined,
    deepInsight: m.deep_insight,
    citations: m.citations ?? undefined,
    confidence: (m.confidence as Confidence | null) ?? undefined,
  };
}

// ─── Mutations ───────────────────────────────────────────────────────

export async function renameConversation(id: string, title: string): Promise<void> {
  await apiFetch(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/${id}`, { method: 'DELETE' });
}
