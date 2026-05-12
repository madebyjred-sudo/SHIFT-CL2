/**
 * Typed wrappers for the transcript pipeline admin endpoints.
 *
 * All requests piggyback on the same auth pattern as adminApi.ts:
 * Bearer token from the Supabase session, forwarded as Authorization header.
 *
 * Endpoints:
 *   GET  /api/admin/transcripts/sessions       — list with aggregated counts
 *   GET  /api/admin/transcripts/sessions/:id   — drill-down detail
 *   PATCH /api/admin/transcripts/corrections/:id — accept | reject
 *   POST /api/admin/transcripts/sync           — manual trigger (re-uses existing endpoint)
 */
import { supabase } from '@/lib/supabase';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TranscriptSessionListItem {
  id: string;
  title: string;
  youtube_video_id: string | null;
  source: string;
  status: string;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  llm_reviewed_at: string | null;
  llm_review_model: string | null;
  segments_count: number;
  corrections_count: number;
  corrections_pending: number;
}

export interface TranscriptSegment {
  id: string;
  session_id: string;
  segment_idx: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
  source: string | null;
}

export interface TranscriptCorrection {
  id: string;
  session_id: string;
  segment_id: string | null;
  kind: string;
  span_start: number | null;
  span_end: number | null;
  original_text: string;
  suggested_text: string;
  confidence: number;
  reasoning: string | null;
  human_review: 'pending' | 'accepted' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  model: string | null;
  llm_run_id: string | null;
}

export interface TranscriptSessionDetail {
  id: string;
  title: string;
  youtube_video_id: string | null;
  source: string;
  status: string;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  llm_reviewed_at: string | null;
  llm_review_model: string | null;
  metadata: Record<string, unknown> | null;
}

export interface TranscriptSessionDetailResponse {
  session: TranscriptSessionDetail;
  segments: TranscriptSegment[];
  corrections: {
    pending: TranscriptCorrection[];
    accepted: TranscriptCorrection[];
    rejected: TranscriptCorrection[];
  };
}

export interface SessionListParams {
  status?: string;       // comma-separated: "indexed,processing"
  source?: string;       // "youtube" | "legacy"
  limit?: number;
  offset?: number;
}

export interface SyncOptions {
  daysBack?: number;
  videoIds?: string[];
  force?: boolean;
  skipLlmReview?: boolean;
  dryRun?: boolean;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

const BASE = '/api/admin/transcripts';

async function authHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function apiFetch<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: unknown,
): Promise<T> {
  const headers = await authHeaders(
    payload !== undefined ? { 'Content-Type': 'application/json' } : {},
  );
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    let detail = `${method} ${path} → ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ─── API calls ─────────────────────────────────────────────────────────────

export async function listTranscriptSessions(
  params: SessionListParams = {},
): Promise<{ sessions: TranscriptSessionListItem[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.source) qs.set('source', params.source);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<{ sessions: TranscriptSessionListItem[]; total: number }>(
    'GET',
    `/sessions${query}`,
  );
}

export async function getTranscriptSession(
  id: string,
): Promise<TranscriptSessionDetailResponse> {
  return apiFetch<TranscriptSessionDetailResponse>('GET', `/sessions/${encodeURIComponent(id)}`);
}

export async function patchCorrection(
  id: string,
  action: 'accept' | 'reject',
): Promise<{ ok: true; correction: TranscriptCorrection }> {
  return apiFetch<{ ok: true; correction: TranscriptCorrection }>(
    'PATCH',
    `/corrections/${encodeURIComponent(id)}`,
    { action },
  );
}

export async function triggerSync(opts: SyncOptions = {}): Promise<{
  ok: true;
  sync: unknown;
  processed: unknown[];
  errors: unknown[];
}> {
  return apiFetch<{ ok: true; sync: unknown; processed: unknown[]; errors: unknown[] }>(
    'POST',
    '/sync',
    opts,
  );
}

/**
 * Aprobar o rechazar una sesión completa desde el editor de transcripción.
 * approve → la sesión pasa a `indexed` y queda visible en /sesiones para todos.
 * reject  → la sesión pasa a `rejected` y no se publica.
 */
export async function reviewTranscriptSession(
  id: string,
  action: 'approve' | 'reject',
  note?: string,
): Promise<{ ok: true; session_id: string; status: string; action: string }> {
  return apiFetch<{ ok: true; session_id: string; status: string; action: string }>(
    'POST',
    `/sessions/${encodeURIComponent(id)}/review`,
    { action, note },
  );
}
