import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'shift-cl2-api',
    version: '0.1.0',
    tenant: process.env.CEREBRO_TENANT,
    timestamp: new Date().toISOString(),
  });
});
