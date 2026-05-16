/**
 * accessApi — cliente para /api/me y endpoints de aprobación de usuarios.
 *
 * El AccessGate llama fetchMe() inmediatamente después de que Supabase
 * confirma sesión, para decidir si mostrar la app o la pantalla "esperando
 * aprobación". El admin panel usa approveUser/rejectUser desde la sección
 * de Usuarios.
 */
import { supabase } from '@/lib/supabase';

export type AccessStatus = 'pending' | 'active' | 'rejected' | 'suspended';
export type AccessRole = 'lector' | 'editor' | 'operador' | 'admin' | null;

export interface MeResponse {
  ok: true;
  user: {
    id: string;
    email: string | null;
    status: AccessStatus;
    role: AccessRole;
    full_name: string | null;
    avatar_url: string | null;
    approved_at: string | null;
  };
}

async function authHeader(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export async function fetchMe(): Promise<MeResponse['user'] | null> {
  const res = await fetch('/api/me', { headers: await authHeader() });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  const data = (await res.json()) as MeResponse;
  return data.user;
}

export async function approveUser(userId: string, role: Exclude<AccessRole, null>): Promise<void> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `approve ${res.status}`);
  }
}

export async function rejectUser(userId: string, reason?: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `reject ${res.status}`);
  }
}
