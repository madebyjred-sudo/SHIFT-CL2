/**
 * LightRAG client — calls Cerebro's /lightrag/* endpoints.
 *
 * The graph itself lives inside Cerebro (Python) so we just proxy. Two
 * surfaces matter to the BFF:
 *   - query(): the agent tool-calls this to pull a graph-augmented
 *              answer (entities + relations + synthesized text).
 *   - health(): /health/deep on the BFF aggregates this so ops can see
 *              if the graph store is loaded and how big it is.
 *
 * When Cerebro hasn't been deployed with `lightrag-hku` installed, the
 * upstream returns 503 with `error: lightrag_not_installed`. We surface
 * that as a typed result so the agent can fall back to plain hybrid
 * retrieval instead of error-ing the whole turn.
 */
import { logger } from './logger.js';

const CEREBRO_BASE = process.env.CEREBRO_BASE_URL ?? 'http://localhost:8000';
const CEREBRO_KEY = process.env.CEREBRO_API_KEY ?? '';

export type LightragMode = 'local' | 'global' | 'hybrid' | 'naive';

export interface LightragQueryResult {
  ok: true;
  installed: true;
  mode: LightragMode;
  query: string;
  answer: string;
  meta: Record<string, unknown> | null;
}

export interface LightragNotInstalled {
  ok: false;
  installed: false;
  reason: 'lightrag_not_installed';
}

export interface LightragError {
  ok: false;
  installed: true;
  reason: 'upstream_error';
  status: number;
  detail: string;
}

export type LightragResult =
  | LightragQueryResult
  | LightragNotInstalled
  | LightragError;

interface QueryArgs {
  query: string;
  mode?: LightragMode;
  deep_insight?: boolean;
  top_k?: number;
}

export async function queryLightrag(args: QueryArgs): Promise<LightragResult> {
  const url = `${CEREBRO_BASE}/lightrag/query`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CEREBRO_KEY}`,
      },
      body: JSON.stringify({
        query: args.query,
        mode: args.mode ?? 'hybrid',
        deep_insight: args.deep_insight ?? false,
        top_k: args.top_k ?? 10,
      }),
    });
  } catch (err) {
    logger.warn('lightrag fetch failed', { err: String(err) });
    return {
      ok: false,
      installed: true,
      reason: 'upstream_error',
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const body = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (res.status === 503) {
    const detail = (parsed?.detail ?? {}) as Record<string, unknown>;
    if (detail.error === 'lightrag_not_installed') {
      return { ok: false, installed: false, reason: 'lightrag_not_installed' };
    }
  }

  if (!res.ok || !parsed?.ok) {
    return {
      ok: false,
      installed: true,
      reason: 'upstream_error',
      status: res.status,
      detail: body.slice(0, 500),
    };
  }

  return {
    ok: true,
    installed: true,
    mode: (parsed.mode as LightragMode) ?? args.mode ?? 'hybrid',
    query: (parsed.query as string) ?? args.query,
    answer: (parsed.answer as string) ?? '',
    meta: (parsed.meta as Record<string, unknown> | null) ?? null,
  };
}

export interface LightragHealth {
  installed: boolean;
  working_dir: string;
  working_dir_mb: number;
  entity_count: number | null;
  relation_count: number | null;
  build_model: string;
  query_model: string;
}

export async function lightragHealth(): Promise<LightragHealth | null> {
  try {
    const res = await fetch(`${CEREBRO_BASE}/lightrag/health`, {
      headers: { Authorization: `Bearer ${CEREBRO_KEY}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as LightragHealth;
  } catch (err) {
    logger.warn('lightrag health probe failed', { err: String(err) });
    return null;
  }
}
