import { Router } from 'express';
import type { CerebroRequest } from '@shift-cl2/shared-types';
import { cerebroStream } from '../services/cerebroClient.js';

export const chatRouter = Router();

chatRouter.post('/stream', async (req, res) => {
  const body = req.body as Partial<CerebroRequest>;

  if (!body.agent_id || !body.query) {
    res.status(400).json({ ok: false, error: 'agent_id and query required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await cerebroStream({
      tenant: 'cl2',
      agent_id: body.agent_id,
      query: body.query,
      conversation_id: body.conversation_id,
      deep_insight: body.deep_insight ?? false,
      model_override: body.model_override,
      onChunk: (chunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
    });
    res.write('data: {"type":"done"}\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', payload: (err as Error).message })}\n\n`);
    res.end();
  }
});
