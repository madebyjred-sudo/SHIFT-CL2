/**
 * Onboarding wizard — typed client.
 * Mirrors apps/api/src/routes/onboarding.ts.
 */
import { supabase } from '@/lib/supabase';

const BASE = '/api/onboarding';

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

export interface UserProfile {
  user_id: string;
  cargo: string | null;
  enfoque: string | null;
  temas: string[];
  partido: string | null;
  onboarded_at: string | null;
  onboarding_step: string;
}

export async function getProfile(): Promise<UserProfile> {
  const r = await call<{ ok: true; profile: UserProfile }>('/profile');
  return r.profile;
}

export async function updateProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  const r = await call<{ ok: true; profile: UserProfile }>('/profile', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.profile;
}

export async function completeOnboarding(): Promise<void> {
  await call('/complete', { method: 'POST' });
}

export interface MagicHelpResult {
  suggestion?: string;
  suggestions?: string[];
}

export async function magicHelp(input: {
  agent: 'lexa' | 'atlas' | 'centinela';
  field: 'cargo' | 'enfoque' | 'temas';
  context: Record<string, unknown>;
}): Promise<MagicHelpResult> {
  const r = await call<{ ok: true } & MagicHelpResult>('/magic-help', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return r;
}

export interface WatchlistSuggestion {
  label: string;
  entity_type: 'expediente' | 'diputado' | 'tema';
  entity_id: string;
  rationale: string;
}

export async function suggestWatchlist(profile: Partial<UserProfile>): Promise<WatchlistSuggestion[]> {
  const r = await call<{ ok: true; suggestions: WatchlistSuggestion[] }>('/suggest-watchlist', {
    method: 'POST',
    body: JSON.stringify({ profile }),
  });
  return r.suggestions;
}
