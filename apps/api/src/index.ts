import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Load .env.local first (dev), then .env (defaults). Searches cwd and repo root.
const candidates = [
  join(process.cwd(), '.env.local'),
  join(process.cwd(), '.env'),
  join(process.cwd(), '..', '..', '.env.local'),
  join(process.cwd(), '..', '..', '.env'),
];
for (const path of candidates) {
  if (existsSync(path)) config({ path, override: false });
}

// Sentry MUST be initialized before importing express so its
// auto-instrumentation can wrap the framework. No-op when SENTRY_DSN
// isn't set (local dev) — production sets it via env.
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? 'production',
    // Sample modestly — error events always fire, but we don't need
    // performance traces on every request at this scale.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Pull the deploy SHA in if the env provides one (Railway/Vercel
    // expose it). Helps tie errors to a specific build.
    release: process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.GIT_COMMIT_SHA,
  });
}

import express from 'express';
import cors from 'cors';
import { agentsRouter } from './routes/agents.js';
import { chatRouter } from './routes/chat.js';
import { ingestRouter } from './routes/ingest.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { uploadsRouter } from './routes/uploads.js';
import { expedientesRouter } from './routes/expedientes.js';
import { puntoMedioRouter } from './routes/puntoMedio.js';
import { adminRouter } from './routes/admin.js';
import { meRouter } from './routes/me.js';
import { silRouter } from './routes/sil.js';
import { workspaceRouter } from './routes/workspace.js';
import { conversationsRouter } from './routes/conversations.js';
import { voiceRouter } from './routes/voice.js';
import { publicDemoRouter } from './routes/publicDemo.js';
import { podcastsRouter } from './routes/podcasts.js';
import { transcriptsAdminRouter, internalTriggersRouter } from './routes/transcripts.js';
import { centinelaAdminRouter, centinelaInternalRouter, centinelaUserRouter } from './routes/centinela.js';
import { onboardingRouter } from './routes/onboarding.js';
import { neuronRouter } from './routes/neuron.js';
import { clientesRouter } from './routes/clientes.js';
import { feedbackRouter } from './routes/feedback.js';
import { requestContext } from './middleware/requestContext.js';
import { rateLimit } from './middleware/rateLimit.js';
import { logger } from './services/logger.js';

const app = express();
const port = Number(process.env.API_PORT ?? 3001);

const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',');

app.use(cors({ origin: allowed, credentials: true, exposedHeaders: ['X-Request-Id'] }));
app.use(express.json({ limit: '10mb' }));
app.use(requestContext);

