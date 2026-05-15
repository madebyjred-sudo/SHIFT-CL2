/**
 * Admin console — read + write endpoints powering the admin UI.
 *
 * Every action button in the UI lands here. Each write also dispatches
 * an audit_log entry so the Auditoría section reflects real activity.
 *
 * Auth: any authenticated user can call these during the demo. When we
 * open up to outside tenants, hoist a role check on top of the router.
 */
import { Router, type Request } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { audit, auditFromReq } from '../services/auditLog.js';
import { getUserFromRequest, loadUserAccess } from '../services/auth.js';
import { snapshotAll } from '../services/agentStats.js';
import { getOverride, loadOverrides, setOverride } from '../services/agentOverrides.js';
import { loadFlags, setFlag } from '../services/featureFlags.js';
import { logger } from '../services/logger.js';
import { writeNeuronFile } from '../services/cerebroNeuron.js';
import { adminFeedbackRouter } from './feedback.js';
import { listTranscripciones, type LegacyTranscripcion } from '../services/legacyCl2Client.js';
import { crawlList } from '../services/sharePointCrawler.js';

const adminRouter = Router();

// ── Guard: solo admin + operador acceden a /api/admin/* ────────────────
// Esto protege los 30+ endpoints del admin panel de un saque. Aplica
// antes de cualquier handler. Cuando Ronald apruebe a su equipo como
// 'lector' o 'editor', el frontend les muestra la app pero ESTOS
// endpoints van a responder 403 si intentan invocarlos.
//
// El guard es defensa en profundidad: el frontend también esconde el
// menú /admin para non-admins (AdminApp gate). Pero la verdadera
// frontera de seguridad vive acá — un curioso con curl no entra.
const ADMIN_ALLOWED_ROLES = new Set(['admin', 'operador']);
adminRouter.use(async (req, res, next) => {
  // /summary, /activity, /alerts son llamados por la home logueada para
  // mostrar los conteos en /admin sidebar. Si el user no es admin, igual
  // queremos que el resto de la app cargue sin errores 403 ruidosos.
  // Solo bloqueamos endpoints reales del admin.
  const u = await getUserFromRequest(req);
  if (!u) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }
  try {
    const access = await loadUserAccess(u.id);
    // Si la tabla user_access no existe (migration aún no aplicada) o el
    // user no tiene row (race del trigger), degradamos a deny en vez de
    // permit — es admin panel, mejor falla cerrada.
    if (!access) {
      res.status(403).json({ ok: false, error: 'access_unknown' });
      return;
    }
    if (access.status !== 'active') {
      res.status(403).json({ ok: false, error: `access_${access.status}` });
      return;
    }
    if (!access.role || !ADMIN_ALLOWED_ROLES.has(access.role)) {
      res.status(403).json({
        ok: false,
        error: 'admin_only',
        hint: 'Tu rol no tiene acceso al panel de administración.',
      });
      return;
    }
    // Útil para handlers downstream.
    (req as Request & { adminUser?: typeof access }).adminUser = access;
    next();
  } catch (err) {
    req.log?.error('admin_guard_failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'admin_guard_error' });
  }
});

// Bandeja de feedback (bugs/preguntas/ideas) — endpoints separados en
// routes/feedback.ts pero montados acá adentro para heredar el role
// guard de admin/operador.
adminRouter.use('/feedback', adminFeedbackRouter);

interface MockedResponse<T> {
  ok: true;
  mock: true;
  generated_at: string;
  data: T;
}

interface LiveResponse<T> {
  ok: true;
  mock: false;
  generated_at: string;
  data: T;
}

