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
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';
import {
  listTranscripciones,
  getTranscripcionById,
  fetchTranscriptJson,
  wordsToSegments,
  type LegacyTranscripcion,
} from '../services/legacyCl2Client.js';

export const sessionsRouter = Router();

// Supabase singleton (lazy). Las sesiones nuevas del pipeline YouTube viven
// en la tabla `sessions` de Supabase; las viejas (pre-mayo 2026) en MariaDB
// legacy via legacyCl2Client. Este endpoint mergea ambas fuentes para que
// el operador y el equipo vean todo en /sesiones y /admin/sesiones.
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for sessions router');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Status → estado int mapping ───────────────────────────────────────────
// El frontend legacy usa estado:int (0=cola, 1=procesando, 2=indexada,
// 3=archivada, 4=sensible). Las sesiones nuevas usan status:text. Esta
// función traduce. Mantener sync con ESTADO_MAP en SesionesSection.tsx.
function statusToEstado(status: string): number {
  switch (status) {
    case 'indexed':         return 2; // visible al equipo
    case 'pending_review':  return 1; // procesando (cola operador)
    case 'processing':      return 1;
    case 'pending':         return 0; // en cola
    case 'transcript_not_ready': return 0;
    case 'error':           return 4; // sensible
    case 'permanent_failure': return 4;
    case 'rejected':        return 4;
    default:                return 0;
  }
}

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

  // ── Filtros opcionales ───────────────────────────────────────────────
  // type=plenario        → solo plenarias/comisiones largas (≥30min de transcript)
  //                        Excluye clips de prensa, entrevistas y shorts.
  // include_pending=true → incluye sesiones en pending_review (default: solo
  //                        las visibles al equipo, status=indexed). El admin
  //                        usa esto si quiere ver TODO; el feed público nunca.
  // Default sin params: solo indexed + sin filtro de duración (backward compat
  // para los call-sites legacy que no conocen estos params).
  const filterType = (req.query.type as string | undefined) ?? null;
  const includePending = req.query.include_pending === 'true';
  const MIN_PLENARIO_SECONDS = 1800; // 30 min — corta entrevistas/clips/shorts

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ ok: false, error: 'bad_date_range' });
    return;
  }

  try {
    // 1) Legacy MariaDB rows (sesiones pre-mayo 2026 + cualquier upload manual).
    //    Si falla la query legacy seguimos con las nuevas — no bloqueamos el
    //    feed completo por un timeout del sistema viejo.
    let legacyShape: ReturnType<typeof shapeListItem>[] = [];
    try {
      const legacyRows = await listTranscripciones({ fecha_inicio: from, fecha_fin: to, limit, offset });
      legacyShape = legacyRows.map(shapeListItem);
    } catch (err) {
      req.log.warn('sessions_legacy_query_failed_continuing', {
        error: (err as Error).message,
        from,
        to,
      });
    }

    // 2) Supabase sessions nuevas (pipeline YouTube post-mayo 2026).
    //    Por default solo 'indexed' (ya aprobadas por el operador, visibles
    //    al equipo). Con include_pending=true el admin ve también las que
    //    están en cola de revisión. La cola pura vive en /admin/transcripts,
    //    así que este endpoint queda enfocado en lo PUBLICADO.
    const statusesToQuery = includePending
      ? ['indexed', 'pending_review', 'processing', 'pending', 'transcript_not_ready']
      : ['indexed'];

    // El pipeline de transcript a veces deja `fecha` en NULL para sesiones
    // recién indexadas (caso real reportado 2026-05-22: Plenario #14
    // indexada, 204 segmentos, sin fecha → invisible en /sesiones). Para
    // que esas filas no desaparezcan, hacemos DOS queries en paralelo:
    //   (a) sesiones con fecha en el rango
    //   (b) sesiones con fecha=null cuyo created_at cae en el rango
    // y las mergeamos. El frontend trata fecha=null como created_at
    // gracias al fallback `s.fecha ?? s.created_at` más abajo.
    const [withFecha, withoutFecha] = await Promise.all([
      supa()
        .from('sessions')
        .select('id, youtube_video_id, fecha, status, metadata, created_at')
        .gte('fecha', from)
        .lte('fecha', to)
        .in('status', statusesToQuery)
        .order('fecha', { ascending: false, nullsFirst: false })
        .limit(500),
      supa()
        .from('sessions')
        .select('id, youtube_video_id, fecha, status, metadata, created_at')
        .is('fecha', null)
        .gte('created_at', `${from}T00:00:00`)
        .lte('created_at', `${to}T23:59:59`)
        .in('status', statusesToQuery)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (withFecha.error) {
      req.log.warn('sessions_supabase_query_failed_continuing', { error: withFecha.error.message });
    }
    if (withoutFecha.error) {
      req.log.warn('sessions_supabase_null_fecha_query_failed', { error: withoutFecha.error.message });
    }
    const supaRows = [...(withFecha.data ?? []), ...(withoutFecha.data ?? [])];

    type SupaSessionRow = {
      id: string;
      youtube_video_id: string | null;
      fecha: string | null;
      status: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    };

    // Necesitamos el `tipo` de la sesión para el filtro inteligente de
    // duración más abajo (sesiones con tipo='plenario' explícito siempre
    // pasan el filtro, aunque duration sea 0).
    const { data: supaTipos } = await supa()
      .from('sessions')
      .select('id, tipo')
      .in('id', (supaRows ?? []).map((r: { id: string }) => r.id));
    const tipoBySupaId = new Map<string, string | null>(
      ((supaTipos ?? []) as { id: string; tipo: string | null }[]).map((r) => [r.id, r.tipo]),
    );

    const newShape = ((supaRows ?? []) as SupaSessionRow[]).map((s) => {
      const meta = (s.metadata ?? {}) as { raw_title?: string; sesion_label?: string; duration_seconds?: number };
      const title = meta.raw_title || meta.sesion_label || `Sesión ${s.youtube_video_id ?? s.id.slice(0, 8)}`;
      return {
        id: s.id, // uuid string — el frontend lo trata como id genérico
        titulo: title,
        youtube_url: s.youtube_video_id ? `https://www.youtube.com/watch?v=${s.youtube_video_id}` : null,
        youtube_id: s.youtube_video_id,
        fecha: s.fecha ?? s.created_at.slice(0, 10),
        duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
        estado: statusToEstado(s.status),
        has_resumen: false, // las sesiones nuevas aún no tienen resumen estructurado
        // Internal — usado por el filtro `type=plenario` más abajo
        _tipo: tipoBySupaId.get(s.id) ?? null,
      };
    });

    // 3) Dedupe: si una sesión está tanto en legacy como en Supabase nueva,
    //    privilegiamos la nueva (más fresca, con metadata correcta).
    const legacyYtIds = new Set(legacyShape.map((r) => r.youtube_id).filter(Boolean));
    const dedupedLegacy = legacyShape.filter((r) => !r.youtube_id || !newShape.some((n) => n.youtube_id === r.youtube_id));
    void legacyYtIds; // referencia retenida si quisiéramos invertir prioridad

    // 4) Merge + sort por fecha desc (las sin fecha al final).
    let merged = [...dedupedLegacy, ...newShape].sort((a, b) => {
      const af = a.fecha ?? '';
      const bf = b.fecha ?? '';
      if (af === bf) return 0;
      return af < bf ? 1 : -1; // desc
    });

    // 5) Aplicar filtro de tipo si se pidió. type=plenario muestra:
    //    (a) Toda sesión con tipo='plenario' explícito en DB — independiente
    //        de la duración (puede ser 0 si el pipeline no la registró).
    //    (b) Sesiones sin tipo explícito (legacy o pipeline incompleto) que
    //        tengan duración ≥ 30min — heurística para descartar clips de
    //        prensa, entrevistas y shorts.
    // Bug previo: aplicábamos solo (b), entonces plenarios reales con
    // duration_seconds=0 (raro pero ocurre en sesiones nuevas que no
    // pasaron por el path de duración) quedaban invisibles. Reportado por
    // Jred 2026-05-12 — el Plenario #07 11 may estaba indexed pero no
    // aparecía en la pestaña admin.
    if (filterType === 'plenario') {
      merged = merged.filter((r) => {
        const tipo = (r as { _tipo?: string | null })._tipo;
        if (tipo === 'plenario' || tipo === 'comision') return true;
        return (r.duration_s ?? 0) >= MIN_PLENARIO_SECONDS;
      });
    }
    // Strip helper field antes de mandar al cliente — interno solamente.
    merged = merged.map(({ _tipo: _omit, ...rest }: Record<string, unknown>) => rest as typeof merged[0]);

    res.json({ ok: true, sessions: merged });
  } catch (err) {
    req.log.error('sessions_list_failed', { error: (err as Error).message, from, to });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});

// Detect UUID v4 format (8-4-4-4-12 hex chars). Si el id es uuid, viene del
// sistema nuevo (Supabase); si es int positivo, del legacy MariaDB.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/sessions/:id
 * Returns metadata + structured resumen. No transcript blob (separate route).
 *
 * Acepta dos formatos de id:
 *  - int positivo → legacy MariaDB
 *  - UUID → Supabase sessions (pipeline nuevo)
 */
sessionsRouter.get('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const rawId = String(req.params.id);

  // ── Path A: UUID → Supabase ────────────────────────────────────────────
  if (UUID_REGEX.test(rawId)) {
    try {
      const { data: s, error: sErr } = await supa()
        .from('sessions')
        .select('id, youtube_video_id, fecha, status, metadata, created_at')
        .eq('id', rawId)
        .maybeSingle();
      if (sErr) throw new Error(sErr.message);
      if (!s) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      const meta = (s.metadata ?? {}) as {
        raw_title?: string;
        sesion_label?: string;
        duration_seconds?: number;
        resumen?: { ejecutivo?: string | null; puntos_clave?: string | null; acuerdos?: string | null; raw?: string };
      };
      const title = meta.raw_title || meta.sesion_label || `Sesión ${s.youtube_video_id ?? s.id.slice(0, 8)}`;
      // El resumen estructurado lo genera el job de LLM (scripts/local-generate-summaries.ts
      // o el endpoint POST /api/admin/sessions/:id/summary cuando exista) y
      // se guarda en metadata.resumen. Si no existe aún, devolvemos los 4
      // campos en null — el frontend pinta el placeholder "Sin contenido".
      const r = meta.resumen ?? {};
      res.json({
        ok: true,
        session: {
          id: s.id,
          titulo: title,
          youtube_url: s.youtube_video_id ? `https://www.youtube.com/watch?v=${s.youtube_video_id}` : null,
          youtube_id: s.youtube_video_id,
          fecha: s.fecha ?? s.created_at.slice(0, 10),
          duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
          estado: statusToEstado(s.status),
          transcript_url: null,
          resumen: {
            ejecutivo: r.ejecutivo ?? null,
            puntos_clave: r.puntos_clave ?? null,
            acuerdos: r.acuerdos ?? null,
            raw: r.raw ?? '',
          },
        },
      });
      return;
    } catch (err) {
      req.log.error('session_detail_supabase_failed', { error: (err as Error).message, id: rawId });
      res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
      return;
    }
  }

  // ── Path B: int legacy ─────────────────────────────────────────────────
  const id = Number(rawId);
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
 *
 * Acepta dos formatos de id:
 *  - UUID → Supabase transcript_segments (pipeline nuevo)
 *  - int positivo → legacy MariaDB (ElevenLabs words JSON via GCS)
 */
sessionsRouter.get('/:id/transcript', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const rawId = String(req.params.id);

  // ── Path A: UUID → Supabase transcript_segments ────────────────────────
  if (UUID_REGEX.test(rawId)) {
    try {
      // Validar que la sesión existe + traer duration_s del metadata.
      const { data: s, error: sErr } = await supa()
        .from('sessions')
        .select('id, metadata')
        .eq('id', rawId)
        .maybeSingle();
      if (sErr) throw new Error(sErr.message);
      if (!s) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      // PostgREST tiene un cap server-side de 1000 rows por query —
      // hardcap, no se levanta con range() explícito. Para plenarias largas
      // (Sesión 11 mayo 2026 #07 tiene 7,934 segments, 6 h 7 min) sin
      // paginar el endpoint devolvía solo los primeros 50 min de transcript
      // y la UI mostraba "video cortado". Bug 2026-05-12.
      // Fix: paginar en ventanas de 1000 hasta agotar.
      const segs: Array<{ segment_idx: number; start_seconds: number; end_seconds: number; text: string }> = [];
      const PAGE_SIZE = 1000;
      const HARD_LIMIT = 50_000; // 50k segments = ~25 h de transcript, suficiente para cualquier sesión legislativa
      for (let offset = 0; offset < HARD_LIMIT; offset += PAGE_SIZE) {
        const { data: page, error: pageErr } = await supa()
          .from('transcript_segments')
          .select('segment_idx, start_seconds, end_seconds, text')
          .eq('session_id', rawId)
          .order('segment_idx', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);
        if (pageErr) throw new Error(pageErr.message);
        if (!page || page.length === 0) break;
        segs.push(...(page as Array<{ segment_idx: number; start_seconds: number; end_seconds: number; text: string }>));
        if (page.length < PAGE_SIZE) break;
      }
      // Shape: el frontend espera { index, start, end, text, word_count }
      // (definido en sessionsApi.ts TranscriptSegment). Las versiones previas
      // de este endpoint devolvían start_s/end_s y rompían el cronómetro
      // del player con "NaN:NaN" en cada cue.
      const segments = (segs ?? []).map((seg, i) => {
        const text: string = seg.text ?? '';
        return {
          index: typeof seg.segment_idx === 'number' ? seg.segment_idx : i,
          start: Number(seg.start_seconds),
          end: Number(seg.end_seconds),
          text,
          word_count: text.trim() ? text.trim().split(/\s+/).length : 0,
        };
      });
      if (segments.length === 0) {
        res.status(409).json({ ok: false, error: 'transcript_pending' });
        return;
      }
      const meta = (s.metadata ?? {}) as { duration_seconds?: number };
      const totalWords = segments.reduce((acc, sg) => acc + sg.word_count, 0);
      res.json({
        ok: true,
        transcript: {
          id: s.id,
          language: 'es',
          // Si metadata no tiene duración, derivamos del último cue (mismo
          // criterio que el backfill SQL que hicimos para las plenarias).
          duration_s:
            typeof meta.duration_seconds === 'number'
              ? meta.duration_seconds
              : segments.length > 0
                ? segments[segments.length - 1]!.end
                : null,
          segment_count: segments.length,
          word_count: totalWords,
          segments,
        },
      });
      return;
    } catch (err) {
      req.log.error('transcript_supabase_failed', { error: (err as Error).message, id: rawId });
      res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
      return;
    }
  }

  // ── Path B: int legacy ─────────────────────────────────────────────────
  const id = Number(rawId);
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sessions/:id/transcript/download?format=txt|srt
//
// Devuelve la transcripción como archivo descargable. Dos formatos:
//   txt → texto plano sin timecodes (legible, copy-paste a Word)
//   srt → SubRip estándar con timecodes (compatible con VLC, YouTube, etc.)
//
// Solo soporta sesiones UUID (Supabase). Las legacy (int) usan el path viejo
// de /transcript JSON y el usuario hace el formateo en el cliente.
// ─────────────────────────────────────────────────────────────────────────────
sessionsRouter.get('/:id/transcript/download', async (req, res) => {
  const rawId = req.params.id as string;
  const format = (req.query.format as string | undefined) === 'srt' ? 'srt' : 'txt';

  // Solo UUID. Las sesiones legacy (int) son del path MariaDB viejo, no
  // las exponemos en download — el dataset histórico es mejor verlo via
  // /admin/transcripts donde sí hay editor con corrections.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
  if (!isUuid) {
    res.status(400).json({ ok: false, error: 'session_id must be uuid' });
    return;
  }

  try {
    // Cargar metadata para el nombre del archivo
    const { data: sess, error: sessErr } = await supa()
      .from('sessions')
      .select('id, fecha, metadata, comision, tipo')
      .eq('id', rawId)
      .maybeSingle();
    if (sessErr) throw new Error(sessErr.message);
    if (!sess) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const meta = (sess.metadata ?? {}) as { raw_title?: string; sesion_label?: string };
    const title = meta.raw_title || meta.sesion_label || `sesion-${rawId.slice(0, 8)}`;

    // Cargar todos los segments paginados (mismo patrón que /transcript)
    const segs: Array<{ start_seconds: number; end_seconds: number; text: string }> = [];
    const PAGE = 1000;
    for (let off = 0; off < 50_000; off += PAGE) {
      const { data: page, error } = await supa()
        .from('transcript_segments')
        .select('segment_idx, start_seconds, end_seconds, text')
        .eq('session_id', rawId)
        .order('segment_idx', { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!page || page.length === 0) break;
      segs.push(...(page as Array<{ start_seconds: number; end_seconds: number; text: string }>));
      if (page.length < PAGE) break;
    }
    if (segs.length === 0) {
      res.status(409).json({ ok: false, error: 'transcript_pending' });
      return;
    }

    // Slug seguro para nombre de archivo (sin acentos ni espacios)
    const slug = title
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 80);

    if (format === 'txt') {
      // TXT plano: solo el texto, con un salto de línea cada segment.
      // El operator puede pegarlo a Word/Docs sin lidiar con timecodes.
      const body = segs.map((s) => (s.text ?? '').trim()).filter(Boolean).join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.txt"`);
      res.send(body);
      return;
    }

    // SRT: estándar SubRip con timestamps HH:MM:SS,mmm.
    // Compatible con VLC, YouTube, Premiere, Final Cut, etc.
    const fmtSrtTs = (s: number): string => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const ms = Math.floor((s - Math.floor(s)) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const srt = segs
      .map((s, i) => {
        const text = (s.text ?? '').trim();
        if (!text) return null;
        return `${i + 1}\n${fmtSrtTs(s.start_seconds)} --> ${fmtSrtTs(s.end_seconds)}\n${text}\n`;
      })
      .filter(Boolean)
      .join('\n');
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.srt"`);
    res.send(srt);
  } catch (err) {
    req.log.error('transcript_download_failed', { error: (err as Error).message, id: rawId, format });
    res.status(502).json({ ok: false, error: 'upstream_unavailable', request_id: req.requestId });
  }
});