// /health stays unrate-limited — load balancers hammer it.
app.use('/health', healthRouter);
// /api/me — endpoint que devuelve el access del user actual (status + role).
// El frontend lo llama post-auth para decidir si mostrar la app o la
// pantalla "pendiente de aprobación". Rate limit alto porque el cliente
// puede consultarlo seguido en navigation events.
app.use(
  '/api/me',
  rateLimit({ bucket: 'me', max: 120, windowMs: 60_000 }),
  meRouter,
);
// Agents list is anon + cheap, but a runaway client could still hit it
// thousands of times. Loose cap keeps the endpoint useful for the SPA
// without inviting accidental DDoS.
app.use(
  '/api/agents',
  rateLimit({ bucket: 'agents', max: 60, windowMs: 60_000 }),
  agentsRouter,
);
app.use(
  '/api/chat',
  rateLimit({ bucket: 'chat', max: 30, windowMs: 60_000 }),
  chatRouter,
);
app.use(
  '/api/ingest',
  rateLimit({ bucket: 'ingest', max: 10, windowMs: 60_000 }),
  ingestRouter,
);
app.use(
  '/api/sessions',
  rateLimit({ bucket: 'sessions', max: 60, windowMs: 60_000 }),
  sessionsRouter,
);
app.use(
  '/api/uploads',
  // Tighter cap than ingest — submitting a YouTube URL kicks the legacy
  // worker which is slow + costs RapidAPI quota.
  rateLimit({ bucket: 'uploads', max: 5, windowMs: 60_000 }),
  uploadsRouter,
);
app.use(
  // Expediente detail page hits this on every navigation; cap is generous
  // because GCS sign URL calls are cheap and the supabase reads are
  // cached server-side.
  '/api/expedientes',
  rateLimit({ bucket: 'expedientes', max: 120, windowMs: 60_000 }),
  expedientesRouter,
);
app.use(
  // Admin-facing review queue. Tight cap — operator clicks, not bot loops.
  '/api/punto-medio',
  rateLimit({ bucket: 'punto_medio', max: 60, windowMs: 60_000 }),
  puntoMedioRouter,
);
app.use(
  // Admin console (read-only summaries + mocked queues for the demo).
  // Tight cap because every section paint hits one of these.
  '/api/admin',
  rateLimit({ bucket: 'admin', max: 120, windowMs: 60_000 }),
  adminRouter,
);
app.use(
  // SIL browse — list/filter the SIL catalog. Generous cap because the
  // UI fires several reads on first paint (coverage + facets + page 1).
  '/api/sil',
  rateLimit({ bucket: 'sil', max: 240, windowMs: 60_000 }),
  silRouter,
);
app.use(
  // Workspace "Hojas" — canvas + node CRUD + export. Per-user data with
  // RLS; cap is generous because auto-save patches fire every ~800ms.
  '/api/workspace',
  rateLimit({ bucket: 'workspace', max: 300, windowMs: 60_000 }),
  workspaceRouter,
);
app.use(
  // /api/neuron — per-user memory proxy to Cerebro. Server-side token,
  // realm hardcoded to "cl2". Each call is small (list / read / patch
  // small files) but a panel that polls every few seconds is plausible,
  // so generous cap. See routes/neuron.ts and services/cerebroNeuron.ts.
  '/api/neuron',
  rateLimit({ bucket: 'neuron', max: 120, windowMs: 60_000 }),
  neuronRouter,
);
app.use(
  // /api/clientes — clientes que cada consultor asesora. Cada cliente
  // se sincroniza también como /memories/clientes/<slug>.md en la
  // neurona. CRUD sencillo, cap razonable porque el usuario carga
  // la lista cada vez que abre el sidebar de Centinela o Mi memoria.
  '/api/clientes',
  rateLimit({ bucket: 'clientes', max: 120, windowMs: 60_000 }),
  clientesRouter,
);
app.use(
  // /api/feedback — bandeja de bugs/preguntas/ideas. POST con multipart
  // para screenshots; cap por minuto bajo porque cada reporte es un
  // intentional action, no polling.
  '/api/feedback',
  rateLimit({ bucket: 'feedback', max: 20, windowMs: 60_000 }),
  feedbackRouter,
);
// Admin feedback inbox se monta DENTRO del adminRouter (admin.ts mount
// abajo) para heredar el role guard. Ver el `adminRouter.use('/feedback', …)`
// en routes/admin.ts.
app.use(
  // Chat history — sidebar hydration + multi-device read across the
  // user's persisted conversations. Read-heavy, low write volume.
  '/api/conversations',
  rateLimit({ bucket: 'conversations', max: 240, windowMs: 60_000 }),
  conversationsRouter,
);
app.use(
  // Public demo chat — anonymous traffic from /landing. Tight per-IP
  // burst cap layered on top of the route's own 5-prompts-per-24h hard
  // limit (defense in depth: this stops scripted bursts; the inner cap
  // stops a returning visitor from exceeding their daily quota).
  '/api/public',
  rateLimit({ bucket: 'public', max: 30, windowMs: 60_000 }),
  publicDemoRouter,
);
app.use(
  // Podcasts — async TTS pipeline. Status polling is cheap; the heavy
  // POST is gated server-side by the per-user daily cap (5/24h) and
  // the global cost ceiling implicit in script + TTS char budgets.
  '/api/podcasts',
  rateLimit({ bucket: 'podcasts', max: 60, windowMs: 60_000 }),
  podcastsRouter,
);
app.use(
  // Voice → prompt. Tight cap because each request hits ElevenLabs
  // (paid). 30/min/user covers heavy dictation; abuse hits the cap.
  '/api/voice',
  rateLimit({ bucket: 'voice', max: 30, windowMs: 60_000 }),
  voiceRouter,
);
app.use(
  // Transcript admin — manual trigger desde la UI admin.
  // Subido a 120/min porque la UI hace polling (status + details) y un
  // operador navegando entre sesiones golpea fácil 10 requests/min al
  // abrir cada item. 2026-05-12: con 10/min Carlos veía rate_limit al
  // refrescar la cola de revisión.
  '/api/admin/transcripts',
  rateLimit({ bucket: 'transcripts_admin', max: 120, windowMs: 60_000 }),
  transcriptsAdminRouter,
);
app.use(
  // Internal Cloud Scheduler triggers. High cap because the secret
  // header is the auth gate — rate limit is defense-in-depth only.
  '/api/internal',
  rateLimit({ bucket: 'internal', max: 60, windowMs: 60_000 }),
  internalTriggersRouter,
);
app.use(
  // Centinela admin triggers — manual re-runs from the admin UI.
  // Low cap: operator action, not polling.
  '/api/admin/centinela',
  rateLimit({ bucket: 'centinela', max: 60, windowMs: 60_000 }),
  centinelaAdminRouter,
);
app.use(
  // Centinela Cloud Scheduler triggers. Shares the same secret-header
  // auth gate as the youtube-sync internal router above.
  '/api/internal/centinela',
  rateLimit({ bucket: 'centinela', max: 60, windowMs: 60_000 }),
  centinelaInternalRouter,
);
app.use(
  // Centinela user-facing endpoints — feed, watchlist, prefs, summary.
  // Auth: getUserIdFromRequest (Supabase JWT). Rate limit is generous —
  // the page polls /summary on focus and after every mutation.
  '/api/centinela',
  rateLimit({ bucket: 'centinela', max: 240, windowMs: 60_000 }),
  centinelaUserRouter,
);
app.use(
  // Onboarding wizard endpoints — profile + magic-help + watchlist suggestions.
  // The magic-help / suggest-watchlist routes call OpenRouter, so the rate
  // limit is tighter than read-only summary polling.
  '/api/onboarding',
  rateLimit({ bucket: 'onboarding', max: 30, windowMs: 60_000 }),
  onboardingRouter,
);

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  req.log?.error('unhandled', { error: err.message, stack: err.stack });
  // Pipe to Sentry too — JSON logs go to stdout, but Sentry is the
  // place that pages on regressions. Tag with request id so the
  // log line and the Sentry event line up 1:1.
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err, {
      tags: { request_id: String(req.requestId ?? 'unknown'), route: req.path },
    });
  }
  res.status(500).json({ ok: false, error: 'internal_error', request_id: req.requestId });
});

app.listen(port, () => {
  logger.info('api_listening', {
    port,
    cerebro: process.env.CEREBRO_BASE_URL,
    tenant: process.env.CEREBRO_TENANT,
  });
});
