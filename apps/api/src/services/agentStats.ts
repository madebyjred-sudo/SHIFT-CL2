/**
 * In-memory rolling counters per agent.
 *
 * Tracks 24h queries + p50/p95 latency + error rate so the Agentes
 * card surfaces real numbers. Persisted nowhere — process restart
 * resets. Acceptable during the demo because the UI says "últimos 60
 * min" / "24h" and a fresh process starts a fresh window.
 *
 * Why in-memory and not a database table: the chat path is hot, we
 * don't want a write per request. A nightly flush to Supabase would
 * be the next step if/when these numbers need to survive deploys.
 *
 * NOT thread-safe across processes. The BFF runs in a single Node
 * process today so this is fine; if we go multi-instance we'll need
 * Redis or a periodic Supabase aggregate.
 */

interface CallSample {
  ts: number;          // epoch ms
  ms: number;          // total response time
  ok: boolean;
}

interface AgentBucket {
  samples: CallSample[];
}

const WINDOW_MS = 24 * 60 * 60 * 1000;          // keep last 24h of samples
const RECENT_MS = 60 * 60 * 1000;               // "last 60 min" rate
const buckets = new Map<string, AgentBucket>();

function getBucket(agentId: string): AgentBucket {
  let b = buckets.get(agentId);
  if (!b) {
    b = { samples: [] };
    buckets.set(agentId, b);
  }
  return b;
}

function trim(b: AgentBucket): void {
  const cutoff = Date.now() - WINDOW_MS;
  // Walk from the start dropping stale entries. samples are append-only
  // so they're roughly sorted; binary-search would be premature here.
  let i = 0;
  while (i < b.samples.length && b.samples[i]!.ts < cutoff) i++;
  if (i > 0) b.samples.splice(0, i);
}

export function recordAgentCall(agentId: string, ms: number, ok: boolean): void {
  const b = getBucket(agentId);
  b.samples.push({ ts: Date.now(), ms, ok });
  // Trim periodically — no more than once per call. Cheap because we
  // only iterate the head until the first non-stale sample.
  if (b.samples.length > 200) trim(b);
}

export interface AgentStats {
  queries_24h: number;
  queries_recent_60m: number;
  p50_ms: number | null;
  p95_ms: number | null;
  error_rate_pct: number;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx]!;
}

export function snapshotAgent(agentId: string): AgentStats {
  const b = getBucket(agentId);
  trim(b);
  const recentCutoff = Date.now() - RECENT_MS;
  const recentSamples = b.samples.filter((s) => s.ts >= recentCutoff);
  const sortedMs = b.samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = b.samples.filter((s) => !s.ok).length;
  const total = b.samples.length;
  return {
    queries_24h: total,
    queries_recent_60m: recentSamples.length,
    p50_ms: quantile(sortedMs, 0.5),
    p95_ms: quantile(sortedMs, 0.95),
    error_rate_pct: total === 0 ? 0 : (errors / total) * 100,
  };
}

export function snapshotAll(): Record<string, AgentStats> {
  const out: Record<string, AgentStats> = {};
  for (const id of buckets.keys()) {
    out[id] = snapshotAgent(id);
  }
  return out;
}
