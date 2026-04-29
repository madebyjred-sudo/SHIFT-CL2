/**
 * Centinela — typed client for the user-facing endpoints.
 * Mirrors apps/api/src/routes/centinela.ts (centinelaUserRouter).
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/centinela';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────

export type AlertType =
  | 'state_change'
  | 'deadline'
  | 'mention'
  | 'agenda'
  | 'similar'
  | 'digest_weekly';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type EntityType = 'expediente' | 'diputado' | 'tema';

export interface CentinelaAlert {
  id: string;
  alert_type: AlertType;
  entity_type: string;
  entity_id: string;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  dedup_key: string;
  read_at: string | null;
  created_at: string;
}

export interface WatchlistItem {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  label: string | null;
  notes: string | null;
  created_at: string;
}

export interface Channels {
  in_app?: boolean;
  email?: boolean;
  slack?: boolean;
  whatsapp?: boolean;
  telegram?: boolean;
}

export interface Prefs {
  user_id: string;
  channels: Channels;
  alert_types_on: AlertType[];
  digest_enabled: boolean;
  quiet_hours: { start?: string; end?: string; tz?: string } | null;
}

export interface Summary {
  unread: number;
  total: number;
  watchlist: number;
  severity: { info: number; warning: number; critical: number };
  prefs: Pick<Prefs, 'digest_enabled' | 'channels' | 'alert_types_on'> | null;
}

// ─── Endpoints ─────────────────────────────────────────────────────────

export async function getSummary(): Promise<Summary> {
  const r = await apiFetch<{ ok: true } & Summary>('/summary');
  return r;
}

export async function getFeed(opts?: {
  limit?: number;
  cursor?: string | null;
  type?: AlertType;
  severity?: AlertSeverity;
  unread_only?: boolean;
}): Promise<{ items: CentinelaAlert[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (opts?.limit) q.set('limit', String(opts.limit));
  if (opts?.cursor) q.set('cursor', opts.cursor);
  if (opts?.type) q.set('type', opts.type);
  if (opts?.severity) q.set('severity', opts.severity);
  if (opts?.unread_only) q.set('unread_only', '1');
  const r = await apiFetch<{ ok: true; items: CentinelaAlert[]; nextCursor: string | null }>(
    `/feed?${q.toString()}`,
  );
  return { items: r.items, nextCursor: r.nextCursor };
}

export async function markRead(alertId: string): Promise<void> {
  await apiFetch(`/alerts/${encodeURIComponent(alertId)}/read`, { method: 'POST' });
}

export async function markAllRead(): Promise<void> {
  await apiFetch('/alerts/read-all', { method: 'POST' });
}

export async function getWatchlist(): Promise<WatchlistItem[]> {
  const r = await apiFetch<{ ok: true; items: WatchlistItem[] }>('/watchlist');
  return r.items;
}

export async function addToWatchlist(input: {
  entity_type: EntityType;
  entity_id: string;
  label?: string;
  notes?: string;
}): Promise<WatchlistItem> {
  const r = await apiFetch<{ ok: true; item: WatchlistItem }>('/watchlist', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return r.item;
}

export async function removeFromWatchlist(id: string): Promise<void> {
  await apiFetch(`/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getPrefs(): Promise<Prefs> {
  const r = await apiFetch<{ ok: true; prefs: Prefs }>('/prefs');
  return r.prefs;
}

export async function updatePrefs(input: Partial<{
  channels: Channels;
  alert_types_on: AlertType[];
  digest_enabled: boolean;
  quiet_hours: { start?: string; end?: string; tz?: string } | null;
}>): Promise<Prefs> {
  const r = await apiFetch<{ ok: true; prefs: Prefs }>('/prefs', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return r.prefs;
}

// ─── Display helpers ───────────────────────────────────────────────────

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  state_change: 'Cambio de estado',
  deadline: 'Plazo próximo',
  mention: 'Mención en sesión',
  agenda: 'En agenda',
  similar: 'Similar a tu watchlist',
  digest_weekly: 'Digest semanal',
};

export function alertTypeLabel(t: AlertType): string {
  return ALERT_TYPE_LABELS[t] ?? t;
}

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: 'Informativa',
  warning: 'Atención',
  critical: 'Crítica',
};

export function severityLabel(s: AlertSeverity): string {
  return SEVERITY_LABELS[s] ?? s;
}
