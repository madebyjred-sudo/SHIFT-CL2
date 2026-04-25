/**
 * Sessions BFF — proxy + reshape for the legacy CL2 transcripciones API.
 *
 * Why: legacy MariaDB system stays source-of-truth for plenarias until
 * post-MVP. We don't migrate before 2026-05-08; we wrap.
 *
 * Auth: every endpoint requires a valid Supabase JWT. No anon access —
 * unlike /chat/stream (where anonymous demo flows are tolerated), session
 * data is "internal" content.
 *
 * Reshape:
 *  - parseResumen: split markdown by emoji headers (🧾📌⚖️) into structured cards
 *  - wordsToSegments: 35K ElevenLabs words → ~30-word chunks at pause boundaries
 *
 * Both reshapes happen server-side so the client ships less JS and fewer
 * iterations on a phone.
 */
import { Router, type Request, type Response } from 'express';
import { getUserIdFromRequest } from '../services/auth.js';
import {
  listTranscripciones,
  getTranscripcionById,
  fetchTranscriptJson,
  wordsToSegments,
  type LegacyTranscripcion,
} from '../services/legacyCl2Client.js';

export const sessionsRouter = Router();

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

// --- Resumen parsing -----------------------------------------------------
// Legacy resumen is a single markdown blob delimited by emoji headers, e.g:
//   🧾 Resumen ejecutivo\n...body...\n📌 Puntos clave\n...\n⚖️ Acuerdos\n...
// Returning structured cards lets the client render premium layout without
// re-parsing markdown for each frame.

interface ResumenSections {
  ejecutivo: string | null;
  puntos_clave: string | null;
  acuerdos: string | null;
  raw: string;
}

const SECTION_PATTERNS: Array<{ key: keyof Omit<ResumenSections, 'raw'>; rx: RegExp }> = [
  { key: 'ejecutivo',    rx: /🧾[^\n]*\n([\s\S]*?)(?=(?:📌|⚖️|$))/ },
  { key: 'puntos_clave', rx: /📌[^\n]*\n([\s\S]*?)(?=(?:🧾|⚖️|$))/ },
  { key: 'acuerdos',     rx: /⚖️[^\n]*\n([\s\S]*?)(?=(?:🧾|📌|$))/ },
];

function parseResumen(md: string | null | undefined): ResumenSections {
  const raw = md ?? '';
  const out: ResumenSections = { ejecutivo: null, puntos_clave: null, acuerdos: null, raw };
  for (const { key, rx } of SECTION_PATTERNS) {
    const m = raw.match(rx);
    if (m) out[key] = m[1].trim();
  }
  return out;
}

// --- Response shape ------------------------------------------------------

// Legacy stores the full youtube URL (not the bare id) in `youtube`. Extract
// the 11-char id so the client can embed without re-parsing.
function extractYouTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function shapeListItem(t: LegacyTranscripcion) {
  return {
    id: t.id,
    titulo: t.titulo,
    youtube_url: t.youtube,
    youtube_id: extractYouTubeId(t.youtube),
    fecha: t.fecha,
    duration_s: t.duration,
    estado: t.estado, // 1 = FINALIZADA
    has_resumen: typeof t.resumen === 'string' && t.resumen.length > 0,
  };
}

function shapeDetail(t: LegacyTranscripcion) {
  return {
    id: t.id,
    titulo: t.titulo,
    youtube_url: t.youtube,
    youtube_id: extractYouTubeId(t.youtube),
    fecha: t.fecha,
    duration_s: t.duration,
    estado: t.estado,
    transcript_url: t.transcripcion,
    resumen: parseResumen(t.resumen),
  };
}

// --- Routes --------------------------------------------------------------

/**
 * GET /api/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=&offset=
 * Defaults to last 90 days when range omitted.
 */
sessionsRouter.get('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const today = new Date();
  const past90 = new Date(today);
  past90.setDate(today.getDate() - 90);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const from = (req.query.from as string | undefined) ?? fmt(past90);
  const to = (req.query.to as string | undefined) ?? fmt(today);
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ ok: false, error: 'bad_date_range' });
    return;
  }

  try {
    const rows = await listTranscripciones({ fecha_inicio: from, fecha_fin: to, limit, offset });
    res.json({ ok: true, sessions: rows.map(shapeListItem) });
  } catch (err) {
    req.log.error('sessions_list_failed', { error: (err as Error).message, from, to });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/sessions/:id
 * Returns metadata + structured resumen. No transcript blob (separate route).
 */
sessionsRouter.get('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'bad_id' });
    return;
  }

  try {
    const t = await getTranscripcionById(id);
    if (!t) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, session: shapeDetail(t) });
  } catch (err) {
    req.log.error('session_detail_failed', { error: (err as Error).message, id });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

/**
 * GET /api/sessions/:id/transcript
 * Returns segmented transcript. Heavy — cached server-side via LRU in client.
 */
sessionsRouter.get('/:id/transcript', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'bad_id' });
    return;
  }

  try {
    const t = await getTranscripcionById(id);
    if (!t) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if (!t.transcripcion) {
      res.status(409).json({ ok: false, error: 'transcript_pending' });
      return;
    }
    const blob = await fetchTranscriptJson(t.transcripcion);
    const segments = wordsToSegments(blob.words);
    res.json({
      ok: true,
      transcript: {
        id: t.id,
        language: blob.language_code,
        duration_s: t.duration,
        segment_count: segments.length,
        word_count: blob.words.length,
        segments,
      },
    });
  } catch (err) {
    req.log.error('transcript_fetch_failed', { error: (err as Error).message, id });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
