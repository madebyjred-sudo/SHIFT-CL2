/**
 * Admin console — read-only endpoints powering the admin UI.
 *
 * Today these surface a mix of:
 *   - Live data from Supabase (sessions, expedientes, chunk counts).
 *   - Live data from Cerebro (agents registry, punto medio counts).
 *   - Honest mocks for surfaces we haven't yet built backends for
 *     (transcripciones moderation queue, audit log, users invite flow).
 *     Marked with `mock: true` in the response so the UI can flag them.
 *
 * Auth: any authenticated user can call these during the demo. When we
 * open up to outside tenants, hoist the auth guard one level and have
 * it check a server-side role claim before proceeding. No write
 * endpoints are wired here yet — every action button in the UI either
 * routes to an existing endpoint (e.g. punto-medio review) or pops a
 * "feature pending" toast.
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const adminRouter = Router();

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type AdminResponse<T> = MockedResponse<T> | LiveResponse<T>;

function mocked<T>(data: T): MockedResponse<T> {
  return { ok: true, mock: true, generated_at: new Date().toISOString(), data };
}
function live<T>(data: T): LiveResponse<T> {
  return { ok: true, mock: false, generated_at: new Date().toISOString(), data };
}

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ─── Operational summary ─────────────────────────────────────────────
// Aggregates the bits the OverviewSection needs in one call so the UI
// doesn't fan out 5 fetches on first paint. Rolls up live counts where
// available, mock counts where not yet — flagged per metric.
adminRouter.get('/summary', async (req, res) => {
  try {
    const s = supa();
    const [{ count: chunksCount }, { count: sessionsCount }, { count: expedientesCount }] =
      await Promise.all([
        s.from('legislative_chunks').select('id', { count: 'exact', head: true }),
        s.from('sessions').select('id', { count: 'exact', head: true }),
        s.from('sil_expedientes').select('id', { count: 'exact', head: true }),
      ]);
    res.json(
      live({
        chunks: chunksCount ?? 0,
        sessions: sessionsCount ?? 0,
        expedientes: expedientesCount ?? 0,
        // The live surfaces below would need new tables/agg — surface as
        // null so the UI can render "—" instead of bogus numbers.
        consultas_24h: null,
        cita_rate_pct: null,
        latency_p95_ms: null,
        cost_24h_usd: null,
      }),
    );
  } catch (err) {
    req.log?.warn('admin/summary failed', { err: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Transcripciones moderation queue (mock today) ────────────────────
// The product loop: Whisper transcribes → admin approves → text becomes
// citable for Lexa. Right now we don't auto-transcribe in production
// (legacy worker still runs offline), so the queue is mocked. The shape
// matches what the real endpoint will return once `legacy-cl2-worker`
// pushes status events — UI never has to change.
interface MockTranscriptionItem {
  id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;            // ISO
  duration_seconds: number;
  confidence: number;      // 0–100
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt: string;
  excerpt_ts: string;      // h:mm:ss
}

const MOCK_QUEUE: MockTranscriptionItem[] = [
  {
    id: 'tr-1287',
    session_id: 128,
    sesion_label: 'Plenaria N°128',
    expediente: 'Exp. 23.456',
    date: '2026-04-22T00:00:00Z',
    duration_seconds: 8100,
    confidence: 84,
    flagged_segments: 3,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Dip. Calderón Castro',
    excerpt:
      'El artículo catorce, en su redacción actual, deja un vacío que esta moción busca cerrar de manera permanente.',
    excerpt_ts: '1:57:26',
  },
  {
    id: 'tr-1286',
    session_id: 0,
    sesion_label: 'Comisión Hacendarios',
    expediente: 'Exp. 24.018',
    date: '2026-04-19T00:00:00Z',
    duration_seconds: 10920,
    confidence: 71,
    flagged_segments: 11,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Dip. Mora Castillo',
    excerpt:
      'Solicito la suspensión del trámite hasta que se incorpore el dictamen afirmativo de minoría que presentamos el martes.',
    excerpt_ts: '0:48:11',
  },
  {
    id: 'tr-1285',
    session_id: 127,
    sesion_label: 'Plenaria N°127',
    expediente: 'Exp. 23.901',
    date: '2026-04-21T00:00:00Z',
    duration_seconds: 6480,
    confidence: 92,
    flagged_segments: 1,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Presidencia',
    excerpt:
      'Aprobado por unanimidad de los presentes. Se cierra la sesión a las dieciocho horas con cinco minutos.',
    excerpt_ts: '1:43:08',
  },
  {
    id: 'tr-1284',
    session_id: 126,
    sesion_label: 'Plenaria N°126',
    expediente: null,
    date: '2026-04-20T00:00:00Z',
    duration_seconds: 2700,
    confidence: 96,
    flagged_segments: 0,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Presidencia',
    excerpt: 'Iniciamos la sesión con la lectura del orden del día.',
    excerpt_ts: '0:00:24',
  },
  {
    id: 'tr-1283',
    session_id: 125,
    sesion_label: 'Plenaria N°125',
    expediente: null,
    date: '2026-04-18T00:00:00Z',
    duration_seconds: 900,
    confidence: 78,
    flagged_segments: 2,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Secretaría',
    excerpt: 'Por receso parlamentario, suspendemos hasta el lunes.',
    excerpt_ts: '0:12:01',
  },
  {
    id: 'tr-1282',
    session_id: 124,
    sesion_label: 'Comisión Asuntos Sociales',
    expediente: 'Exp. 23.901',
    date: '2026-04-15T00:00:00Z',
    duration_seconds: 9000,
    confidence: 88,
    flagged_segments: 4,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Dip. Vargas Soto',
    excerpt:
      'Es necesario incluir un transitorio que proteja los derechos adquiridos antes de la entrada en vigencia.',
    excerpt_ts: '2:14:33',
  },
  {
    id: 'tr-1281',
    session_id: 123,
    sesion_label: 'Comisión Jurídicos',
    expediente: 'Exp. 22.811',
    date: '2026-04-12T00:00:00Z',
    duration_seconds: 4920,
    confidence: 65,
    flagged_segments: 8,
    status: 'pending',
    source: 'Whisper-large · v3',
    speaker: 'Sin atribuir',
    excerpt: 'Inaudible — solapamiento con micrófono abierto.',
    excerpt_ts: '0:42:18',
  },
];

adminRouter.get('/transcripciones', (_req, res) => {
  const counts = {
    pending: MOCK_QUEUE.filter((q) => q.status === 'pending').length,
    in_progress: 2,
    approved: 148,
    rejected: 6,
  };
  res.json(mocked({ counts, items: MOCK_QUEUE }));
});

adminRouter.get('/transcripciones/:id', (req, res) => {
  const item = MOCK_QUEUE.find((q) => q.id === req.params.id);
  if (!item) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  // Mock the per-item detail — diarization + segments. Real backend would
  // pull these from the transcript JSON the legacy worker writes to GCS.
  const segments = [
    { ts: '1:55:42', speaker: 'Presidencia', text: 'Tiene la palabra el diputado Calderón Castro.', confidence: 98, flagged: false },
    { ts: '1:57:26', speaker: 'Dip. Calderón', text: item.excerpt, confidence: item.confidence, flagged: false, highlighted: true },
    { ts: '2:01:08', speaker: '⚠ Sin atribuir', text: 'Inaudible — solapamiento con micrófono abierto del fondo del recinto.', confidence: 42, flagged: true },
    { ts: '2:05:14', speaker: 'Dip. Mora', text: 'Solicito moción de orden, señor Presidente.', confidence: 99, flagged: false },
    { ts: '2:08:01', speaker: 'Presidencia', text: `Procedemos a la votación nominal del expediente ${item.expediente?.replace('Exp. ', '') ?? 'N/D'}.`, confidence: 99, flagged: false },
    { ts: '2:11:33', speaker: 'Secretaría', text: '38 a favor, 7 en contra, 2 abstenciones. Aprobado.', confidence: 97, flagged: false },
  ];
  const diarization = [
    { speaker: 'Presidencia', total_seconds: 862, color: '#7A3B47' },
    { speaker: 'Dip. Calderón Castro', total_seconds: 2284, color: '#1534dc' },
    { speaker: 'Dip. Mora Castillo', total_seconds: 767, color: '#10b981' },
    { speaker: 'Secretaría', total_seconds: 318, color: '#f59e0b' },
  ];
  res.json(mocked({ item, segments, diarization, total_segments: 1247, total_words: 18402 }));
});

// Action endpoint — mocked. Right now just echoes back the action so the
// frontend can complete its optimistic update flow during the demo.
adminRouter.post('/transcripciones/:id/review', (req, res) => {
  const action = req.body?.action;
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action must be approve|reject' });
    return;
  }
  res.json({ ok: true, mock: true, id: req.params.id, action, ts: new Date().toISOString() });
});

// ─── Audit log (mock) ────────────────────────────────────────────────
interface MockAuditEntry {
  ts: string;       // ISO
  actor: string;    // initials or "sys"
  actor_kind: 'human' | 'system';
  verb: string;
  resource: string;
  ip: string | null;
  result: 'ok' | 'retry' | 'error';
}

const MOCK_AUDIT: MockAuditEntry[] = [
  { ts: '2026-04-26T14:18:00Z', actor: 'JM', actor_kind: 'human',  verb: 'aprobó',     resource: 'consolidación #214 · Lexa',                            ip: '186.27.x.x', result: 'ok' },
  { ts: '2026-04-26T14:12:00Z', actor: 'sys', actor_kind: 'system', verb: 'detectó',    resource: 'patrón "voto cruzado FA-PUSC"',                        ip: null,         result: 'ok' },
  { ts: '2026-04-26T13:55:00Z', actor: 'sys', actor_kind: 'system', verb: 'ingestó',    resource: 'Plenaria N°128 · 2h 15m · 2.840 chunks',               ip: null,         result: 'ok' },
  { ts: '2026-04-26T13:47:00Z', actor: 'DR', actor_kind: 'human',  verb: 'rechazó',    resource: 'transcripción tr-1284 · "mala atribución"',           ip: '186.30.x.x', result: 'ok' },
  { ts: '2026-04-26T13:30:00Z', actor: 'JM', actor_kind: 'human',  verb: 'cambió',     resource: 'system prompt Atlas v18 → v19',                        ip: '186.27.x.x', result: 'ok' },
  { ts: '2026-04-26T13:02:00Z', actor: 'AV', actor_kind: 'human',  verb: 'invitó',     resource: 'tatiana.vargas@asamblea.go.cr',                        ip: '190.4.x.x',  result: 'ok' },
  { ts: '2026-04-26T11:10:00Z', actor: 'sys', actor_kind: 'system', verb: 'falló',      resource: 'scraper-expedientes-sil · timeout',                    ip: null,         result: 'retry' },
  { ts: '2026-04-26T09:00:00Z', actor: 'JM', actor_kind: 'human',  verb: 'desactivó',  resource: 'agente Centinela · ventana 23 min',                   ip: '186.27.x.x', result: 'ok' },
];

adminRouter.get('/audit', (_req, res) => {
  res.json(mocked({ items: MOCK_AUDIT }));
});

// ─── Users (mock) ────────────────────────────────────────────────────
// In Supabase Auth, the SDK can list users with the service-role key.
// We do that lazily — first paint shows a small mock so the UI renders
// instantly even if the listUsers call is slow or fails.
adminRouter.get('/users', async (_req, res) => {
  try {
    const s = supa();
    const { data, error } = await s.auth.admin.listUsers({ page: 1, perPage: 50 });
    if (error) throw new Error(error.message);
    const items = (data?.users ?? []).map((u) => ({
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      role: 'lector' as const,
      status: u.last_sign_in_at ? 'activo' : 'invitado',
    }));
    res.json(live({ items }));
  } catch {
    // Fall back to mock when admin.listUsers isn't available (some
    // self-hosted setups disable it). The UI flag `mock` tells the
    // operator the list isn't authoritative.
    res.json(
      mocked({
        items: [
          { id: 'mock-1', email: 'juanma@shiftlab.cr',         created_at: '2026-01-12T00:00:00Z', last_sign_in_at: new Date(Date.now() - 120_000).toISOString(),   role: 'admin',    status: 'activo'   },
          { id: 'mock-2', email: 'diana.rodriguez@asamblea.go.cr', created_at: '2026-02-03T00:00:00Z', last_sign_in_at: new Date(Date.now() - 14*60_000).toISOString(),  role: 'operador', status: 'activo'   },
          { id: 'mock-3', email: 'andres@shiftlab.cr',         created_at: '2026-02-08T00:00:00Z', last_sign_in_at: new Date(Date.now() - 5*60*60_000).toISOString(), role: 'editor',   status: 'activo'   },
          { id: 'mock-4', email: 'tatiana.vargas@asamblea.go.cr', created_at: '2026-04-22T00:00:00Z', last_sign_in_at: null,                                            role: 'lector',   status: 'invitado' },
          { id: 'mock-5', email: 'msolano@asamblea.go.cr',     created_at: '2026-03-01T00:00:00Z', last_sign_in_at: new Date(Date.now() - 18*60*60_000).toISOString(), role: 'lector',   status: 'activo'   },
          { id: 'mock-6', email: 'rrojas@example.com',         created_at: '2026-04-25T00:00:00Z', last_sign_in_at: null,                                            role: null,       status: 'solicitud' },
        ],
      }),
    );
  }
});

// ─── Workers (cron health, mock today) ───────────────────────────────
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

// ─── Health proxy / build info ───────────────────────────────────────
// Mirrors /health/deep for sections that don't want a separate fetch.
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

export { adminRouter };
