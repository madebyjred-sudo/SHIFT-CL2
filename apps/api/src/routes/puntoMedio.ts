/**
 * Punto Medio admin routes — review queue + bulk approve/reject.
 *
 * Wraps cerebro's /punto-medio/review* endpoints behind our JWT-gated
 * BFF. Frontend at /admin/punto-medio renders a simple table where the
 * operator (Juanma pre-demo) reviews each pending consolidation/pattern
 * before it can be injected into Lexa/Atlas system prompts.
 *
 * Auth: every endpoint requires Supabase JWT. There's no separate "admin
 * role" check yet — for the CL2 demo, every authenticated user is
 * effectively an admin (Oscar's team is small + closed). When we open
 * the platform to outside tenants, gate this on a dedicated claim.
 */
import { Router, type Request, type Response } from 'express';
import { getUserIdFromRequest } from '../services/auth.js';
import {
  listPendingReviews,
  reviewItem,
  invalidateRagCache,
} from '../services/puntoMedioClient.js';
import { auditFromReq } from '../services/auditLog.js';

export const puntoMedioRouter = Router();

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

/**
 * GET /api/punto-medio/pending
 * Lists pending consolidations + patterns awaiting human review.
 * Returns shape: { pending_consolidations, pending_patterns, ...counts }.
 */
puntoMedioRouter.get('/pending', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const bundle = await listPendingReviews();
    res.json({ ok: true, ...bundle });
  } catch (err) {
    req.log.error('punto_medio_list_failed', { error: (err as Error).message });
    res.status(502).json({
      ok: false,
      error: 'cerebro_unavailable',
      detail: 'no se pudo conectar a Punto Medio en Cerebro',
      request_id: req.requestId,
    });
  }
});

/**
 * POST /api/punto-medio/review/:id
 * Body: { action: 'approve' | 'reject', item_type: 'consolidation' | 'pattern' }
 * Idempotent — re-clicking approve on an already-approved item is a no-op
 * upstream. Invalidates the in-process RAG cache so the next chat turn
 * sees the change immediately.
 */
puntoMedioRouter.post('/review/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'bad_id' });
    return;
  }

  const body = (req.body ?? {}) as { action?: string; item_type?: string };
  const action = body.action;
  const itemType = body.item_type;
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action_must_be_approve_or_reject' });
    return;
  }
  if (itemType !== 'consolidation' && itemType !== 'pattern') {
    res.status(400).json({ ok: false, error: 'item_type_must_be_consolidation_or_pattern' });
    return;
  }

  try {
    const result = await reviewItem(id, {
      action,
      reviewed_by: userId,
      item_type: itemType,
    });
    invalidateRagCache();
    req.log.info('punto_medio_reviewed', { id, action, itemType, userId });

    // Audit log uses editorial verbs ("publicó / archivó lineamiento")
    // — the underlying tables stay called consolidations/patterns but
    // the operator-facing log mirrors the curaduría narrative.
    await auditFromReq(req, {
      verb: action === 'approve' ? 'publicó' : 'archivó',
      resource: `lineamiento #${id}`,
      resource_kind: 'editorial_guideline',
      resource_id: String(id),
      result: 'ok',
      metadata: {
        // Keep the engineering shape in the metadata blob for ops
        // forensics, but it's never surfaced in the Auditoría UI.
        item_kind: itemType,
        backing: 'punto_medio',
      },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error('punto_medio_review_failed', { error: (err as Error).message, id, action });
    await auditFromReq(req, {
      verb: action === 'approve' ? 'publicó' : 'archivó',
      resource: `lineamiento #${id}`,
      resource_kind: 'editorial_guideline',
      resource_id: String(id),
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(502).json({
      ok: false,
      error: 'cerebro_unavailable',
      request_id: req.requestId,
    });
  }
});
