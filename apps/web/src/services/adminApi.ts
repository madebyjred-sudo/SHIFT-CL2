/**
 * Client wrapper for /api/admin/*.
 *
 * Every response carries a `mock` flag so the UI can surface
 * "Datos de demostración" badges where the backend isn't authoritative
 * yet. Don't strip it.
 */
import { useEffect, useState } from 'react';

const BASE = '/api/admin';

interface AdminEnvelope<T> {
  ok: true;
  mock: boolean;
  generated_at: string;
  data: T;
}

async function get<T>(path: string): Promise<AdminEnvelope<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const body = (await res.json()) as AdminEnvelope<T>;
  return body;
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

// ─── Types (match the server shapes) ────────────────────────────────

export interface AdminSummary {
  chunks: number;
  sessions: number;
  expedientes: number;
  consultas_24h: number | null;
  cita_rate_pct: number | null;
  latency_p95_ms: number | null;
  cost_24h_usd: number | null;
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

export interface AuditEntry {
  ts: string;
  actor: string;
  actor_kind: 'human' | 'system';
  verb: string;
  resource: string;
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

// ─── Calls ───────────────────────────────────────────────────────────

export const fetchAdminSummary       = () => get<AdminSummary>('/summary');
export const fetchTranscripciones    = () => get<TranscriptionQueue>('/transcripciones');
export const fetchTranscripcionDetail = (id: string) => get<TranscriptionDetail>(`/transcripciones/${encodeURIComponent(id)}`);
export const reviewTranscripcion     = (id: string, action: 'approve' | 'reject') =>
  post<{ ok: true; mock: boolean }>(`/transcripciones/${encodeURIComponent(id)}/review`, { action });
export const fetchAudit              = () => get<{ items: AuditEntry[] }>('/audit');
export const fetchAdminUsers         = () => get<{ items: AdminUser[] }>('/users');
export const fetchAdminWorkers       = () => get<{ items: AdminWorker[] }>('/workers');
export const fetchAdminBuild         = () => get<AdminBuildInfo>('/build');

// ─── Hook helpers ────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  isMock: boolean;
}

export function useAdminFetch<T>(
  fn: () => Promise<AdminEnvelope<T>>,
  deps: unknown[] = [],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
    isMock: false,
  });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((env) => {
        if (!alive) return;
        setState({ data: env.data, loading: false, error: null, isMock: env.mock });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          isMock: false,
        });
      });
    return () => {
      alive = false;
    };
    // fn is intentionally not in the dependency array — the call sites pass
    // a stable bound reference like `fetchAdminSummary` so we don't refetch
    // on every render. If a section needs a parameterized fetch, it should
    // memoize the closure or include the param in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
