import { Router } from 'express';
import { loadAgents } from '@shift-cl2/cerebro-config/agents/index.js';

export const agentsRouter = Router();

agentsRouter.get('/', (_req, res) => {
  const agents = loadAgents().map((a) => ({
    id: a.id,
    display_name: a.display_name,
    tagline: a.tagline,
    domain: a.domain,
    default_model: a.default_model,
    deep_insight_model: a.deep_insight_model,
    deep_insight_default_off: a.deep_insight_default_off ?? false,
  }));
  res.json({ ok: true, agents });
});
