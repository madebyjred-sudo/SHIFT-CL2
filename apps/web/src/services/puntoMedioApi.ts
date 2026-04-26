/**
 * Punto Medio API client — admin review queue.
 *
 * Targets the BFF proxy at /api/punto-medio/* (which gates auth + forwards
 * to cerebro). Frontend never talks to cerebro directly.
 */
import { supabase } from '@/lib/supabase';

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
  pattern_type?: string;
  region?: string;
  occurrence_count?: number;
  scope?: string;
  tenant_id?: string;
  version?: number;
  first_seen_at?: string;
}

export interface PendingBundle {
  ok: true;
  pending_consolidations: PendingItem[];
  pending_consolidations_count: number;
  pending_patterns: PendingItem[];
  pending_patterns_count: number;
  /** True when the BFF couldn't reach Cerebro and returned an empty
   *  bundle. UI should show a banner instead of "no hay items". */
  degraded?: boolean;
  degraded_reason?: string;
}

async function authHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, ...extra }
    : { ...extra };
}

export async function fetchPending(): Promise<PendingBundle> {
  const res = await fetch('/api/punto-medio/pending', { headers: await authHeaders() });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.detail ?? detail?.error ?? `http ${res.status}`);
  }
  return res.json();
}

export async function reviewPendingItem(args: {
  id: number;
  action: 'approve' | 'reject';
  item_type: 'consolidation' | 'pattern';
}): Promise<void> {
  const res = await fetch(`/api/punto-medio/review/${args.id}`, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: args.action, item_type: args.item_type }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error ?? `http ${res.status}`);
  }
}
