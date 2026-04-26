/**
 * Punto Medio client — read side of the Cerebro flywheel.
 *
 * Where the Peaje (peajeClient.ts) is the WRITE side (every chat turn
 * fires an insight into peaje_insights), this is the READ side: the BFF
 * pulls APPROVED-only RAG from /punto-medio/rag/{tenant} and injects it
 * as an additional system message into the LLM call.
 *
 * Manual review gate: cerebro's get_dynamic_rag() filters by
 * approval_status='approved'. Until an operator hits the approve button
 * in our /admin/punto-medio page, the consolidated insight stays
 * 'pending' and never enters the RAG. This guarantees zero blind
 * insights affecting Oscar's responses pre-demo.
 *
 * Caching: in-process LRU with a 60-second TTL — the consolidation cron
 * runs every 6h, so 60s of staleness is invisible to the user but cuts
 * the per-turn latency cost of the cerebro hop.
 */
import { withTimeout } from './resilience.js';

const CEREBRO_BASE_URL = process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro.up.railway.app';
const PM_TIMEOUT_MS = 4_000;
const RAG_CACHE_TTL_MS = 60_000;

export interface PuntoMedioRag {
  tenant_id: string;
  global_rag_length: number;
  tenant_rag_length: number;
  patterns_rag_length: number;
  combined_rag_length: number;
  global_rag: string;
  tenant_rag: string;
  patterns_rag: string;
  /** combined_rag = global + tenant + patterns concatenated. The single
   *  string we want to drop into the LLM system prompt. */
  combined_rag?: string;
}

interface RagCacheEntry {
  rag: PuntoMedioRag | null;
  expiresAt: number;
}

const ragCache = new Map<string, RagCacheEntry>();

/**
 * Fetch the approved-only RAG bundle for a tenant. Returns null when the
 * cerebro backend is unreachable, has no approved data, or times out —
 * callers should fall through gracefully (LLM still answers, just
 * without the flywheel-enriched context).
 */
export async function getApprovedRag(tenantId: string): Promise<PuntoMedioRag | null> {
  const now = Date.now();
  const cached = ragCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.rag;

  try {
    const rag = await withTimeout(
      async (signal) => {
        const res = await fetch(`${CEREBRO_BASE_URL}/punto-medio/rag/${encodeURIComponent(tenantId)}`, {
          signal,
        });
        if (!res.ok) throw new Error(`punto-medio rag ${res.status}`);
        return (await res.json()) as PuntoMedioRag;
      },
      { ms: PM_TIMEOUT_MS, label: 'punto-medio:rag' },
    );
    // Best-effort combined_rag if backend doesn't ship it (older cerebro).
    if (!rag.combined_rag) {
      rag.combined_rag = [rag.global_rag, rag.tenant_rag, rag.patterns_rag]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n');
    }
    ragCache.set(tenantId, { rag, expiresAt: now + RAG_CACHE_TTL_MS });
    return rag;
  } catch (err) {
    // Negative cache: shorter TTL so we recover quickly when cerebro's back up.
    ragCache.set(tenantId, { rag: null, expiresAt: now + 15_000 });
    console.warn(`[punto-medio] rag fetch failed (${(err as Error).message}) — proceeding without enrichment`);
    return null;
  }
}

// ─── Admin-only review queue ──────────────────────────────────────────

export interface PendingItem {
  id: number;
  approval_status: 'pending' | 'approved' | 'rejected';
  category: string;
  industry_vertical: string | null;
  consolidated_text?: string;
  pattern_text?: string;
  executive_brief?: string | null;
  source_insight_count: number;
  contributing_tenants?: string;
  confidence_score: number;
  last_consolidated_at?: string;
  last_seen_at?: string;
  created_at?: string;
  // Pattern-only:
  pattern_type?: string;
  region?: string;
  occurrence_count?: number;
  scope?: string;
  tenant_id?: string;
  version?: number;
  first_seen_at?: string;
}

export interface PendingReviewBundle {
  pending_consolidations: PendingItem[];
  pending_consolidations_count: number;
  pending_patterns: PendingItem[];
  pending_patterns_count: number;
}

/** Empty bundle returned when the upstream is degraded so the UI can
 *  render "Cerebro está procesando, refrescá en un minuto" instead of
 *  flashing 502 errors. The admin route already calls
 *  invalidateRagCache after a review, so a momentary read failure here
 *  doesn't poison the chat path. */
const EMPTY_BUNDLE: PendingReviewBundle = {
  pending_consolidations: [],
  pending_consolidations_count: 0,
  pending_patterns: [],
  pending_patterns_count: 0,
};

let lastListInflight: Promise<PendingReviewBundle> | null = null;
const LIST_TIMEOUT_MS = 6_000;
const LIST_DEDUPE_MS = 1_500;
let lastListAt = 0;

export async function listPendingReviews(): Promise<PendingReviewBundle> {
  // Dedupe: if we just kicked off a fetch <1.5s ago and it's still in
  // flight, return that promise. Stops the front-end's auto-refetch
  // loop from stacking 5 concurrent calls onto an already-slow Cerebro.
  if (lastListInflight && Date.now() - lastListAt < LIST_DEDUPE_MS) {
    return lastListInflight;
  }
  lastListAt = Date.now();
  lastListInflight = withTimeout(
    async (signal) => {
      const res = await fetch(`${CEREBRO_BASE_URL}/punto-medio/review`, { signal });
      if (!res.ok) throw new Error(`punto-medio review ${res.status}`);
      return (await res.json()) as PendingReviewBundle;
    },
    { ms: LIST_TIMEOUT_MS, label: 'punto-medio:review_list' },
  ).catch((err) => {
    // Don't propagate timeouts as exceptions — the queue is informational
    // and the chat path doesn't depend on it. Return empty + log.
    if ((err as Error).message?.includes('timed out')) {
      // eslint-disable-next-line no-console
      console.warn('[punto-medio] review list timed out, returning empty bundle');
      return EMPTY_BUNDLE;
    }
    throw err;
  });
  try {
    return await lastListInflight;
  } finally {
    // Clear after a tick so the dedupe window holds.
    setTimeout(() => { lastListInflight = null; }, LIST_DEDUPE_MS);
  }
}

export async function reviewItem(
  id: number,
  args: { action: 'approve' | 'reject'; reviewed_by: string; item_type: 'consolidation' | 'pattern' },
): Promise<{ status: string; new_status: string }> {
  // Drop any cached RAG so the next chat turn picks up the change immediately.
  ragCache.clear();
  return withTimeout(
    async (signal) => {
      const res = await fetch(`${CEREBRO_BASE_URL}/punto-medio/review/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`punto-medio review ${res.status}: ${txt}`);
      }
      return (await res.json()) as { status: string; new_status: string };
    },
    { ms: 8_000, label: 'punto-medio:review_patch' },
  );
}

/**
 * Force-clear the in-process RAG cache. Useful from the admin UI after
 * bulk-approving so the next user turn sees the new corpus right away.
 */
export function invalidateRagCache(): void {
  ragCache.clear();
}
