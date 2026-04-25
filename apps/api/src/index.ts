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

import express from 'express';
import cors from 'cors';
import { agentsRouter } from './routes/agents.js';
import { chatRouter } from './routes/chat.js';
import { ingestRouter } from './routes/ingest.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { uploadsRouter } from './routes/uploads.js';
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

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  req.log?.error('unhandled', { error: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'internal_error', request_id: req.requestId });
});

app.listen(port, () => {
  logger.info('api_listening', {
    port,
    cerebro: process.env.CEREBRO_BASE_URL,
    tenant: process.env.CEREBRO_TENANT,
  });
});
