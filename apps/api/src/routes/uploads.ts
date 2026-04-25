/**
 * Uploads BFF — Fase A of the /subir-sesiones port.
 *
 * Why: replicates the legacy "Subir sesión" form inside shift-cl2 without
 * rebuilding the ingest pipeline. We POST to the legacy backend
 * (videos-register + sendToAutomatic) so the existing worker handles
 * download → ElevenLabs → resumen, then poll listTranscripciones to know
 * when the row turns into a usable session.
 *
 * Auth: all endpoints require a valid Supabase JWT — only authenticated
 * users (Oscar's team) should be able to create new sessions.
 *
 * Out of scope (Fase B): own ingest pipeline, GCS bucket, ElevenLabs job
 * runner. See the audit/plan in conversation.
 */
import { Router, type Request, type Response } from 'express';
import { getUserIdFromRequest } from '../services/auth.js';
import {
  registerVideo,
  kickAutomatic,
  getTranscripcionById,
} from '../services/legacyCl2Client.js';

export const uploadsRouter = Router();

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS = new Set(['plenario', 'comision', 'extraordinaria']);

// Extracts the 11-char YouTube video id from any standard URL shape:
// youtube.com/watch?v=<id>, youtu.be/<id>, youtube.com/embed/<id>,
// youtube.com/shorts/<id>, youtube.com/live/<id>. Returns null if not a
// YouTube URL or if the id can't be extracted — we refuse the upload
// rather than handing legacy a malformed URL it would silently 500 on.
function extractYoutubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Legacy `videos-register` doesn't have a published contract — different
// audits showed the inserted id under different keys depending on the
// version of the worker. Walk a known list of candidate paths and
// surface which one matched, so we can tighten the contract over time.
const LEGACY_ID_PATHS = [
  'id',
  'data.id',
  'video.id',
  'videoId',
  'video_id',
  'transcripcionId',
  'transcripcion_id',
  'transcripcionID',
  'data.videoId',
  'data.transcripcionId',
  'result.id',
  'inserted.id',
] as const;

function extractLegacyId(raw: unknown): { id: number; path: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const path of LEGACY_ID_PATHS) {
    const parts = path.split('.');
    let cur: any = raw;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') { cur = undefined; break; }
      cur = cur[p];
    }
    const n = typeof cur === 'number' ? cur : Number(cur);
    if (Number.isFinite(n) && n > 0) return { id: n, path };
  }
  return null;
}

interface SubmitBody {
  youtube_url?: string;
  titulo?: string;
  fecha?: string;
  comision?: string;
  tipo?: string;
}

/**
 * POST /api/uploads/youtube
 * Body: { youtube_url, titulo, fecha (YYYY-MM-DD), comision?, tipo? }
 * Returns: { ok, legacy_id, raw }  ← raw is the legacy response (debug aid)
 */
uploadsRouter.post('/youtube', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const body = (req.body ?? {}) as SubmitBody;
  const errors: string[] = [];
  const ytUrl = body.youtube_url?.trim() ?? '';
  const ytId = ytUrl ? extractYoutubeId(ytUrl) : null;
  if (!ytUrl || !ytId) errors.push('youtube_url_invalid');
  if (!body.titulo || body.titulo.trim().length < 3) errors.push('titulo_required');
  if (!body.fecha || !DATE_RX.test(body.fecha)) errors.push('fecha_required_yyyy_mm_dd');
  if (body.tipo && !TIPOS.has(body.tipo)) errors.push('tipo_invalid');
  if (errors.length > 0) {
    res.status(400).json({ ok: false, error: 'validation_failed', detail: errors });
    return;
  }

  req.log.info('uploads_submit_received', {
    userId,
    youtubeId: ytId,
    fecha: body.fecha,
    tipo: body.tipo ?? 'plenario',
  });

  try {
    const registered = await registerVideo({
      youtube: ytUrl,
      titulo: body.titulo!.trim(),
      fecha: body.fecha!,
      comision: body.comision?.trim() || 'Plenario',
      tipo: body.tipo ?? 'plenario',
    });

    const extracted = extractLegacyId(registered);
    if (!extracted) {
      // Surface the full raw payload + the candidate paths we tried so we can
      // extend LEGACY_ID_PATHS quickly if legacy ships a new shape.
      req.log.warn('uploads_register_no_id', {
        registered,
        triedPaths: LEGACY_ID_PATHS,
      });
      res.status(502).json({
        ok: false,
        error: 'register_no_id',
        detail: 'legacy backend did not return a video id at any known path',
        raw: registered,
        tried_paths: LEGACY_ID_PATHS,
        request_id: req.requestId,
      });
      return;
    }
    const legacyId = extracted.id;
    req.log.info('uploads_register_ok', {
      legacyId,
      idPath: extracted.path,
      youtubeId: ytId,
    });

    // Best-effort kick. If this fails the row exists but the worker won't
    // pick it up — surface the error so the operator can retry manually
    // (or click "kick" on the legacy admin).
    let kickError: string | null = null;
    try {
      await kickAutomatic(legacyId);
    } catch (err) {
      kickError = (err as Error).message;
      req.log.error('uploads_kick_failed', { legacyId, error: kickError });
    }

    res.json({
      ok: true,
      legacy_id: legacyId,
      kick_error: kickError,
      raw: registered,
      poll_url: `/api/uploads/${legacyId}/status`,
    });
  } catch (err) {
    req.log.error('uploads_submit_failed', { error: (err as Error).message });
    res.status(502).json({
      ok: false,
      error: 'upstream_unavailable',
      request_id: req.requestId,
    });
  }
});

/**
 * GET /api/uploads/:legacyId/status
 * Polled by the frontend until status === 'ready'. Maps legacy estado/duration
 * into a small contract:
 *   - 'pending'    → row exists, worker hasn't finished (no transcripcion url)
 *   - 'ready'      → estado=1 + transcript url present → safe to navigate
 *   - 'error'      → not found
 */
uploadsRouter.get('/:legacyId/status', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = Number(req.params.legacyId);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'bad_id' });
    return;
  }

  try {
    const row = await getTranscripcionById(id);
    if (!row) {
      // Could be: brand-new row not yet returned by the wide-window query,
      // or genuinely missing. Caller treats as 'pending' for the first ~30s
      // then surfaces as error.
      res.json({ ok: true, status: 'pending', detail: 'not_yet_listed' });
      return;
    }

    const hasTranscript = typeof row.transcripcion === 'string' && row.transcripcion.length > 0;
    const hasResumen = typeof row.resumen === 'string' && row.resumen.length > 0;
    const finalized = row.estado === 1 && hasTranscript;

    // Known legacy bug: estado flips to 1 but transcripcion stays empty
    // (audit §2.5). Surface as 'partial' so the UI can offer the user a
    // path forward (open the session anyway, retry the worker, contact
    // ops) instead of silently spinning until POLL_TIMEOUT_MS.
    let status: 'ready' | 'partial' | 'pending' = 'pending';
    let detail: string | undefined;
    if (finalized) {
      status = 'ready';
    } else if (row.estado === 1 && !hasTranscript) {
      status = 'partial';
      detail = 'legacy_processado_without_transcript';
    } else {
      detail = `estado=${row.estado}`;
    }

    res.json({
      ok: true,
      status,
      detail,
      session: {
        id: row.id,
        titulo: row.titulo,
        fecha: row.fecha,
        duration_s: row.duration,
        estado: row.estado,
        has_transcript: hasTranscript,
        has_resumen: hasResumen,
      },
    });
  } catch (err) {
    req.log.error('uploads_status_failed', { error: (err as Error).message, id });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
