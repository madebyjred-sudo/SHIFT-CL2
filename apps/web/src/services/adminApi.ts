/**
 * Client wrapper for /api/admin/*.
 *
 * Every response carries a `mock` flag where applicable so the UI can
 * surface "Datos de demostración" badges. Errors throw so call sites
 * can show toasts.
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const BASE = '/api/admin';

interface AdminEnvelope<T> {
  ok: true;
  mock: boolean;
  generated_at: string;
  data: T;
}

async function authHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function get<T>(path: string): Promise<AdminEnvelope<T>> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as AdminEnvelope<T>;
}

async function send<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `${path} → ${res.status}`;
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

// ─── Types ──────────────────────────────────────────────────────────

export interface AdminSummary {
  chunks: number;
  sessions: number;
  expedientes: number;
  pending_transcripciones: number;
  watchlist_total: number;
}

export interface ActivityItem {
  id: number;
  ts: string;
  actor_email: string | null;
  actor_kind: 'human' | 'system';
  verb: string;
  resource: string;
  resource_kind: string | null;
  result: 'ok' | 'error' | 'retry';
}

export interface AlertItem {
  id: number;
  severity: 'warn' | 'danger';
  title: string;
  detail: string;
  when: string;
}

export interface TranscriptionItem {
  id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;
  duration_seconds: number;
  confidence: number;
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt: string;
  excerpt_ts: string;
}

export interface TranscriptionQueue {
  counts: { pending: number; in_progress: number; approved: number; rejected: number };
  items: TranscriptionItem[];
}

export interface TranscriptionDetail {
  item: TranscriptionItem;
  segments: Array<{
    ts: string;
    speaker: string;
    text: string;
    confidence: number;
    flagged: boolean;
    highlighted?: boolean;
  }>;
  diarization: Array<{ speaker: string; total_seconds: number; color: string }>;
  total_segments: number;
  total_words: number;
}

export interface AgentStatus {
  agent_id: 'lexa' | 'atlas' | 'centinela';
  enabled: boolean;
  model: string | null;
  queries_24h: number;
  queries_recent_60m: number;
  p50_ms: number | null;
  p95_ms: number | null;
  error_rate_pct: number;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  actor_kind: 'human' | 'system';
  actor_email: string | null;
  verb: string;
  resource: string;
  resource_kind: string | null;
  ip: string | null;
  result: 'ok' | 'retry' | 'error';
}

export interface AdminUser {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  role: 'admin' | 'operador' | 'editor' | 'lector' | null;
  status: string;
}

export interface AdminWorker {
  name: string;
  schedule: string;
  last_run_iso: string;
  last_duration_ms: number;
  ok: boolean;
  total_runs: number;
  success_rate_pct: number;
  error?: string;
}

export interface AdminBuildInfo {
  version: string;
  build: string;
  deployed_at: string | null;
  node: string;
  region: string;
  host: string;
  locale: string;
}

export type FeatureFlags = Record<string, unknown>;

// ─── Calls ──────────────────────────────────────────────────────────

export const fetchAdminSummary       = () => get<AdminSummary>('/summary');
export const fetchAdminActivity      = () => get<{ items: ActivityItem[] }>('/activity');
export const fetchAdminAlerts        = () => get<{ items: AlertItem[] }>('/alerts');

export const fetchTranscripciones    = () => get<TranscriptionQueue>('/transcripciones');
export const fetchTranscripcionDetail = (id: string) => get<TranscriptionDetail>(`/transcripciones/${encodeURIComponent(id)}`);
export const reviewTranscripcion     = (id: string, action: 'approve' | 'reject', note?: string) =>
  send<{ ok: true }>('POST', `/transcripciones/${encodeURIComponent(id)}/review`, { action, note });

export const fetchAgentsStatus       = () => get<{ items: AgentStatus[] }>('/agents/status');
export const patchAgent              = (id: string, body: { enabled?: boolean; model?: string | null }) =>
  send<{ ok: true; agent: { agent_id: string; enabled: boolean; model: string | null } }>('PATCH', `/agents/${encodeURIComponent(id)}`, body);

export const fetchFlags              = () => get<{ flags: FeatureFlags }>('/flags');
export const patchFlag               = (key: string, value: unknown) =>
  send<{ ok: true; key: string; value: unknown }>('PATCH', `/flags/${encodeURIComponent(key)}`, { value });

export const fetchWatchlist          = () => get<{ ids: number[] }>('/watchlist');
export const toggleWatchlist         = (id: number, action: 'add' | 'remove') =>
  send<{ ok: true }>('POST', `/watchlist/${id}`, { action });

export const fetchAudit              = (params?: { from?: string; to?: string; verb?: string; actor_kind?: string }) => {
  const qs = params
    ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as Array<[string, string]>).toString()
    : '';
  return get<{ items: AuditEntry[] }>(`/audit${qs}`);
};
export const auditCsvUrl             = () => `${BASE}/audit.csv`;

export const fetchAdminUsers         = () => get<{ items: AdminUser[] }>('/users');
export const inviteUser              = (email: string, role: string) =>
  send<{ ok: true; id: string | null; email: string }>('POST', '/users/invite', { email, role });
export const patchUserRole           = (id: string, role: string) =>
  send<{ ok: true }>('PATCH', `/users/${encodeURIComponent(id)}`, { role });

export const forceConsolidate        = () =>
  send<{ ok: true }>('POST', '/punto-medio/consolidate', {});
export const requestReindex          = () =>
  send<{ ok: true; queued: boolean; note: string }>('POST', '/reindex', {});

export const fetchAdminWorkers       = () => get<{ items: AdminWorker[] }>('/workers');
export const fetchAdminBuild         = () => get<AdminBuildInfo>('/build');

// ─── Hook helpers ────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  isMock: boolean;
  /** Re-run the underlying fetch. */
  refetch: () => Promise<void>;
}

export function useAdminFetch<T>(
  fn: () => Promise<AdminEnvelope<T>>,
  deps: unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const env = await fn();
      setData(env.data);
      setIsMock(env.mock);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
      setIsMock(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const env = await fn();
        if (!alive) return;
        setData(env.data);
        setIsMock(env.mock);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setData(null);
        setIsMock(false);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, isMock, refetch: run };
}
