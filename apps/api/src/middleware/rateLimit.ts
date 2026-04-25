/**
 * In-memory rate limit — fixed-window per (userId | ip) per route bucket.
 *
 * Single-process only. Good enough for the demo VPS; if/when we scale to
 * multiple API replicas, swap the store for Redis (interface stays the same).
 *
 * Limits are deliberately loose for the demo — the goal is "block a
 * runaway loop", not enforce billing tiers.
 */
import type { Request, Response, NextFunction } from 'express';
import { getUserIdFromRequest } from '../services/auth.js';

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOpts {
  /** Bucket label — keeps /chat counts separate from /ingest counts. */
  bucket: string;
  /** Max requests per window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

const store = new Map<string, Bucket>();

function clientKey(req: Request): string {
  // Trust X-Forwarded-For only when behind a known proxy (set in nginx);
  // fall back to socket addr otherwise.
  const fwd = req.headers['x-forwarded-for'];
  const ipFromFwd = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
  return ipFromFwd || req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimit(opts: RateLimitOpts) {
  return async function rateLimitMw(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Authed users are tracked per-user (more lenient — they're known good);
    // anonymous requests are tracked per-ip.
    const userId = await getUserIdFromRequest(req).catch(() => null);
    const id = userId ?? clientKey(req);
    const key = `${opts.bucket}:${id}`;

    const now = Date.now();
    const existing = store.get(key);

    if (!existing || existing.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + opts.windowMs });
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(opts.max - 1));
      next();
      return;
    }

    if (existing.count >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', '0');
      req.log?.warn('rate_limited', { bucket: opts.bucket, key: id, retryAfter });
      res.status(429).json({
        ok: false,
        error: 'rate_limit',
        message: 'Demasiadas consultas en poco tiempo. Esperá un momento.',
        retry_after_s: retryAfter,
      });
      return;
    }

    existing.count += 1;
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(opts.max - existing.count));
    next();
  };
}

// Periodic sweep so the map doesn't grow unbounded for one-off ips.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.resetAt <= now) store.delete(k);
  }
}, 60_000).unref();
