/**
 * Conversation persistence — writes to public.conversations + public.messages.
 *
 * Uses service-role client (bypasses RLS). All authorization happens upstream
 * via the JWT-derived userId — never trust a userId that didn't come from a
 * verified Supabase session token.
 *
 * Title heuristic: first 60 chars of the user's opening question. Can be
 * upgraded later (e.g. LLM-generated summary), but a deterministic snippet
 * is enough for the sidebar list and avoids extra latency on first turn.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withRetry, withTimeout } from './resilience.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set (conversationStore)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

const SUPA_TIMEOUT_MS = 5_000;

export interface CitationRow {
  id: string;
  session_id: string;
  source_ref: string;
  content: string;
  similarity: number;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  video_url: string | null;
  transcript_url: string | null;
}

interface EnsureArgs {
  userId: string;
  conversationId?: string | null;
  agentId: string;
  firstUserMessage: string;
  // Optional binding to a legacy plenaria id. When set on a NEW conversation
  // it gets persisted as `conversations.scope_legacy_session_id`. When set
  // alongside an existing `conversationId`, ownership/scope are verified —
  // a scoped request must not land on an unscoped (or differently-scoped)
  // thread, otherwise the sidebar grouping breaks.
  scopeLegacySessionId?: number | null;
}

interface EnsureResult {
  id: string;
  isNew: boolean;
  scopeLegacySessionId: number | null;
}

function snippetTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 60) return trimmed || 'Nueva conversación';
  return `${trimmed.slice(0, 57)}…`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ensureConversation(args: EnsureArgs): Promise<EnsureResult> {
  const scope = args.scopeLegacySessionId ?? null;

  // Frontend may pass a local-timestamp id from legacy localStorage state.
  // Treat anything that isn't a real UUID as "create new" — avoids a Postgres
  // "invalid input syntax for type uuid" error on lookup.
  if (args.conversationId && UUID_RE.test(args.conversationId)) {
    // Verify ownership before reusing — service role bypasses RLS so we must
    // double-check the conversation belongs to this user. Idempotent SELECT,
    // so retry on transient supabase blips (network glitch, cold reconnect).
    const lookup = await withRetry(
      () =>
        withTimeout(
          async (signal) => {
            const r = await supa()
              .from('conversations')
              .select('id, user_id, scope_legacy_session_id')
              .eq('id', args.conversationId!)
              .abortSignal(signal)
              .maybeSingle();
            if (r.error) throw new Error(r.error.message);
            return r.data;
          },
          { ms: SUPA_TIMEOUT_MS, label: 'supabase:conv_lookup' },
        ),
      { attempts: 2, baseDelayMs: 200, label: 'supabase:conv_lookup' },
    );
    if (lookup && lookup.user_id === args.userId) {
      const existingScope: number | null = lookup.scope_legacy_session_id ?? null;
      // Scope mismatch: caller is sending from /sesiones/X into a conversation
      // that belongs to a different (or no) session. Spawn a fresh thread
      // rather than mixing — keeps sidebar grouping honest.
      if (existingScope !== scope) {
        // Fall through to create.
      } else {
        // Touch updated_at so the sidebar reorders correctly. Best-effort —
        // a timeout here shouldn't block the chat turn (we already have the
        // conversation id, the worst case is a slightly stale sidebar).
        try {
          await withTimeout(
            async (signal) => {
              const r = await supa()
                .from('conversations')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', args.conversationId!)
                .abortSignal(signal);
              if (r.error) throw new Error(r.error.message);
            },
            { ms: SUPA_TIMEOUT_MS, label: 'supabase:conv_touch' },
          );
        } catch (err) {
          console.warn(`[conversationStore] touch failed: ${(err as Error).message}`);
        }
        return {
          id: args.conversationId,
          isNew: false,
          scopeLegacySessionId: existingScope,
        };
      }
    }
    // Fall through to create — id was stale, didn't belong to user, or scope mismatch.
  }

  // INSERT is intentionally NOT retried — a partial failure could create
  // duplicate conversation rows. Timeout protects against hangs.
  const inserted = await withTimeout(
    async (signal) => {
      const r = await supa()
        .from('conversations')
        .insert({
          user_id: args.userId,
          agent_id: args.agentId,
          title: snippetTitle(args.firstUserMessage),
          scope_legacy_session_id: scope,
        })
        .select('id, scope_legacy_session_id')
        .abortSignal(signal)
        .single();
      if (r.error || !r.data) throw new Error(`conversation insert: ${r.error?.message}`);
      return r.data;
    },
    { ms: SUPA_TIMEOUT_MS, label: 'supabase:conv_insert' },
  );
  return {
    id: inserted.id,
    isNew: true,
    scopeLegacySessionId: inserted.scope_legacy_session_id ?? null,
  };
}

export async function insertUserMessage(
  conversationId: string,
  content: string,
): Promise<void> {
  await withTimeout(
    async (signal) => {
      const r = await supa()
        .from('messages')
        .insert({
          conversation_id: conversationId,
          role: 'user',
          content,
        })
        .abortSignal(signal);
      if (r.error) throw new Error(`user message insert: ${r.error.message}`);
    },
    { ms: SUPA_TIMEOUT_MS, label: 'supabase:msg_user_insert' },
  );
}

interface AssistantArgs {
  conversationId: string;
  content: string;
  agentId: string;
  model?: string;
  deepInsight: boolean;
  citations: CitationRow[];
  confidence?: number | null;
}

export async function insertAssistantMessage(args: AssistantArgs): Promise<void> {
  await withTimeout(
    async (signal) => {
      const r = await supa()
        .from('messages')
        .insert({
          conversation_id: args.conversationId,
          role: 'assistant',
          content: args.content,
          agent_id: args.agentId,
          model: args.model ?? null,
          deep_insight: args.deepInsight,
          citations: args.citations.length > 0 ? args.citations : null,
          confidence: args.confidence ?? null,
        })
        .abortSignal(signal);
      if (r.error) throw new Error(`assistant message insert: ${r.error.message}`);
    },
    { ms: SUPA_TIMEOUT_MS, label: 'supabase:msg_assistant_insert' },
  );
}
