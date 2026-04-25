/**
 * Health endpoints — shallow + deep.
 *
 * GET /health        — fast liveness check (no I/O). Used by load balancers.
 * GET /health/deep   — verifies subsystems: Supabase, Vertex auth, OpenRouter
 *                      key. Slower (~1-3s); call before demos / deploys.
 *
 * Each subsystem returns { ok, latency_ms, error? } so failures are easy
 * to diagnose at a glance.
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { listTranscripciones } from '../services/legacyCl2Client.js';
import { sessionContextCacheStats } from '../services/sessionContextLoader.js';
import { withTimeout } from '../services/resilience.js';

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

interface SubsystemResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result?: T; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0 };
  } catch (err) {
    return { ms: Date.now() - t0, error: (err as Error).message };
  }
}

async function checkSupabase(): Promise<SubsystemResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, latency_ms: 0, error: 'env not set' };

  const supa = createClient(url, key, { auth: { persistSession: false } });
  const { result, ms, error } = await timed(async () =>
    withTimeout(
      async (signal) => {
        const { count, error: e } = await supa
          .from('legislative_chunks')
          .select('*', { count: 'exact', head: true })
          .abortSignal(signal);
        if (e) throw new Error(e.message);
        return count ?? 0;
      },
      { ms: 5_000, label: 'health:supabase' },
    ),
  );
  if (error) return { ok: false, latency_ms: ms, error };
  return { ok: true, latency_ms: ms, detail: { chunks: result } };
}

async function checkLegacy(): Promise<SubsystemResult> {
  const base = process.env.LEGACY_CL2_API_URL;
  if (!base) return { ok: false, latency_ms: 0, error: 'LEGACY_CL2_API_URL not set' };
  const today = new Date().toISOString().slice(0, 10);
  const { result, ms, error } = await timed(async () => {
    const rows = await listTranscripciones({
      fecha_inicio: today,
      fecha_fin: today,
      limit: 1,
    });
    return rows.length;
  });
  if (error) return { ok: false, latency_ms: ms, error };
  return { ok: true, latency_ms: ms, detail: { sample_rows: result } };
}

/**
 * Cerebro Punto Medio reachability + a count of approved consolidations
 * (the institutional flywheel's enrichment surface). NOT critical for
 * chat to function — the BFF degrades gracefully when this returns
 * not-ok — but it tells the operator at a glance whether
 * /admin/punto-medio approvals will reach the live system prompt.
 */
async function checkPuntoMedio(): Promise<SubsystemResult> {
  const base = process.env.CEREBRO_BASE_URL;
  if (!base) return { ok: false, latency_ms: 0, error: 'CEREBRO_BASE_URL not set' };
  const tenant = process.env.CEREBRO_TENANT ?? 'cl2';
  const { result, ms, error } = await timed(async () =>
    withTimeout(
      async (signal) => {
        const res = await fetch(`${base}/punto-medio/rag/${encodeURIComponent(tenant)}`, { signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        return (await res.json()) as {
          combined_rag_length?: number;
          tenant_rag_length?: number;
          patterns_rag_length?: number;
          global_rag_length?: number;
        };
      },
      { ms: 4_000, label: 'health:punto_medio' },
    ),
  );
  if (error) return { ok: false, latency_ms: ms, error };
  // Flag empty enrichment as "ok but quiet" — not an error, just informs
  // the operator that the manual review queue hasn't approved anything yet.
  const lens = {
    combined: result?.combined_rag_length ?? 0,
    tenant: result?.tenant_rag_length ?? 0,
    patterns: result?.patterns_rag_length ?? 0,
    global: result?.global_rag_length ?? 0,
  };
  return {
    ok: true,
    latency_ms: ms,
    detail: { tenant, rag_chars: lens, enriched: lens.combined > 50 },
  };
}

async function checkOpenRouter(): Promise<SubsystemResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, latency_ms: 0, error: 'OPENROUTER_API_KEY not set' };

  // /auth/key returns the key's metadata without consuming credits.
  const { ms, error, result } = await timed(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as { data?: { label?: string } };
    } finally {
      clearTimeout(timer);
    }
  });
  if (error) return { ok: false, latency_ms: ms, error };
  return { ok: true, latency_ms: ms, detail: { label: result?.data?.label } };
}

async function checkVertex(): Promise<SubsystemResult> {
  // Cheap import-time probe: verify GCP env vars exist + service account file
  // is loadable. A real predict() call would burn quota — use /health/embed
  // instead if you need an end-to-end check.
  const project = process.env.GCP_PROJECT_ID;
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!project) return { ok: false, latency_ms: 0, error: 'GCP_PROJECT_ID not set' };
  if (!creds) return { ok: false, latency_ms: 0, error: 'GOOGLE_APPLICATION_CREDENTIALS not set' };

  const { existsSync } = await import('node:fs');
  const t0 = Date.now();
  if (!existsSync(creds)) {
    return { ok: false, latency_ms: Date.now() - t0, error: `creds file missing: ${creds}` };
  }
  return {
    ok: true,
    latency_ms: Date.now() - t0,
    detail: { project, embedding_model: process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001' },
  };
}

healthRouter.get('/deep', async (req, res) => {
  const [supabase, openrouter, vertex, legacy, puntoMedio] = await Promise.all([
    checkSupabase(),
    checkOpenRouter(),
    checkVertex(),
    checkLegacy(),
    checkPuntoMedio(),
  ]);

  // puntoMedio is informational, not gating: chat works without it.
  const criticalOk = supabase.ok && openrouter.ok && vertex.ok && legacy.ok;
  if (!criticalOk) {
    req.log?.warn('health_deep_degraded', {
      supabase: supabase.ok,
      openrouter: openrouter.ok,
      vertex: vertex.ok,
      legacy: legacy.ok,
      punto_medio: puntoMedio.ok,
    });
  }
  res.status(criticalOk ? 200 : 503).json({
    ok: criticalOk,
    timestamp: new Date().toISOString(),
    subsystems: { supabase, openrouter, vertex, legacy, punto_medio: puntoMedio },
    caches: {
      session_context: sessionContextCacheStats(),
    },
  });
});
