import { Router } from 'express';
import { loadAgents } from '../services/agentLoader.js';

export const agentsRouter = Router();

agentsRouter.get('/', (req, res) => {
  try {
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
  } catch (err) {
    req.log.error('agents_load_failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'agents_load_failed', request_id: req.requestId });
  }
});
