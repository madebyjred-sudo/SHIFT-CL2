import { supabase } from '@/lib/supabase';

type Chunk = { type: string; payload?: unknown };

// Optional binding to a legacy plenaria id. When set, the BFF injects the
// session metadata as a system message — `query` stays clean, and the
// conversation gets tagged so the sidebar can group by session.
// See docs/issues/001-session-scoped-chat-production.md.
export interface ChatScope {
  legacy_session_id?: number;
}

export interface StreamChatOptions {
  agentId: string;
  query: string;
  conversationId?: string;
  deepInsight?: boolean;
  modelOverride?: string;
  scope?: ChatScope;
  onChunk: (chunk: Chunk) => void;
  signal?: AbortSignal;
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

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
      scope: opts.scope,
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