function mocked<T>(data: T): MockedResponse<T> {
  return { ok: true, mock: true, generated_at: new Date().toISOString(), data };
}
function live<T>(data: T): LiveResponse<T> {
  return { ok: true, mock: false, generated_at: new Date().toISOString(), data };
}

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Operational summary ─────────────────────────────────────────────
// Suma todas las "cosas pendientes humanas" para que el Overview muestre
// la cola REAL (no la cola legacy de marzo). Post-audit 2026-05-10:
//   • pending_transcripciones: sesiones con status='pending_review' en
//     sistema nuevo (cron descargó transcript, espera revisión humana)
//   • sessions_pending_processing: sesiones con status='pending' o
//     'transcript_not_ready' (cron las descubrió, transcript no listo)
//   • pending_corrections: transcript_corrections sin moderar
adminRouter.get('/summary', async (req, res) => {
  try {
    const s = supa();
    const [
      { count: chunksCount },
      { count: sessionsCount },
      { count: expedientesCount },
      { count: pendingReviewCount },
      { count: pendingSessionsCount },
      { count: pendingCorrectionsCount },
      { count: watchlistCount },
    ] = await Promise.all([
      s.from('legislative_chunks').select('id', { count: 'exact', head: true }),
      s.from('sessions').select('id', { count: 'exact', head: true }),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }),
      // Sesiones esperando revisión humana (transcript ya bajado, espera approve/reject)
      s.from('sessions').select('id', { count: 'exact', head: true }).eq('status', 'pending_review'),
      // Sesiones aún sin transcript (cron las recogió de YouTube)
      s.from('sessions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'transcript_not_ready']),
      // Correcciones LLM sin moderar
      s.from('transcript_corrections').select('id', { count: 'exact', head: true }).eq('human_review', 'pending'),
      s.from('centinela_watchlist').select('user_id', { count: 'exact', head: true }),
    ]);
    res.json(
      live({
        chunks: chunksCount ?? 0,
        sessions: sessionsCount ?? 0,
        expedientes: expedientesCount ?? 0,
        pending_transcripciones: pendingReviewCount ?? 0,          // ← cola humana real
        sessions_pending_processing: pendingSessionsCount ?? 0,    // ← cola de pipeline
        pending_corrections: pendingCorrectionsCount ?? 0,         // ← cola correcciones LLM
        watchlist_total: watchlistCount ?? 0,
      }),
    );
  } catch (err) {
    req.log?.warn('admin/summary failed', { err: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Recent activity stream (live from audit_log + Supabase events) ──
// Filtramos los eventos "Sistema arrancó admin BFF" para que el feed muestre
// acciones humanas. Los restarts de Cloud Run estaban inundando el feed
// (14 entries idénticas en un día). Si querés ver restarts, hay un endpoint
// dedicado /admin/build con cold-start metrics — esos no compiten con el
// feed de actividad humana.
adminRouter.get('/activity', async (_req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('id, ts, actor_email, actor_kind, verb, resource, resource_kind, result')
      .not('verb', 'eq', 'arrancó')
      .order('ts', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    res.json(live({ items: data ?? [] }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Alerts (derived) ────────────────────────────────────────────────
adminRouter.get('/alerts', async (_req, res) => {
  // For now derive from recent failed audit entries + worker state.
  // A real alert engine would track open issues with severity, owner,
  // ack/snooze. Today: surface anything that landed as result='error'
  // or 'retry' in the last 6 hours.
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const { data } = await supa()
      .from('audit_log')
      .select('id, ts, verb, resource, result, metadata')
      .neq('result', 'ok')
      .gte('ts', sixHoursAgo)
      .order('ts', { ascending: false })
      .limit(10);
    const items = (data ?? []).map((row) => ({
      id: row.id,
      severity: row.result === 'error' ? 'danger' : 'warn',
      title: `${row.verb} → ${row.result}`,
      detail: row.resource,
      when: row.ts,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Transcripciones — sistema nuevo (Supabase sessions) × review state ────
//
// CAMBIO 2026-05-10: este endpoint pasó de leer la API legacy
// (api.agentescl2.com vía listTranscripciones) a leer directo de
// `sessions` + `transcript_segments` en Supabase. Razones:
//
//   1. Las sesiones nuevas llegan vía cron `transcripts-sync` →
//      youtubeSync.ts → sessions con status='pending'. El cron
//      `process-pending` baja transcripts (yt-dlp + cookies) e inserta
//      segments. Una vez listo marca status='pending_review'.
//   2. La API legacy (sistema v1 que decepcionó al cliente CL2 Consultoría)
//      sigue corriendo en VPS pero ya no es la fuente de verdad. Las
//      sesiones nuevas no llegan ahí. Mantenerlo en el panel = mostrar
//      data muerta.
//   3. Workflow human-in-the-loop: cada sesión `pending_review` espera
//      que un operador la apruebe (→ 'indexed', visible al equipo) o
//      rechace (→ 'rejected', oculta). Es la regla "sin cita, sin respuesta"
//      aplicada a la fuente: el equipo solo ve transcripts que un humano
//      validó.
//
// Status derivation (por sesión):
//
//   sessions.status                  → QueueRow.status mostrado al admin
//   ─────────────────────────────────  ──────────────────────────────────
//   pending / processing /            → 'pending' (esperando transcript
//   transcript_not_ready                 — el cron sigue intentando)
//   pending_review                    → 'in_progress' (esperando humano)
//   indexed (con review aprobado o    → 'approved'
//      sin review por ser legacy)
//   rejected                          → 'rejected'
//
// Si una sesión tiene fila en transcripciones_review, su status manda;
// si no, derivamos del status de la sesión.

// 60 days keeps the moderation queue meaningful: recent sessions land
// here for review; anything older is assumed already-audited so we
// don't blow the list past 100 rows. Tweak via the env var when the
// transcription cadence changes.
const REVIEW_WINDOW_DAYS = Number(process.env.ADMIN_TRANSCRIPCIONES_WINDOW_DAYS ?? 60);

interface QueueRow {
  external_id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;
  duration_seconds: number;
  confidence: number;
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt_text: string;
  excerpt_ts: string;
}

function legacyToQueueRow(
  legacy: LegacyTranscripcion,
  reviewBySessionId: Map<string, { status: string; reviewer_note?: string | null }>,
): QueueRow {
  const sid = String(legacy.id);
  const review = reviewBySessionId.get(sid);
  // Legacy doesn't expose per-segment confidence, only the resumen
  // markdown. Surface a "—" placeholder by using 100% so the UI doesn't
  // panic, but mark flagged_segments=0 so the operator only sees real
  // worker-flagged content (none today; future Whisper job will set it).
  const confidence = 100;
  const excerpt = (legacy.resumen ?? '').split('\n').find((l) => l.trim().length > 0)?.slice(0, 220) ?? '';
  return {
    external_id: sid,
    session_id: legacy.id,
    sesion_label: legacy.titulo,
    expediente: null, // legacy doesn't link expediente; future enhancement
    date: legacy.fecha,
    duration_seconds: legacy.duration,
    confidence,
    flagged_segments: 0,
    status: (review?.status as QueueRow['status']) ?? 'pending',
    source: 'Legacy CL2 worker',
    speaker: 'Plenaria',
    excerpt_text: excerpt,
    excerpt_ts: '0:00:00',
  };
}

/**
 * Mapeo de sessions.status → QueueRow.status que la UI muestra.
 * Centralizado en una función para que el detalle endpoint use la misma
 * lógica.
 */
function mapSessionStatus(
  sessionStatus: string,
  reviewStatus: string | null,
): 'pending' | 'in_progress' | 'approved' | 'rejected' {
  // El review explícito siempre manda — un revisor que rechaza algo no
  // queremos que vuelva a 'pending' por un retry del cron.
  if (reviewStatus === 'approved') return 'approved';
  if (reviewStatus === 'rejected') return 'rejected';
  // `in_progress` significa "un revisor humano lo agarró activamente"
  // (hay row en transcripciones_review con status='pending'). Sin row de
  // revisor, el item debe estar disponible para ser tomado → 'pending',
  // que es lo que la UI usa para mostrar botones Aprobar/Rechazar.
  // Bug 2026-05-12: 'pending_review' (status post-transcripción automática)
  // se mapeaba a 'in_progress', dejando 83+ items sin botones de acción.
  if (reviewStatus === 'pending') return 'in_progress';
  // Sin review row, derivamos del status de la sesión.
  switch (sessionStatus) {
    case 'pending_review':
      return 'pending';
    case 'indexed':
      // Sesiones legacy / pre-workflow review: se asumen aprobadas porque
      // ya viven en /sesiones y el equipo las usa. Cuando llegue su turno
      // de re-revisión post-demo, el reviewer las puede ratificar.
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'pending':
    case 'processing':
    case 'transcript_not_ready':
    case 'permanent_failure':
    case 'error':
    default:
      return 'pending';
  }
}

adminRouter.get('/transcripciones', async (req, res) => {
  const today = new Date();
  const since = new Date(today);
  since.setDate(today.getDate() - REVIEW_WINDOW_DAYS);

  try {
    // 1) Sessions del sistema nuevo (Supabase) en la ventana
    const { data: sessions, error: sErr } = await supa()
      .from('sessions')
      .select('id, youtube_video_id, fecha, tipo, comision, status, metadata, created_at, updated_at')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(300);
    if (sErr) throw new Error(`sessions read failed: ${sErr.message}`);

    const sessionRows = (sessions ?? []) as Array<{
      id: string;
      youtube_video_id: string | null;
      fecha: string | null;
      tipo: string | null;
      comision: string | null;
      status: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    }>;

    // 2) Cross-ref con transcripciones_review (revisor humano)
    const reviewBySessionId = new Map<string, { status: string; reviewer_note: string | null }>();
    if (sessionRows.length > 0) {
      const ids = sessionRows.map((r) => r.id);
      const { data: reviews } = await supa()
        .from('transcripciones_review')
        .select('session_id, status, reviewer_note')
        .in('session_id', ids);
      for (const row of (reviews ?? []) as Array<{ session_id: string; status: string; reviewer_note: string | null }>) {
        reviewBySessionId.set(row.session_id, { status: row.status, reviewer_note: row.reviewer_note });
      }
    }

    // 3) Conteo de segments para mostrar densidad real (más útil que confidence dummy)
    const segCountBySessionId = new Map<string, number>();
    if (sessionRows.length > 0) {
      const ids = sessionRows.map((r) => r.id);
      // PostgREST no expone GROUP BY directo — usamos count=exact via prefer
      // header pero es un round-trip por sesión; mejor aceptar conteo aprox
      // en el listado y pedir el exacto solo en detalle. Para el listado
      // marcamos has_segments boolean.
      const { data: anySegs } = await supa()
        .from('transcript_segments')
        .select('session_id', { count: 'exact', head: false })
        .in('session_id', ids);
      for (const row of (anySegs ?? []) as Array<{ session_id: string }>) {
        segCountBySessionId.set(row.session_id, (segCountBySessionId.get(row.session_id) ?? 0) + 1);
      }
    }

    // 4) Convertir a QueueRow (wire shape que ya espera la UI)
    const items: QueueRow[] = sessionRows.map((s) => {
      const review = reviewBySessionId.get(s.id) ?? null;
      const status = mapSessionStatus(s.status, review?.status ?? null);
      const meta = (s.metadata ?? {}) as { raw_title?: string; sesion_label?: string; duration_seconds?: number };
      const title = meta.raw_title || meta.sesion_label || `Sesión ${s.youtube_video_id ?? s.id.slice(0, 8)}`;
      const segCount = segCountBySessionId.get(s.id) ?? 0;
      return {
        external_id: s.id,
        session_id: null, // legacy field — el id real es uuid en external_id
        sesion_label: title,
        expediente: null,
        date: s.fecha ?? s.created_at.slice(0, 10),
        duration_seconds: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
        // Confidence sintética: si tiene segments, es 100; si no, 0. La UI
        // pinta esto como "transcript ready vs pending".
        confidence: segCount > 0 ? 100 : 0,
        flagged_segments: 0,
        status,
        source: s.youtube_video_id ? `YouTube · ${s.youtube_video_id}` : 'CL2 sync',
        speaker: s.tipo === 'plenario' ? 'Plenaria' : (s.comision ?? 'Comisión'),
        excerpt_text: title.slice(0, 220),
        excerpt_ts: '0:00:00',
      };
    });

    const counts = {
      pending: items.filter((i) => i.status === 'pending').length,
      in_progress: items.filter((i) => i.status === 'in_progress').length,
      approved: items.filter((i) => i.status === 'approved').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
    };

    const wireItems = items.map((i) => ({
      id: i.external_id,
      session_id: i.session_id,
      sesion_label: i.sesion_label,
      expediente: i.expediente,
      date: i.date,
      duration_seconds: i.duration_seconds,
      confidence: i.confidence,
      flagged_segments: i.flagged_segments,
      status: i.status,
      source: i.source,
      speaker: i.speaker,
      excerpt: i.excerpt_text,
      excerpt_ts: i.excerpt_ts,
    }));

    res.json(live({ counts, items: wireItems }));
  } catch (err) {
    req.log?.warn('admin/transcripciones read failed', { error: (err as Error).message });
    res.json({
      ok: true,
      mock: false,
      degraded: true,
      degraded_reason: (err as Error).message,
      generated_at: new Date().toISOString(),
      data: {
        counts: { pending: 0, in_progress: 0, approved: 0, rejected: 0 },
        items: [],
      },
    });
  }
});

adminRouter.get('/transcripciones/:id', async (req, res) => {
  // El id ahora es el uuid de la sesión en Supabase (no el int legacy).
  const sessionId = String(req.params.id);
  try {
    // 1) Sesión + review row en una pasada
    const { data: session, error: sErr } = await supa()
      .from('sessions')
      .select('id, youtube_video_id, fecha, tipo, comision, status, metadata, created_at, updated_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (sErr) throw new Error(`session read failed: ${sErr.message}`);
    if (!session) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const sessionRow = session as {
      id: string;
      youtube_video_id: string | null;
      fecha: string | null;
      tipo: string | null;
      comision: string | null;
      status: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    };

    const { data: reviewRow } = await supa()
      .from('transcripciones_review')
      .select('status, reviewer_note, reviewed_at, payload')
      .eq('session_id', sessionId)
      .maybeSingle();
    const review = reviewRow as {
      status?: string;
      reviewer_note?: string | null;
      reviewed_at?: string | null;
      payload?: Record<string, unknown>;
    } | null;

    // 2) Transcript segments — primeros 12 para preview de moderación.
    //    El admin operador ve estos para decidir si aprueba/rechaza.
    const { data: segs } = await supa()
      .from('transcript_segments')
      .select('segment_idx, start_seconds, end_seconds, text, source')
      .eq('session_id', sessionId)
      .order('segment_idx', { ascending: true })
      .limit(12);
    const segmentRows = (segs ?? []) as Array<{
      segment_idx: number;
      start_seconds: number;
      end_seconds: number;
      text: string;
      source: string;
    }>;

    // Total segments — head=true para conteo sin payload
    const { count: totalSegmentsCount } = await supa()
      .from('transcript_segments')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId);
    const totalSegments = totalSegmentsCount ?? segmentRows.length;
    const totalWords = segmentRows.reduce((acc, s) => acc + (s.text?.split(/\s+/).length ?? 0), 0);

    // 3) Wire shape — mismo que la UI ya espera
    const meta = (sessionRow.metadata ?? {}) as { raw_title?: string; sesion_label?: string; duration_seconds?: number };
    const title = meta.raw_title || meta.sesion_label || `Sesión ${sessionRow.youtube_video_id ?? sessionId.slice(0, 8)}`;
    const status = mapSessionStatus(sessionRow.status, review?.status ?? null);

    const wireItem = {
      id: sessionRow.id,
      session_id: null,
      sesion_label: title,
      expediente: null,
      date: sessionRow.fecha ?? sessionRow.created_at.slice(0, 10),
      duration_seconds: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
      confidence: totalSegments > 0 ? 100 : 0,
      flagged_segments: 0,
      status,
      source: sessionRow.youtube_video_id ? `YouTube · ${sessionRow.youtube_video_id}` : 'CL2 sync',
      speaker: sessionRow.tipo === 'plenario' ? 'Plenaria' : (sessionRow.comision ?? 'Comisión'),
      excerpt: title.slice(0, 220),
      excerpt_ts: '0:00:00',
    };

    const segments = segmentRows.map((s) => ({
      ts: secondsToTs(s.start_seconds),
      speaker: 'Plenaria',
      text: s.text,
      confidence: 100, // youtube_auto no expone confidence per-segment
      flagged: false,
    }));

    if (segments.length === 0) {
      // Sin segments — la sesión está pendiente de procesamiento. Mostramos
      // un placeholder para que el panel no quede vacío.
      segments.push({
        ts: '0:00:00',
        speaker: 'Status',
        text: status === 'pending'
          ? 'Transcript pendiente de descarga. El cron volverá a intentarlo en su próxima corrida.'
          : 'Sin transcript disponible.',
        confidence: 100,
        flagged: false,
      });
    }

    res.json(
      live({
        item: wireItem,
        segments,
        diarization: [],
        total_segments: totalSegments,
        total_words: totalWords,
        review_note: review?.reviewer_note ?? null,
        reviewed_at: review?.reviewed_at ?? null,
      }),
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

function secondsToTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    : `${m}:${ss.toString().padStart(2, '0')}`;
}

adminRouter.post('/transcripciones/:id/review', async (req, res) => {
  const action = req.body?.action;
  const note = (req.body?.note as string | undefined) ?? null;
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action must be approve|reject' });
    return;
  }
  // El id ahora es uuid de la sesión en Supabase (no el int legacy).
  const sessionId = String(req.params.id);

  try {
    const user = await getUserFromRequest(req);
    const reviewStatus = action === 'approve' ? 'approved' : 'rejected';
    // El status de la sesión cambia para reflejar la decisión del humano.
    // Approve → 'indexed' (visible al equipo en /sesiones).
    // Reject  → 'rejected' (oculto al equipo, queda en el panel admin).
    const sessionStatus = action === 'approve' ? 'indexed' : 'rejected';

    // 1) Upsert review row (auditable, una decisión por sesión)
    const { error: rErr } = await supa()
      .from('transcripciones_review')
      .upsert(
        {
          session_id: sessionId,
          status: reviewStatus,
          reviewer_id: user?.id ?? null,
          reviewed_at: new Date().toISOString(),
          reviewer_note: note,
        },
        { onConflict: 'session_id' },
      );
    if (rErr) throw new Error(`review upsert failed: ${rErr.message}`);

    // 2) Update sessions.status para que el resto de la app refleje la decisión
    const { error: sErr } = await supa()
      .from('sessions')
      .update({ status: sessionStatus, updated_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (sErr) throw new Error(`session update failed: ${sErr.message}`);

    await auditFromReq(req, {
      verb: action === 'approve' ? 'aprobó' : 'rechazó',
      resource: `transcripción sesión ${sessionId.slice(0, 8)}`,
      resource_kind: 'transcription',
      resource_id: sessionId,
      result: 'ok',
      metadata: { note, session_status: sessionStatus },
    });

    res.json({ ok: true, id: sessionId, action, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Agents — live counters + persisted overrides ────────────────────
adminRouter.get('/agents/status', async (_req, res) => {
  try {
    const overrides = await loadOverrides();
    const stats = snapshotAll();
    const ids = ['lexa', 'atlas', 'centinela'];
    const data = ids.map((id) => {
      const s = stats[id];
      const o = overrides.get(id);
      return {
        agent_id: id,
        enabled: o?.enabled ?? true,
        model: o?.model ?? null,
        queries_24h: s?.queries_24h ?? 0,
        queries_recent_60m: s?.queries_recent_60m ?? 0,
        p50_ms: s?.p50_ms ?? null,
        p95_ms: s?.p95_ms ?? null,
        error_rate_pct: s?.error_rate_pct ?? 0,
      };
    });
    res.json(live({ items: data }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/agents/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const before = await getOverride(req.params.id);
    const next = await setOverride(
      req.params.id,
      {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      },
      user?.id ?? null,
    );

    const verb =
      before?.enabled !== next.enabled
        ? next.enabled
          ? 'activó'
          : 'desactivó'
        : 'editó';
    await auditFromReq(req, {
      verb,
      resource: `agente ${req.params.id}`,
      resource_kind: 'agent',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { before, after: next },
    });

    res.json({ ok: true, agent: next });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Feature flags — read + write ────────────────────────────────────
adminRouter.get('/flags', async (_req, res) => {
  try {
    const flags = await loadFlags(true);
    res.json(live({ flags }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/flags/:key', async (req, res) => {
  if (req.body?.value === undefined) {
    res.status(400).json({ ok: false, error: 'value required' });
    return;
  }
  try {
    const user = await getUserFromRequest(req);
    const before = (await loadFlags(true))[req.params.key];
    await setFlag(req.params.key, req.body.value, user?.id ?? null);
    await auditFromReq(req, {
      verb: 'cambió',
      resource: `flag ${req.params.key}`,
      resource_kind: 'flag',
      resource_id: req.params.key,
      result: 'ok',
      metadata: { before, after: req.body.value },
    });
    res.json({ ok: true, key: req.params.key, value: req.body.value });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Expedientes watchlist (per-user) ────────────────────────────────
adminRouter.get('/watchlist', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      // Anonymous → empty list (UI knows how to render "no hay alertas").
      // We don't 401 because the watchlist is a soft personalization, not
      // a critical surface — every other section degrades gracefully.
      res.json(live({ ids: [] as number[] }));
      return;
    }
    const { data, error } = await supa()
      .from('centinela_watchlist')
      .select('expediente_id')
      .eq('user_id', user.id);
    if (error) {
      // Specific error from PostgREST. Common case during the demo:
      // table just got created and the schema cache hadn't propagated
      // when the first query landed → schema_cache_miss. Restart of the
      // PostgREST instance fixes it; retry on a 30s window also works.
      req.log?.warn('admin/watchlist supabase error', {
        message: error.message,
        code: (error as { code?: string }).code,
        hint: (error as { hint?: string }).hint,
      });
      // Soft-degrade: empty list + the original message in the response
      // body (dev only — Express in prod truncates).
      res.json({
        ok: true,
        mock: false,
        degraded: true,
        degraded_reason: error.message,
        generated_at: new Date().toISOString(),
        data: { ids: [] as number[] },
      });
      return;
    }
    res.json(live({ ids: (data ?? []).map((r) => r.expediente_id as number) }));
  } catch (err) {
    req.log?.error('admin/watchlist threw', {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.post('/watchlist/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'auth_required' });
      return;
    }
    const expedienteId = Number(req.params.id);
    if (!Number.isFinite(expedienteId)) {
      res.status(400).json({ ok: false, error: 'bad_id' });
      return;
    }
    const action = req.body?.action;
    if (action === 'add') {
      const { error } = await supa()
        .from('centinela_watchlist')
        .upsert({ user_id: user.id, expediente_id: expedienteId });
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'activó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else if (action === 'remove') {
      const { error } = await supa()
        .from('centinela_watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('expediente_id', expedienteId);
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'quitó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else {
      res.status(400).json({ ok: false, error: 'action must be add|remove' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Audit log (real reads + filters + CSV) ──────────────────────────
adminRouter.get('/audit', async (req, res) => {
  try {
    let q = supa()
      .from('audit_log')
      .select('id, ts, actor_id, actor_email, actor_kind, verb, resource, resource_kind, resource_id, ip, result, metadata')
      .order('ts', { ascending: false })
      .limit(Math.min(Number(req.query.limit ?? 200) || 200, 500));
    if (typeof req.query.actor_kind === 'string') q = q.eq('actor_kind', req.query.actor_kind);
    if (typeof req.query.verb === 'string') q = q.ilike('verb', `%${req.query.verb}%`);
    if (typeof req.query.from === 'string') q = q.gte('ts', req.query.from);
    if (typeof req.query.to === 'string') q = q.lte('ts', req.query.to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((r) => ({
      ts: r.ts,
      actor: r.actor_kind === 'system' ? 'sys' : initialsForEmail(r.actor_email),
      actor_kind: r.actor_kind,
      actor_email: r.actor_email,
      verb: r.verb,
      resource: r.resource,
      resource_kind: r.resource_kind,
      ip: r.ip ?? null,
      result: r.result,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.get('/audit.csv', async (req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('ts, actor_email, actor_kind, verb, resource, resource_kind, result, ip')
      .order('ts', { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const lines = [
      ['ts', 'actor_email', 'actor_kind', 'verb', 'resource', 'resource_kind', 'result', 'ip'].join(','),
      ...rows.map((r) =>
        [
          r.ts,
          r.actor_email ?? '',
          r.actor_kind,
          quoteCsv(String(r.verb ?? '')),
          quoteCsv(String(r.resource ?? '')),
          r.resource_kind ?? '',
          r.result,
          r.ip ?? '',
        ].join(','),
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Users — list + role + invite ────────────────────────────────────
adminRouter.get('/users', async (_req, res) => {
  try {
    // Source of truth: user_access (migration 0025). Combina rows con
    // auth.users para traer last_sign_in_at que la API admin nos da gratis.
    const s = supa();
    const { data: accessRows, error } = await s
      .from('user_access')
      .select('user_id, email, full_name, avatar_url, status, role, approved_at, requested_at, last_seen_at, notes')
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    // Cruzá con auth.users para last_sign_in_at (la API admin pagina; pedimos
    // un solo page de 200 que cubre comodamente — CL2 tiene <50 users).
    const authList = await s.auth.admin.listUsers({ page: 1, perPage: 200 }).catch(() => null);
    const lastSignInByUserId = new Map<string, string | null>();
    for (const u of authList?.data?.users ?? []) {
      lastSignInByUserId.set(u.id, u.last_sign_in_at ?? null);
    }

    const items = (accessRows ?? []).map((row) => {
      const r = row as {
        user_id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        status: string;
        role: string | null;
        approved_at: string | null;
        requested_at: string;
        last_seen_at: string | null;
      };
      return {
        id: r.user_id,
        email: r.email,
        full_name: r.full_name,
        avatar_url: r.avatar_url,
        created_at: r.requested_at,
        last_sign_in_at: lastSignInByUserId.get(r.user_id) ?? r.last_seen_at ?? null,
        role: r.role,
        status: r.status,
        approved_at: r.approved_at,
      };
    });
    res.json(live({ items }));
  } catch (err) {
    logger.warn('admin/users live read failed', { error: (err as Error).message });
    res.json(
      live({ items: [], degraded_reason: (err as Error).message }),
    );
  }
});

// ── POST /api/admin/users/:id/approve ────────────────────────────────
// Cambia status='active' + asigna role. Solo admin/operador del CL2
// puede invocarlo (rate limit + chequeo de role en el caller, pendiente
// hardening para post-demo).
//
// Track 0a (2026-05-11): después de aprobar, sembramos templates en la
// neurona del user (Cerebro). Cuando el user entre por primera vez al
// SPA y vaya a /mi-memoria, ya tiene archivos editables. La escritura
// es best-effort — si Cerebro está caído, la aprobación NO se revierte
// (el user puede usar la app igual; va a poblar la neurona a mano
// después).
adminRouter.post('/users/:id/approve', async (req, res) => {
  const userId = String(req.params.id);
  const body = req.body as { role?: string } | undefined;
  const role = body?.role ?? 'lector';
  const ALLOWED_ROLES = new Set(['lector', 'editor', 'operador', 'admin']);
  if (!ALLOWED_ROLES.has(role)) {
    res.status(400).json({ ok: false, error: 'bad_role' });
    return;
  }
  try {
    const s = supa();
    const { data: updatedRow, error } = await s
      .from('user_access')
      .update({
        status: 'active',
        role,
        approved_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('email, full_name')
      .single();
    if (error) throw new Error(error.message);

    // Track 0a — seed neuron templates. Fire-and-forget; no await del
    // resultado para no atar la respuesta del approve al RTT de
    // Cerebro. Si falla, se loggea y listo.
    if (updatedRow?.email) {
      void seedNeuronTemplates(updatedRow.email, {
        full_name: (updatedRow as { full_name?: string | null }).full_name ?? null,
        role,
      }).catch((err) => {
        logger.warn('admin.approve: neuron seed failed', {
          user_id: userId,
          error: (err as Error).message,
        });
      });
    }

    await auditFromReq(req, {
      verb: 'aprobó',
      resource: userId,
      resource_kind: 'user',
      resource_id: userId,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true, role });
  } catch (err) {
    await auditFromReq(req, {
      verb: 'falló aprobar',
      resource: userId,
      resource_kind: 'user',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Track 0a · neuron seed mínima ────────────────────────────────────
// Diseño 2026-05-11 (feedback Jred): NO sembramos templates vacíos con
// placeholders "_(editá esto)_" — eso obliga al user a ir a /mi-memoria
// inmediatamente, justo lo contrario de lo que queremos. La neurona se
// va llenando sola via:
//   - Wizard onboarding (write-through en routes/onboarding.ts)
//   - Track A (cuando aterrice, los agentes van a escribir desde chat)
//
// Acá al aprobar solo dejamos UN archivo: bienvenida.md. Es meta —
// explica qué es la memoria, qué hace el wizard, dónde está /mi-memoria
// para casos excepcionales. No tiene placeholders editables.
//
// Idempotente: re-aprobar sobreescribe bienvenida con la fecha actualizada.
async function seedNeuronTemplates(
  email: string,
  ctx: { full_name: string | null; role: string },
): Promise<void> {
  const name = ctx.full_name?.trim() || email.split('@')[0];
  const fechaIso = new Date().toISOString().slice(0, 10);

  const bienvenida = `# Bienvenida a CL2

Hola, ${name}. Te acabamos de aprobar como usuario (rol: ${ctx.role}).

**Tu memoria personal** vive acá. La van armando los agentes (Lexa,
Atlas, Centinela) en base a las conversaciones que tengas con ellos y
al wizard de onboarding que te aparece al entrar. No tenés que llenar
nada a mano — entrá, conversá, y la memoria se enriquece sola.

Si en algún momento querés revisar qué saben de vos o limpiar algo,
está la página **Mi memoria** en el menú superior. Es para casos
excepcionales — el flujo normal es que los agentes la mantengan.

_Aprobado: ${fechaIso}_
`;

  await writeNeuronFile(email, '/memories/bienvenida.md', bienvenida);
}

// ── POST /api/admin/users/:id/reject ─────────────────────────────────
adminRouter.post('/users/:id/reject', async (req, res) => {
  const userId = String(req.params.id);
  const body = req.body as { reason?: string } | undefined;
  try {
    const s = supa();
    const { error } = await s
      .from('user_access')
      .update({
        status: 'rejected',
        notes: body?.reason ?? null,
      })
      .eq('user_id', userId);
    if (error) throw new Error(error.message);

    await auditFromReq(req, {
      verb: 'rechazó',
      resource: userId,
      resource_kind: 'user',
      result: 'ok',
      metadata: { reason: body?.reason ?? null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.post('/users/invite', async (req, res) => {
  const email = req.body?.email;
  const role = (req.body?.role as string | undefined) ?? 'lector';
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'bad_email' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.inviteUserByEmail(email, {
      data: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'invitó',
      resource: email,
      resource_kind: 'user',
      resource_id: data.user?.id ?? email,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true, id: data.user?.id ?? null, email });
  } catch (err) {
    await auditFromReq(req, {
      verb: 'falló invitar',
      resource: email,
      resource_kind: 'user',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/users/:id', async (req, res) => {
  const role = req.body?.role;
  if (typeof role !== 'string') {
    res.status(400).json({ ok: false, error: 'role required' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.updateUserById(req.params.id, {
      user_metadata: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'cambió rol',
      resource: data.user?.email ?? req.params.id,
      resource_kind: 'user',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Punto Medio passthrough — Forzar consolidación ──────────────────
adminRouter.post('/punto-medio/consolidate', async (req, res) => {
  const tenant = (req.body?.tenant as string | undefined) ?? process.env.CEREBRO_TENANT ?? 'cl2';
  const base = process.env.CEREBRO_BASE_URL ?? '';
  if (!base) {
    res.status(503).json({ ok: false, error: 'cerebro_unconfigured' });
    return;
  }
  try {
    const upstream = await fetch(`${base}/punto-medio/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    });
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}: ${body.slice(0, 200)}`);
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'ok',
    });
    res.setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Re-índice handler — wires to nothing destructive yet, but logs. ─
adminRouter.post('/reindex', async (req, res) => {
  await auditFromReq(req, {
    verb: 'solicitó re-índice',
    resource: 'corpus completo',
    resource_kind: 'system',
    result: 'ok',
    metadata: { note: 'queued — worker no arranca aún en producción' },
  });
  res.json({
    ok: true,
    queued: true,
    note: 'Job marcado para reproceso. El worker batch lo recoge en la próxima ventana.',
  });
});

// ─── Workers (mock — legacy worker doesn't publish status today) ─────
adminRouter.get('/workers', (_req, res) => {
  res.json(
    mocked({
      items: [
        { name: 'scraper-orden-del-dia',    schedule: '0 7 * * 1-5',  last_run_iso: '2026-04-26T13:55:00Z', last_duration_ms: 82_000,  ok: true,  total_runs: 128,  success_rate_pct: 99.2 },
        { name: 'scraper-actas-plenaria',   schedule: '0 22 * * 1-5', last_run_iso: '2026-04-25T22:04:00Z', last_duration_ms: 258_000, ok: true,  total_runs: 94,   success_rate_pct: 100  },
        { name: 'scraper-expedientes-sil',  schedule: '*/15 * * * *', last_run_iso: '2026-04-26T14:30:00Z', last_duration_ms: 38_000,  ok: false, total_runs: 8412, success_rate_pct: 96.7, error: '3× 502 del SIL' },
        { name: 'transcribe-whisper-batch', schedule: 'evento',       last_run_iso: '2026-04-26T13:58:00Z', last_duration_ms: 724_000, ok: true,  total_runs: 341,  success_rate_pct: 98.4 },
        { name: 'embed-rag-chunks',         schedule: 'evento',       last_run_iso: '2026-04-26T14:01:00Z', last_duration_ms: 44_000,  ok: true,  total_runs: 1207, success_rate_pct: 99.9 },
        { name: 'consolidate-cerebro',      schedule: '0 3 * * *',    last_run_iso: '2026-04-26T03:00:00Z', last_duration_ms: 378_000, ok: true,  total_runs: 62,   success_rate_pct: 100  },
      ],
    }),
  );
});

// ─── Build info ──────────────────────────────────────────────────────
adminRouter.get('/build', (_req, res) => {
  res.json(
    live({
      version: process.env.SHIFT_CL2_VERSION ?? '0.1.0',
      build: process.env.SHIFT_CL2_BUILD ?? 'dev',
      deployed_at: process.env.SHIFT_CL2_DEPLOYED_AT ?? null,
      node: process.version,
      region: process.env.RAILWAY_REGION ?? process.env.AWS_REGION ?? 'local',
      host: process.env.PUBLIC_API_HOST ?? 'localhost:3001',
      locale: 'es-CR · UTC-6',
    }),
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────

function initialsForEmail(email: string | null | undefined): string {
  if (!email) return '??';
  const local = email.split('@')[0] ?? '';
  const parts = local.replace(/[._-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function quoteCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Podcasts telemetry ──────────────────────────────────────────────
//
// Operator visibility into the podcast pipeline: how many today / week,
// status breakdown, ElevenLabs char cost, fail rate, and the most
// recent rows so they can debug a stuck job.
adminRouter.get('/podcasts/stats', async (req, res) => {
  try {
    const s = supa();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { count: total },
      { count: count24h },
      { count: count7d },
      { count: failed7d },
      { count: inFlight },
      { data: byStatusRows },
      { data: bySourceRows },
      { data: costRows },
      { data: recentRows },
    ] = await Promise.all([
      s.from('podcasts').select('id', { count: 'exact', head: true }),
      s
        .from('podcasts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since24h),
      s
        .from('podcasts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since7d),
      s
        .from('podcasts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('created_at', since7d),
      s
        .from('podcasts')
        .select('id', { count: 'exact', head: true })
        .in('status', ['queued', 'scripting', 'tts', 'encoding']),
      s.from('podcasts').select('status').limit(2000),
      s.from('podcasts').select('source_type').limit(2000),
      s
        .from('podcasts')
        .select('cost_chars, duration_actual_s')
        .gte('created_at', since7d)
        .not('cost_chars', 'is', null)
        .limit(2000),
      s
        .from('podcasts')
        .select(
          'id, source_type, source_id, title, status, progress, error, cost_chars, duration_actual_s, created_at, finished_at',
        )
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of (byStatusRows ?? []) as Array<{ status: string }>) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }
    const bySource: Record<string, number> = {};
    for (const r of (bySourceRows ?? []) as Array<{ source_type: string }>) {
      bySource[r.source_type] = (bySource[r.source_type] ?? 0) + 1;
    }
    const cost = (costRows ?? []).reduce(
      (acc, r) => {
        const cr = r as { cost_chars: number | null; duration_actual_s: number | null };
        return {
          chars7d: acc.chars7d + (cr.cost_chars ?? 0),
          duration_s_7d: acc.duration_s_7d + (cr.duration_actual_s ?? 0),
        };
      },
      { chars7d: 0, duration_s_7d: 0 },
    );

    res.json(
      live({
        totals: {
          all_time: total ?? 0,
          last_24h: count24h ?? 0,
          last_7d: count7d ?? 0,
          failed_7d: failed7d ?? 0,
          in_flight: inFlight ?? 0,
        },
        by_status: byStatus,
        by_source_type: bySource,
        cost: {
          // Eleven_multilingual_v2 ≈ $0.30 / 1k chars on the standard
          // tier. Estimate USD client-side from chars.
          chars_7d: cost.chars7d,
          duration_seconds_7d: cost.duration_s_7d,
        },
        recent: recentRows ?? [],
      }),
    );
  } catch (err) {
    req.log?.warn('admin/podcasts/stats failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── SharePoint crawler — manual trigger (dev + ops) ─────────────────
//
// POST /api/admin/crawler/run/:list_id
//
// Fires crawlList() in the background for the given list_id (GUID or Title).
// Returns immediately with a job_id so the caller can poll the cursor table
// to see progress.
//
// Auth: inherits the adminRouter role guard (admin | operador only).
//
// TODO: when we add a proper job queue (BullMQ or Cloud Tasks), wire this
// to enqueue rather than spawning a background Promise. For now the background
// Promise is fine for Cloud Run (single instance, demo scale).
adminRouter.post('/crawler/run/:list_id', async (req, res) => {
  const listId = req.params.list_id;
  if (!listId || listId.trim().length < 2) {
    res.status(400).json({ ok: false, error: 'list_id required (GUID or Title)' });
    return;
  }

  // Use the provided list_title from body, or fall back to the list_id as label.
  const listTitle = typeof req.body?.list_title === 'string'
    ? req.body.list_title
    : listId;

  const jobId = `sp-crawl-${Date.now()}-${listId.slice(0, 8)}`;

  // Fire and forget — log result when done.
  void crawlList(listId, listTitle).then((result) => {
    req.log?.info('admin.crawler.run: completed', {
      job_id: jobId,
      list_id: listId,
      items_new: result.items_new,
      items_updated: result.items_updated,
      errors: result.errors,
      duration_ms: result.duration_ms,
    });
    void audit({
      actor_kind: 'system',
      verb: 'completó crawler',
      resource: `SharePoint list ${listTitle}`,
      resource_kind: 'system',
      result: result.errors > 0 ? 'error' : 'ok',
      metadata: {
        job_id: jobId,
        items_new: result.items_new,
        items_seen: result.items_seen,
        errors: result.errors,
      },
    }).catch(() => undefined);
  }).catch((err) => {
    req.log?.error('admin.crawler.run: failed', {
      job_id: jobId,
      list_id: listId,
      error: (err as Error).message,
    });
  });

  await auditFromReq(req, {
    verb: 'disparó crawler',
    resource: `SharePoint list ${listTitle}`,
    resource_kind: 'system',
    result: 'ok',
    metadata: { job_id: jobId, list_id: listId },
  });

  res.json({ ok: true, job_id: jobId, list_id: listId, started_at: new Date().toISOString() });
});

// Boot — log a one-time line so the operator can see the audit_log
// will receive entries when actions land.
void audit({
  actor_kind: 'system',
  verb: 'arrancó',
  resource: 'admin BFF',
  resource_kind: 'system',
  result: 'ok',
}).catch(() => undefined);

export { adminRouter };
