/**
 * JWT verification — extracts userId from a Supabase access token.
 *
 * Uses the anon client to validate the token (auth.getUser delegates to
 * Supabase's GoTrue, which checks signature + expiry). We don't trust the
 * token's `sub` claim directly; getUser is the only safe path.
 *
 * Returns null when the header is missing or invalid. Caller decides whether
 * anonymous traffic is allowed for that route — chat persistence requires
 * a user, but the token check itself is non-fatal.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';

let _anon: SupabaseClient | null = null;
function anon(): SupabaseClient {
  if (_anon) return _anon;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Env naming drift: older code used `*_ANON_KEY`, newer Supabase docs/dashboard
  // call it `*_PUBLISHABLE_KEY`. Accept both so a fresh checkout works without
  // editing .env.local.
  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) throw new Error('Supabase anon env not set (auth)');
  _anon = createClient(url, anonKey, { auth: { persistSession: false } });
  return _anon;
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const u = await getUserFromRequest(req);
  return u?.id ?? null;
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/** Like getUserIdFromRequest but returns id + email. Useful for audit
 *  log writes where we want a human-readable actor in the row.
 *  Null when the token is missing, expired, or rejected. */
export async function getUserFromRequest(req: Request): Promise<AuthedUser | null> {
  const header = req.headers.authorization ?? req.headers.Authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.toLowerCase().startsWith('bearer ')) return null;
  const token = raw.slice(7).trim();
  if (!token) return null;

  try {
    const { data, error } = await anon().auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}
