/**
 * Clientes API — typed client del BFF `/api/clientes/*`.
 *
 * Cada user consultor de CL2 tiene N clientes. Cada cliente vive
 * relacionalmente acá Y en la neurona como `/memories/clientes/<slug>.md`
 * (sync server-side). Esta capa solo habla con la tabla; el contexto
 * que los agentes leen viaja por neurona y se actualiza automático.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/clientes';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export interface Cliente {
  id: string;
  user_id: string;
  slug: string;
  label: string;
  description: string | null;
  sector: string | null;
  contact_email: string | null;
  contact_whatsapp: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  context_prompt: string | null;
  context_keywords: string[] | null;
}

export interface ClientePatch {
  label?: string;
  description?: string;
  sector?: string | null;
  contact_email?: string | null;
  contact_whatsapp?: string | null;
  archived?: boolean;
  context_prompt?: string | null;
  context_keywords?: string[] | string | null;
}

export interface ClienteCreate {
  label: string;
  description?: string;
  sector?: string;
  contact_email?: string;
  contact_whatsapp?: string;
  context_prompt?: string;
  context_keywords?: string[] | string;
}

export async function listClientes(includeArchived = false): Promise<Cliente[]> {
  const qs = includeArchived ? '?archived=1' : '';
  const r = await call<{ ok: true; items: Cliente[] }>(`/${qs}`);
  return r.items;
}

export async function getCliente(id: string): Promise<Cliente> {
  const r = await call<{ ok: true; cliente: Cliente }>(`/${id}`);
  return r.cliente;
}

export async function createCliente(body: ClienteCreate): Promise<Cliente> {
  const r = await call<{ ok: true; cliente: Cliente }>('/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.cliente;
}

export async function updateCliente(id: string, patch: ClientePatch): Promise<Cliente> {
  const r = await call<{ ok: true; cliente: Cliente }>(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.cliente;
}

export async function deleteCliente(id: string): Promise<void> {
  await call(`/${id}`, { method: 'DELETE' });
}
