/**
 * Feedback API — typed client del BFF /api/feedback/* y /api/admin/feedback/*.
 *
 * Para crear reportes con screenshot usamos FormData (multipart). El BFF
 * acepta tanto multipart como JSON puro; el cliente del SPA siempre manda
 * multipart porque eso uniforma el manejo del file.
 */
import { supabase } from '@/lib/supabase';

async function bearerHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type FeedbackKind = 'bug' | 'pregunta' | 'idea' | 'otro';
export type FeedbackSeverity = 'baja' | 'media' | 'alta' | 'critica';
export type FeedbackStatus = 'abierto' | 'en_revision' | 'resuelto' | 'descartado';

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description?: string;
  severity?: FeedbackSeverity;
  /** File object para screenshot opcional. Image/* expected. */
  screenshot?: File | null;
}

export interface FeedbackMineItem {
  id: string;
  kind: FeedbackKind;
  title: string;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface FeedbackAdminItem {
  id: string;
  user_id: string;
  user_email: string | null;
  kind: FeedbackKind;
  title: string;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  context_url: string | null;
  created_at: string;
  resolved_at: string | null;
  has_screenshot: boolean;
}

export interface FeedbackAdminDetail extends FeedbackAdminItem {
  description: string;
  context_meta: Record<string, unknown> | null;
  admin_notes: string;
  screenshot_url: string | null;
  updated_at: string;
}

/**
 * Crea un reporte. El contexto (URL + viewport + user_agent + theme) lo
 * capturamos acá automático — el caller solo provee kind/title/desc/sev/img.
 */
export async function submitFeedback(input: FeedbackInput): Promise<{ id: string }> {
  const fd = new FormData();
  fd.append('kind', input.kind);
  fd.append('title', input.title.slice(0, 280));
  if (input.description) fd.append('description', input.description.slice(0, 10_000));
  if (input.severity) fd.append('severity', input.severity);
  // Contexto auto-capturado
  if (typeof window !== 'undefined') {
    fd.append('context_url', window.location.pathname + window.location.search);
    const meta = {
      user_agent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      theme: (document.documentElement.classList.contains('dark') ? 'dark' : 'light') as 'dark' | 'light',
      url_full: window.location.href,
    };
    fd.append('context_meta', JSON.stringify(meta));
  }
  if (input.screenshot) fd.append('screenshot', input.screenshot);

  const headers = await bearerHeader();
  const r = await fetch('/api/feedback', {
    method: 'POST',
    headers, // NO content-type; el browser pone multipart/form-data con boundary
    body: fd,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<{ id: string }>;
}

export async function listMyFeedback(): Promise<FeedbackMineItem[]> {
  const headers = await bearerHeader();
  const r = await fetch('/api/feedback/mine', { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.json()) as { ok: true; items: FeedbackMineItem[] };
  return body.items;
}

// ─── Admin ────────────────────────────────────────────────────────────
const ADMIN_BASE = '/api/admin/feedback';

async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await bearerHeader();
  const r = await fetch(`${ADMIN_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export async function adminListFeedback(opts?: {
  status?: FeedbackStatus | 'all';
  kind?: FeedbackKind;
  limit?: number;
}): Promise<FeedbackAdminItem[]> {
  const params = new URLSearchParams();
  if (opts?.status && opts.status !== 'all') params.set('status', opts.status);
  if (opts?.status === 'all') {
    // El backend, sin status, devuelve solo abiertos+en_revision. Para
    // ver TODO mandamos un status especial — usamos limit alto + iter
    // manual (defensivo).
    // Aproximación práctica: si user quiere "all", lo pedimos por cada
    // status conocido y mergeamos.
    const all = await Promise.all([
      adminListFeedback({ status: 'abierto', kind: opts.kind, limit: opts.limit }),
      adminListFeedback({ status: 'en_revision', kind: opts.kind, limit: opts.limit }),
      adminListFeedback({ status: 'resuelto', kind: opts.kind, limit: opts.limit }),
      adminListFeedback({ status: 'descartado', kind: opts.kind, limit: opts.limit }),
    ]);
    return all.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  if (opts?.kind) params.set('kind', opts.kind);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const r = await adminJson<{ ok: true; items: FeedbackAdminItem[] }>(qs ? `?${qs}` : '/');
  return r.items;
}

export async function adminGetFeedback(id: string): Promise<FeedbackAdminDetail> {
  const r = await adminJson<{ ok: true; report: FeedbackAdminDetail }>(`/${id}`);
  return r.report;
}

export async function adminUpdateFeedback(
  id: string,
  patch: { status?: FeedbackStatus; admin_notes?: string; severity?: FeedbackSeverity },
): Promise<FeedbackAdminDetail> {
  const r = await adminJson<{ ok: true; report: FeedbackAdminDetail }>(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.report;
}
