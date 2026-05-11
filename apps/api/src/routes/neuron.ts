/**
 * /api/neuron — BFF proxy for the per-user Cerebro neuron.
 *
 * Why a proxy rather than letting the SPA hit Cerebro directly:
 *   1. The `x-shift-internal-token` is a server-side secret. End users
 *      MUST NOT see it. Exposing the Cerebro URL without auth would let
 *      anyone read anyone's neuron.
 *   2. The user_id sent to Cerebro is the canonical email, which we
 *      derive from the verified Supabase JWT on this side — the SPA
 *      never gets to choose whose neuron it reads.
 *   3. realm is hardcoded to "cl2" so the SPA can't accidentally (or
 *      maliciously) ask for the Shift realm.
 *
 * Endpoints map 1:1 onto Cerebro:
 *   GET    /api/neuron               → list files
 *   GET    /api/neuron/file?path=X   → read file content
 *   PATCH  /api/neuron/file          → write file (body: {path, content})
 *   DELETE /api/neuron/file?path=X   → delete file or prefix
 *   GET    /api/neuron/history       → write audit log
 *
 * Everything degrades gracefully on Cerebro failure (returns ok:false
 * but never 5xx — frontend's "Mi memoria" panel just shows empty).
 */
import { Router, type Request, type Response } from 'express';
import { getUserFromRequest } from '../services/auth.js';
import {
  listNeuron,
  readNeuronFile,
  writeNeuronFile,
  deleteNeuronFile,
  neuronHistory,
} from '../services/cerebroNeuron.js';

export const neuronRouter = Router();

async function requireUserEmail(req: Request, res: Response): Promise<string | null> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  if (!user.email) {
    // A Supabase user without an email is theoretically possible (phone-only
    // auth), but our auth flow forces email — surfacing the case explicitly
    // makes debugging easier if it ever appears in production logs.
    res.status(400).json({ ok: false, error: 'user_email_missing' });
    return null;
  }
  return user.email;
}

// ─── List ────────────────────────────────────────────────────────────
// GET /api/neuron — list files + size_bytes + updated_at for current user.
neuronRouter.get('/', async (req, res) => {
  const email = await requireUserEmail(req, res);
  if (!email) return;
  const listing = await listNeuron(email);
  if (!listing) {
    res.json({ ok: true, file_count: 0, files: [], total_bytes: 0 });
    return;
  }
  res.json({ ok: true, ...listing });
});

// ─── Read ────────────────────────────────────────────────────────────
// GET /api/neuron/file?path=/memories/notes.md — content of one file.
neuronRouter.get('/file', async (req, res) => {
  const email = await requireUserEmail(req, res);
  if (!email) return;
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) {
    res.status(400).json({ ok: false, error: 'path required' });
    return;
  }
  const file = await readNeuronFile(email, path);
  if (!file) {
    res.status(404).json({ ok: false, error: 'file_not_found' });
    return;
  }
  res.json({ ok: true, ...file });
});

// ─── Write ───────────────────────────────────────────────────────────
// PATCH /api/neuron/file  body: { path, content } — user edit / save.
// Soft-validated for the obvious mistakes; Cerebro side does the real
// quota and PII checks. We just keep the request from being unbounded.
neuronRouter.patch('/file', async (req, res) => {
  const email = await requireUserEmail(req, res);
  if (!email) return;

  const body = (req.body ?? {}) as { path?: string; content?: string };
  if (!body.path || typeof body.path !== 'string') {
    res.status(400).json({ ok: false, error: 'path required' });
    return;
  }
  if (typeof body.content !== 'string') {
    res.status(400).json({ ok: false, error: 'content must be string' });
    return;
  }
  // Hard cap — Cerebro enforces 50KB/file but rejecting here gives a
  // friendlier error to the SPA than waiting for the upstream 413.
  if (body.content.length > 50_000) {
    res.status(413).json({ ok: false, error: 'file_too_large', limit: 50_000 });
    return;
  }
  const ok = await writeNeuronFile(email, body.path, body.content);
  if (!ok) {
    res.status(502).json({ ok: false, error: 'cerebro_write_failed' });
    return;
  }
  res.json({ ok: true });
});

// ─── Delete ──────────────────────────────────────────────────────────
// DELETE /api/neuron/file?path=X — delete one file or every file under
// a prefix (e.g. path=/memories empties the whole drawer). No undo.
neuronRouter.delete('/file', async (req, res) => {
  const email = await requireUserEmail(req, res);
  if (!email) return;
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) {
    res.status(400).json({ ok: false, error: 'path required' });
    return;
  }
  const ok = await deleteNeuronFile(email, path);
  if (!ok) {
    res.status(502).json({ ok: false, error: 'cerebro_delete_failed' });
    return;
  }
  res.json({ ok: true });
});

// ─── History ─────────────────────────────────────────────────────────
// GET /api/neuron/history?limit=50 — audit log of writes, newest first.
neuronRouter.get('/history', async (req, res) => {
  const email = await requireUserEmail(req, res);
  if (!email) return;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' ? Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50)) : 50;
  const items = await neuronHistory(email, limit);
  res.json({ ok: true, items });
});
