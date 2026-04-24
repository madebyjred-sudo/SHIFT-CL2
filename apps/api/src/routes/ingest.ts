import { Router } from 'express';

export const ingestRouter = Router();

ingestRouter.post('/pdf', async (req, res) => {
  res.json({
    ok: true,
    message: 'pdf ingest stub — to be implemented in Sprint 3',
    received: req.body?.filename ?? null,
  });
});

ingestRouter.post('/youtube', async (req, res) => {
  res.json({
    ok: true,
    message: 'youtube ingest stub — to be implemented in Sprint 3',
    url: req.body?.url ?? null,
  });
});
