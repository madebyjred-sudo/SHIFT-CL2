/**
 * /api/feedback — bandeja de entrada de bugs / preguntas / ideas.
 *
 * El user reporta desde un widget en la SPA. El widget puede subir un
 * screenshot (pegado desde clipboard o file picker). La imagen va a GCS
 * (CL2_ASSETS_BUCKET, prefix bug-reports/<user_id>/), el resto a la
 * tabla `bug_reports`.
 *
 * Endpoints:
 *   POST   /api/feedback                  — crear reporte (multipart si
 *                                            trae screenshot, JSON si no)
 *   GET    /api/feedback/mine             — historial del propio user
 *
 * Admin (en /api/admin/feedback, montado aparte porque está bajo el
 * guard de admin):
 *   GET    /api/admin/feedback            — bandeja (filter by status)
 *   GET    /api/admin/feedback/:id        — detalle (con signed URL)
 *   PATCH  /api/admin/feedback/:id        — cambiar status + admin_notes
 *
 * Auth: user JWT para los user-facing; service_role + role check para admin.
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { getUserFromRequest } from '../services/auth.js';
import { logger } from '../services/logger.js';

export const feedbackRouter = Router();

// ─── Supabase singleton ───────────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── GCS singleton ────────────────────────────────────────────────────
let _storage: Storage | null = null;
function bucketName(): string {
  return (
    process.env.BUG_REPORTS_BUCKET
    ?? process.env.CL2_ASSETS_BUCKET
    ?? process.env.ASSET_GCS_BUCKET
    ?? 'cl2-assets'
  );
}
function gcs(): Storage {
  if (!_storage) _storage = new Storage();
  return _storage;
}

// ─── Multer (in-memory, 8MB cap) ──────────────────────────────────────
// Screenshots típicos < 1MB; 8MB cubre PDFs raros o capturas de pantalla
// full-screen 4K. Mayor de eso = abuso, lo rechazamos en multer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

interface ContextMeta {
  user_agent?: string;
  viewport?: { w: number; h: number };
  theme?: 'light' | 'dark';
  url_full?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────
function safeContentType(detected: string | undefined, fallback = 'application/octet-stream'): string {
  if (!detected) return fallback;
  // Allowlist defensiva — solo imágenes comunes para screenshots.
  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
  return allowed.includes(detected.toLowerCase()) ? detected : fallback;
}

function extFromMime(mime: string): string {
  const m = mime.split('/').pop() ?? 'bin';
  if (m === 'jpeg') return 'jpg';
  return m;
}

async function uploadScreenshot(userId: string, buf: Buffer, mime: string): Promise<string> {
  const ext = extFromMime(mime);
  const id = randomUUID();
  const objectPath = `bug-reports/${userId}/${id}.${ext}`;
  const bucket = gcs().bucket(bucketName());
  await bucket.file(objectPath).save(buf, {
    contentType: mime,
    resumable: false,
    metadata: { cacheControl: 'private, max-age=2592000' }, // 30d
  });
  return `gs://${bucket.name}/${objectPath}`;
}

async function signScreenshot(gsPath: string): Promise<string | null> {
  const m = gsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, bucket, object] = m;
  try {
    const [url] = await gcs().bucket(bucket).file(object).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7d
    });
    return url;
  } catch (err) {
    logger.warn('feedback.signScreenshot failed', { gsPath, error: (err as Error).message });
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═════════════════════════════════════════════════════════════════════

// POST /api/feedback — crear reporte. Multipart (con screenshot) o JSON.
feedbackRouter.post('/', upload.single('screenshot'), async (req: Request, res: Response) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }

  // Multer parsea text fields como strings — JSON.parse para campos
  // estructurados (context_meta). Si vino como JSON puro (no multipart),
  // los campos vienen ya como objetos.
  const fields = (req.body ?? {}) as Record<string, unknown>;
  const title = String(fields.title ?? '').trim();
  if (!title) {
    res.status(400).json({ ok: false, error: 'title_required' });
    return;
  }
  const description = String(fields.description ?? '').trim();
  const kind = ((fields.kind as string) || 'bug').trim();
  const severity = ((fields.severity as string) || 'media').trim();
  const context_url = (fields.context_url as string)?.trim() || null;

  let context_meta: ContextMeta = {};
  if (typeof fields.context_meta === 'string' && fields.context_meta) {
    try { context_meta = JSON.parse(fields.context_meta) as ContextMeta; }
    catch { /* swallow — meta es opcional */ }
  } else if (fields.context_meta && typeof fields.context_meta === 'object') {
    context_meta = fields.context_meta as ContextMeta;
  }

  // Soft-validate enums (la DB tiene constraints estrictos; un 400 acá
  // da mejor mensaje que un 500 desde la DB).
  if (!['bug', 'pregunta', 'idea', 'otro'].includes(kind)) {
    res.status(400).json({ ok: false, error: 'invalid_kind' });
    return;
  }
  if (!['baja', 'media', 'alta', 'critica'].includes(severity)) {
    res.status(400).json({ ok: false, error: 'invalid_severity' });
    return;
  }

  // Upload screenshot si vino. Si falla, NO bloqueamos el reporte —
  // mejor tener bug-report sin imagen que perderlo entero.
  let screenshot_path: string | null = null;
  if (req.file) {
    const mime = safeContentType(req.file.mimetype, 'image/png');
    try {
      screenshot_path = await uploadScreenshot(user.id, req.file.buffer, mime);
    } catch (err) {
      logger.warn('feedback.uploadScreenshot failed', {
        user_id: user.id, error: (err as Error).message,
      });
    }
  }

  try {
    const { data, error } = await supa()
      .from('bug_reports')
      .insert({
        user_id: user.id,
        user_email: user.email,
        kind,
        title: title.slice(0, 280),
        description: description.slice(0, 10_000),
        context_url,
        context_meta,
        screenshot_path,
        severity,
      })
      .select('id, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, id: (data as { id: string }).id, created_at: (data as { created_at: string }).created_at });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/feedback/mine — historial del user
feedbackRouter.get('/mine', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  try {
    const { data, error } = await supa()
      .from('bug_reports')
      .select('id, kind, title, severity, status, created_at, resolved_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — se montan bajo /api/admin/feedback con su propio guard
// (el admin guard middleware de admin.ts ya hace el role check).
// ═════════════════════════════════════════════════════════════════════
export const adminFeedbackRouter = Router();

// GET /api/admin/feedback — bandeja
// Filters: ?status=abierto|en_revision|resuelto|descartado (default abierto+en_revision)
//          ?kind=bug|pregunta|idea|otro
//          ?limit=N (default 50)
adminFeedbackRouter.get('/', async (req, res) => {
  const statusFilter = req.query.status as string | undefined;
  const kindFilter = req.query.kind as string | undefined;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

  try {
    let q = supa()
      .from('bug_reports')
      .select('id, user_id, user_email, kind, title, severity, status, context_url, created_at, resolved_at, screenshot_path')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (statusFilter) {
      q = q.eq('status', statusFilter);
    } else {
      // Default: solo lo que requiere atención.
      q = q.in('status', ['abierto', 'en_revision']);
    }
    if (kindFilter) q = q.eq('kind', kindFilter);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    // Indicador rápido para la UI: ¿tiene imagen? (sin firmar — eso es por-detalle)
    const items = (data ?? []).map((r) => ({
      ...(r as Record<string, unknown>),
      has_screenshot: Boolean((r as { screenshot_path: string | null }).screenshot_path),
    }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/admin/feedback/:id — detalle con signed URL
adminFeedbackRouter.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supa()
      .from('bug_reports')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    const row = data as { screenshot_path: string | null } & Record<string, unknown>;
    let screenshot_url: string | null = null;
    if (row.screenshot_path) {
      screenshot_url = await signScreenshot(row.screenshot_path);
    }
    res.json({ ok: true, report: { ...row, screenshot_url } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// PATCH /api/admin/feedback/:id — cambiar status / admin_notes
adminFeedbackRouter.patch('/:id', async (req, res) => {
  const body = (req.body ?? {}) as { status?: string; admin_notes?: string; severity?: string };
  const update: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!['abierto', 'en_revision', 'resuelto', 'descartado'].includes(body.status)) {
      res.status(400).json({ ok: false, error: 'invalid_status' });
      return;
    }
    update.status = body.status;
  }
  if (body.admin_notes !== undefined) update.admin_notes = String(body.admin_notes).slice(0, 10_000);
  if (body.severity !== undefined) {
    if (!['baja', 'media', 'alta', 'critica'].includes(body.severity)) {
      res.status(400).json({ ok: false, error: 'invalid_severity' });
      return;
    }
    update.severity = body.severity;
  }
  if (Object.keys(update).length === 0) {
    res.status(400).json({ ok: false, error: 'nothing_to_update' });
    return;
  }
  try {
    const { data, error } = await supa()
      .from('bug_reports')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    res.json({ ok: true, report: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
