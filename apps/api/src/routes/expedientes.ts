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
 *
 * Endpoints:
 *   GET /:numero          — legacy single-doc view (integer id)
 *   GET /:numero/full     — NEW: unified dashboard, all detail tables
 *                           in one round-trip (Track B Sprint 1)
 *   GET /:numero/docs/:id — PDF proxy / GCS signed URL
 */
import { Router, type Request, type Response } from 'express';
import { Storage } from '@google-cloud/storage';
import { getUserIdFromRequest } from '../services/auth.js';
import { getExpedienteById } from '../services/silClient.js';
import { withTimeout } from '../services/resilience.js';
import { createClient } from '@supabase/supabase-js';

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

function getSupabase() {
  // El repo usa NEXT_PUBLIC_SUPABASE_URL (Vite + Next prefix) en .env.local y
  // en Cloud Run. SUPABASE_URL no existe — fix 2026-05-15 después de smoke
  // del Sprint v3 con Playwright (devolvía http 500 al frontend).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}

/**
 * GET /api/expedientes/:numero/full
 *
 * Unified dashboard endpoint — all detail tables in one round-trip.
 * Used by ExpedienteDashboardPage (Track B, Sprint 1).
 *
 * The `:numero` param accepts both the integer id (e.g. "23511") and the
 * dot-formatted numero (e.g. "23.511") — we look up sil_expedientes by
 * the `numero` text field to normalise.
 *
 * Returns an empty array (not 404) for tables that have no rows yet —
 * the frontend shows empty states until the scraper backfill runs.
 */
expedientesRouter.get('/:numero/full', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  // Accept "23511" (integer form from old links) or "23.511" (SIL canonical).
  const rawNumero = req.params.numero;
  // Normalise: if no dot and pure digits, convert "23511" → "23.511" style.
  // The DB stores the dot-formatted numero as the FK. The integer `id` field
  // is a separate column. We query by `numero` (text) for new tables and by
  // `id` (int) for the old sil_expedientes table.
  const isInt = /^\d+$/.test(rawNumero);
  const supClientRaw = getSupabase();

  try {
    // Resolve the expediente: accept both id (int) and numero (text).
    const generalQuery = isInt
      ? supClientRaw.from('sil_expedientes').select('*').eq('id', Number(rawNumero)).single()
      : supClientRaw.from('sil_expedientes').select('*').eq('numero', rawNumero).single();

    const { data: general, error: generalErr } = await generalQuery;

    if (generalErr || !general) {
      res.status(404).json({ ok: false, error: 'expediente_not_found', numero: rawNumero });
      return;
    }

    const numero: string = general.numero as string; // canonical "23.511" form

    // Fetch all detail tables in parallel — empty array if no rows.
    const [tramiteRes, proponentesRes, consultasRes, leyRes, documentosRes] = await Promise.all([
      supClientRaw
        .from('sil_expediente_tramite')
        .select('*')
        .eq('expediente_id', numero)
        .order('orden', { ascending: true, nullsFirst: false })
        .order('fecha_inicio', { ascending: true }),

      supClientRaw
        .from('sil_expediente_proponentes')
        .select('*')
        .eq('expediente_id', numero)
        .order('firma_orden', { ascending: true }),

      supClientRaw
        .from('sil_expediente_consultas')
        .select('*')
        .eq('expediente_id', numero),

      supClientRaw
        .from('sil_leyes')
        .select('*, sil_leyes_afectaciones(*)')
        .eq('expediente_origen_id', numero)
        .maybeSingle(),

      supClientRaw
        .from('sil_expediente_documentos')
        .select('*')
        .eq('expediente_id', numero)
        .order('tipo', { ascending: true }),
    ]);

    // Pedido 16j ("algoritmo Carlos") — corremos el detector de novedades
    // EN VIVO sobre este expediente. Cruza sil_sharepoint_raw vs
    // sil_expediente_tramite y detecta items en SharePoint que no se
    // reflejan en la tramitación oficial. Si hay novedades algorítmicas
    // las mergeamos sobre las seedeadas en metadata.novedades_detectadas
    // (de hace el seed); las del detector pisan a las hardcoded.
    let novedadesDetectadas: unknown[] = [];
    try {
      const { detectNovedades } = await import('../services/noveltyDetector.js');
      const detected = await detectNovedades(numero);
      novedadesDetectadas = detected;
    } catch (err) {
      req.log?.warn('novelty_detector_failed', {
        error: (err as Error).message,
        numero,
      });
    }

    // Si el detector no encontró nada vivo, conservamos lo seedeado en
    // metadata para no mostrar la sección vacía en la demo.
    const generalEnriched = { ...general } as Record<string, unknown>;
    if (novedadesDetectadas.length > 0) {
      const meta = (generalEnriched.metadata ?? {}) as Record<string, unknown>;
      generalEnriched.metadata = {
        ...meta,
        novedades_detectadas: novedadesDetectadas,
      };
    }

    res.json({
      ok: true,
      expediente: {
        general: generalEnriched,
        tramite: tramiteRes.data ?? [],
        proponentes: proponentesRes.data ?? [],
        consultas: consultasRes.data ?? [],
        ley: leyRes.data ?? null,
        documentos: documentosRes.data ?? [],
      },
    });
  } catch (err) {
    req.log.error('expediente_full_failed', { error: (err as Error).message, numero: rawNumero });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

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

    // The client may pass `?json=1` to ask for the resolved URL as JSON
    // instead of a 302. We need this because <a href> navigations don't
    // carry the Bearer token — the auth-gated browser nav would 401. The
    // SPA fetches `?json=1` with the JWT, gets the (self-authenticating)
    // signed URL, and opens it in a new tab. Plain 302 mode is preserved
    // for any server-to-server caller / future direct embed scenarios.
    const wantsJson = req.query.json === '1';

    // The doc row has a gcs_path field once process-sil-docs has run for it.
    // Until then, fall back to the asamblea.go.cr source — better than a 404.
    const gcsPath = (doc as unknown as { gcs_path?: string | null }).gcs_path ?? null;
    if (!gcsPath) {
      if (wantsJson) {
        res.json({ ok: true, url: doc.source_url, mirrored: false });
        return;
      }
      res.redirect(302, doc.source_url);
      return;
    }

    // gs://bucket/path → bucket + path
    const m = gcsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) {
      req.log.warn('expediente_doc_bad_gcs_path', { docId, gcsPath });
      if (wantsJson) {
        res.json({ ok: true, url: doc.source_url, mirrored: false });
        return;
      }
      res.redirect(302, doc.source_url);
      return;
    }
    const [, bucketName, objectPath] = m;
    const file = storage().bucket(bucketName).file(objectPath);

    // Sign a short-lived URL. With ?json=1 we return it as JSON so the SPA
    // can window.open() it; otherwise we 302 (legacy embed path). Keeps
    // the BFF off the data path (no Express stream chunking through our
    // process), gives Google's CDN a chance to cache, and the URL expires
    // after SIGNED_URL_TTL_MS so sharing it accidentally has bounded impact.
    const [signedUrl] = await withTimeout(
      () =>
        file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + SIGNED_URL_TTL_MS,
        }),
      { ms: STREAM_TIMEOUT_MS, label: 'gcs:signed_url' },
    );
    if (wantsJson) {
      res.json({ ok: true, url: signedUrl, mirrored: true });
      return;
    }
    res.redirect(302, signedUrl);
  } catch (err) {
    req.log.error('expediente_doc_failed', { error: (err as Error).message, numero, docId });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
