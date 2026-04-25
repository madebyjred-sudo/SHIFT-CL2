/**
 * Expedientes BFF — our own canonical view of a SIL expediente.
 *
 * Why: ASP.NET WebForms (consultassil3) is stateful — there is no
 * deep-linkable URL per expediente. Instead of dropping users on the
 * SIL search page, we serve the expediente from our own data:
 *   - metadata from sil_expedientes (Supabase)
 *   - attached docs list from sil_documentos
 *   - PDF originals streamed from gs://shift-cl2-sil/docs/<doc.id>.pdf
 *
 * Auth: every endpoint requires a valid Supabase JWT. Service-role on
 * Supabase + bucket-level access on GCS — clients never get the SA.
 */
import { Router, type Request, type Response } from 'express';
import { Storage } from '@google-cloud/storage';
import { getUserIdFromRequest } from '../services/auth.js';
import { getExpedienteById } from '../services/silClient.js';
import { withTimeout } from '../services/resilience.js';

export const expedientesRouter = Router();

const GCS_BUCKET_SIL = process.env.GCS_BUCKET_SIL ?? 'shift-cl2-sil';
const SIGNED_URL_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for the user to click
const STREAM_TIMEOUT_MS = 30_000;

let _storage: Storage | null = null;
function storage(): Storage {
  if (_storage) return _storage;
  _storage = new Storage();
  return _storage;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

/**
 * GET /api/expedientes/:numero
 * Returns the expediente row + docs list. Each doc carries a relative
 * `view_url` that the client can fetch (also gated by JWT).
 */
expedientesRouter.get('/:numero', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const numero = Number(req.params.numero);
  if (!Number.isInteger(numero) || numero <= 0) {
    res.status(400).json({ ok: false, error: 'bad_numero' });
    return;
  }

  try {
    const exp = await getExpedienteById(numero);
    if (!exp) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({
      ok: true,
      expediente: {
        ...exp,
        // Augment each document with the canonical "view this PDF" URL
        // pointing back to our BFF, not to asamblea.go.cr.
        documentos: exp.documentos.map((d) => ({
          ...d,
          view_url: `/api/expedientes/${numero}/docs/${d.id}`,
        })),
      },
    });
  } catch (err) {
    req.log.error('expediente_detail_failed', { error: (err as Error).message, numero });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/expedientes/:numero/docs/:docId
 * Streams the PDF (or HTML) we mirrored to GCS during process-sil-docs.
 * Falls back to a 302 redirect to the original asamblea.go.cr URL when
 * the doc isn't yet mirrored (gcs_path empty) — keeps the link useful
 * even before the embeddings backfill catches up to that expediente.
 */
expedientesRouter.get('/:numero/docs/:docId', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const numero = Number(req.params.numero);
  const docId = String(req.params.docId);
  if (!Number.isInteger(numero) || numero <= 0 || !docId) {
    res.status(400).json({ ok: false, error: 'bad_params' });
    return;
  }

  try {
    const exp = await getExpedienteById(numero);
    if (!exp) {
      res.status(404).json({ ok: false, error: 'expediente_not_found' });
      return;
    }
    // We re-fetch the doc row from the joined result (avoids a second
    // round-trip to Supabase). silClient.getExpedienteById already pulls
    // sil_documentos for this expediente.
    const doc = exp.documentos.find((d) => d.id === docId);
    if (!doc) {
      res.status(404).json({ ok: false, error: 'doc_not_found' });
      return;
    }

    // The doc row has a gcs_path field once process-sil-docs has run for it.
    // Until then, redirect to the asamblea.go.cr source — better than a 404.
    const gcsPath = (doc as unknown as { gcs_path?: string | null }).gcs_path ?? null;
    if (!gcsPath) {
      res.redirect(302, doc.source_url);
      return;
    }

    // gs://bucket/path → bucket + path
    const m = gcsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) {
      req.log.warn('expediente_doc_bad_gcs_path', { docId, gcsPath });
      res.redirect(302, doc.source_url);
      return;
    }
    const [, bucketName, objectPath] = m;
    const file = storage().bucket(bucketName).file(objectPath);

    // Sign a short-lived URL and 302 to it. Keeps the BFF off the data path
    // (no Express stream chunking through our process), gives Google's CDN
    // a chance to cache, and the URL expires after SIGNED_URL_TTL_MS so
    // sharing it accidentally has bounded impact.
    const [signedUrl] = await withTimeout(
      () =>
        file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + SIGNED_URL_TTL_MS,
        }),
      { ms: STREAM_TIMEOUT_MS, label: 'gcs:signed_url' },
    );
    res.redirect(302, signedUrl);
  } catch (err) {
    req.log.error('expediente_doc_failed', { error: (err as Error).message, numero, docId });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
