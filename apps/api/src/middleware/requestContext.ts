/**
 * Request context middleware — attaches a unique requestId + scoped logger
 * to every request. Sets `X-Request-Id` response header so the frontend can
 * surface it in error toasts (massively speeds up cross-stack debugging).
 *
 * Honors an inbound `X-Request-Id` if the caller already has one (useful
 * when the web app generates ids client-side for retry tracing).
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { logger, type Logger } from '../services/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    log: Logger;
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const requestId =
    (typeof inbound === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(inbound) ? inbound : null) ??
    randomUUID();

  req.requestId = requestId;
  req.log = logger.with({ requestId, route: req.path, method: req.method });
  res.setHeader('X-Request-Id', requestId);

  // Skip access logs for health probes — they hammer /health every few
  // seconds in prod and would drown out anything useful.
  const ua = req.headers['user-agent'] ?? '';
  const isHealthProbe =
    req.path === '/health' || (req.path === '/' && ua.includes('kube-probe'));

  const t0 = Date.now();
  if (!isHealthProbe) {
    req.log.debug('request_received', { ua: ua.slice(0, 80) });
  }
  res.on('finish', () => {
    if (isHealthProbe && res.statusCode < 400) return;
    req.log.info('request', {
      status: res.statusCode,
      ms: Date.now() - t0,
    });
  });

  next();
}
