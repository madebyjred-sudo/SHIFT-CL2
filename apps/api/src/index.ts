import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { agentsRouter } from './routes/agents.js';
import { chatRouter } from './routes/chat.js';
import { ingestRouter } from './routes/ingest.js';
import { healthRouter } from './routes/health.js';

const app = express();
const port = Number(process.env.API_PORT ?? 3001);

const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',');

app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/health', healthRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/ingest', ingestRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api error]', err);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(port, () => {
  console.log(`[shift-cl2/api] listening on :${port}`);
  console.log(`[shift-cl2/api] cerebro=${process.env.CEREBRO_BASE_URL} tenant=${process.env.CEREBRO_TENANT}`);
});
