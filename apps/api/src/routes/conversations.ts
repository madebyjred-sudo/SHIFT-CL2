/**
 * Conversations API — read access to the chat history persisted in
 * `conversations` and `messages` (migrations 0001 + 0003).
 *
 * Why this exists: the BFF has been writing every chat turn to Supabase
 * since day one (see services/conversationStore.ts), but the frontend
 * sidebar only reads from localStorage. That breaks for users on a new
 * machine, an incognito session, or after they clear cache. This router
 * closes the loop so the sidebar hydrates from the server.
 *
 * Endpoints:
 *   GET    /api/conversations               → list (newest first), paginated
 *   GET    /api/conversations/:id           → single conversation metadata
 *   GET    /api/conversations/:id/messages  → all messages of a thread
 *   PATCH  /api/conversations/:id           → rename (title only)
 *   DELETE /api/conversations/:id           → cascade-deletes messages too
 *
 * RLS already filters by user_id = auth.uid() at the DB level, but we also
 * gate at the route layer with requireUser() and ownedConversation()
 * (defense in depth + better error messages than RLS' silent empty rows).
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';

export const conversationsRouter = Router();

// ─── Supabase singleton (service-role) ───────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) { res.status(401).json({ ok: false, error: 'auth_required' }); return null; }
  return userId;
}

async function ownedConversation(userId: string, id: string, res: Response): Promise<boolean> {
  const { data, error } = await supa()
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    res.status(404).json({ ok: false, error: 'conversation_not_found' });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// GET /api/conversations
// ═══════════════════════════════════════════════════════════════════════
//
// Returns conversations in (updated_at desc) order with enrichments useful
// for the sidebar:
//   - title (from row, or fallback to first user message preview)
//   - last_message_preview (last assistant message excerpt, truncated)
//   - message_count
//   - scope_legacy_session_id (for grouping "Sesión #N" chats)
//
// Query params:
//   ?limit  default 100, max 500
//   ?offset default 0
//   ?scope  'all' | 'general' | 'session' | 'workspace' (default all)
//             'session' → only conversations bound to a plenaria
//             'general' → only conversations without scope
//
// Response shape designed to drop straight into ChatSession[] on the
// client with minimal massaging.
conversationsRouter.get('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const scope = String(req.query.scope ?? 'all');

  try {
    let q = supa()
      .from('conversations')
      .select('id, agent_id, title, scope_legacy_session_id, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (scope === 'session') q = q.not('scope_legacy_session_id', 'is', null);
    if (scope === 'general') q = q.is('scope_legacy_session_id', null);

    const { data: convs, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    const conversations = convs ?? [];

    // For sidebar previews + counts: pull message metadata in one batch.
    // We intentionally fetch only what we need (no full content) to keep
    // payload small. The "last user message preview" gives a richer hint
    // than the auto-title ("Nueva conversación") in most cases.
    const ids = conversations.map((c) => c.id as string);
    const previewMap: Record<string, { last_user: string | null; last_assistant: string | null; count: number }> = {};
    if (ids.length > 0) {
      const { data: msgs, error: mErr } = await supa()
        .from('messages')
        .select('conversation_id, role, content, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: true });
      if (mErr) throw new Error(mErr.message);

      for (const m of msgs ?? []) {
        const cid = m.conversation_id as string;
        if (!previewMap[cid]) previewMap[cid] = { last_user: null, last_assistant: null, count: 0 };
        previewMap[cid].count += 1;
        if (m.role === 'user') previewMap[cid].last_user = m.content as string;
        else if (m.role === 'assistant') previewMap[cid].last_assistant = m.content as string;
      }
    }

    const truncate = (s: string | null, n = 120) => s ? (s.length > n ? s.slice(0, n) + '…' : s) : null;

    const items = conversations.map((c) => {
      const prev = previewMap[c.id as string] ?? { last_user: null, last_assistant: null, count: 0 };
      return {
        id: c.id,
        agent_id: c.agent_id,
        title: c.title || truncate(prev.last_user, 60) || 'Nueva conversación',
        last_user_preview: truncate(prev.last_user),
        last_assistant_preview: truncate(prev.last_assistant),
        message_count: prev.count,
        scope_legacy_session_id: c.scope_legacy_session_id,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    });

    res.json({ ok: true, items, limit, offset });
  } catch (err) {
    req.log?.warn('conversations/list failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/conversations/:id
// ═══════════════════════════════════════════════════════════════════════
//
// Single conversation metadata only — no messages. Used when we want to
// validate ownership before kicking off a heavier messages fetch, or to
// rehydrate a sidebar entry that was lost.
conversationsRouter.get('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  try {
    const { data, error } = await supa()
      .from('conversations')
      .select('id, agent_id, title, scope_legacy_session_id, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) { res.status(404).json({ ok: false, error: 'conversation_not_found' }); return; }
    res.json({ ok: true, conversation: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/conversations/:id/messages
// ═══════════════════════════════════════════════════════════════════════
//
// All messages of a thread, oldest first. Conversations are typically
// short (<100 turns) so we don't paginate by default; pass ?limit/?offset
// if a thread really gets long.
conversationsRouter.get('/:id/messages', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedConversation(userId, id, res)) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 2000);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  try {
    const { data, error } = await supa()
      .from('messages')
      .select('id, role, content, agent_id, model, deep_insight, citations, confidence, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    res.json({ ok: true, messages: data ?? [], limit, offset });
  } catch (err) {
    req.log?.warn('conversations/messages failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH /api/conversations/:id  body: { title }
// ═══════════════════════════════════════════════════════════════════════
//
// Rename a conversation. Title cap is 200 chars (matches DB constraint
// implicitly via text). No other fields editable through this route.
conversationsRouter.patch('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : null;
  if (!title) { res.status(400).json({ ok: false, error: 'title_required' }); return; }

  try {
    const { data, error } = await supa()
      .from('conversations')
      .update({ title })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, title, updated_at')
      .single();
    if (error || !data) { res.status(404).json({ ok: false, error: 'conversation_not_found' }); return; }
    res.json({ ok: true, conversation: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DELETE /api/conversations/:id
// ═══════════════════════════════════════════════════════════════════════
//
// Hard delete; messages cascade via FK ON DELETE CASCADE in 0001_init.sql.
// This is destructive — the frontend should confirm before calling.
conversationsRouter.delete('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  try {
    const { error } = await supa()
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
