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

// ── User access gate (status + role) ────────────────────────────────
// Cualquier persona puede crear cuenta con Google, pero solo accede a la
// app si un admin la aprueba en /admin/usuarios. La data vive en la tabla
// user_access (ver migration 0025_user_access_gate.sql).

export type UserRole = 'lector' | 'editor' | 'operador' | 'admin' | 'cliente';

export interface UserAccess {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  status: 'pending' | 'active' | 'rejected' | 'suspended';
  // 2026-05-26 Ronald F1: agregado 'cliente'. Migration 0052 actualizó el
  // CHECK constraint en DB. Cliente role tiene acceso operativo (chat,
  // browse, alertas) pero NO puede invocar tools editoriales con marca CL2
  // (generate_presentation, generate_docx, generate_asset, edit_asset_slide)
  // ni acceder al panel /admin.
  role: UserRole | null;
  approved_at: string | null;
}

/**
 * Tools editoriales con marca CL2 — restringidas para role='cliente'.
 * Wave 4 / Ronald F1.
 */
export const CL2_EDITORIAL_TOOLS = new Set([
  'generate_presentation',
  'generate_docx',
  'generate_asset',
  'edit_asset_slide',
]);

/** True si el rol puede invocar tools editoriales con marca CL2. */
export function canUseEditorialTools(role: UserRole | null): boolean {
  // null/pending → conservar comportamiento previo (acceso completo); admin/operador/editor/lector OK.
  // 'cliente' es el ÚNICO rol que se restringe.
  return role !== 'cliente';
}

let _service: SupabaseClient | null = null;
function service(): SupabaseClient {
  if (_service) return _service;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase service-role env not set (auth)');
  _service = createClient(url, key, { auth: { persistSession: false } });
  return _service;
}

/**
 * Cargá el row de user_access del user actual. Si no existe (race condition:
 * el trigger no corrió aún para un user recién creado) devolvemos null.
 * El caller decide qué hacer — usualmente: 401 si no hay user, 403 si
 * status !== 'active', 200 con data en cualquier otro caso.
 */
export async function loadUserAccess(userId: string): Promise<UserAccess | null> {
  const { data, error } = await service()
    .from('user_access')
    .select('user_id, email, full_name, avatar_url, status, role, approved_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // Tabla no existe (migration aún no aplicada) — log y permitir pasar.
    // En desarrollo esto evita lockout total mientras corremos la migration.
    if (error.code === '42P01') {
      // eslint-disable-next-line no-console
      console.warn('user_access table missing; gate disabled until migration applied');
      return null;
    }
    throw new Error(`loadUserAccess failed: ${error.message}`);
  }
  return data as UserAccess | null;
}

/**
 * Helper para handlers: requiere user autenticado + status='active'. Si
 * no, responde con el error apropiado y devuelve null para que el handler
 * haga early return.
 *
 * Casos manejados:
 *   - No hay token → 401 auth_required
 *   - Token válido pero el user no está en user_access (race) → permitir pasar
 *     (el trigger crea el row async; reintentos del cliente la próxima vez
 *     ya van a tener el row)
 *   - status=pending → 403 access_pending
 *   - status=rejected → 403 access_rejected
 *   - status=suspended → 403 access_suspended
 *   - status=active → return UserAccess (con id+role)
 */
import type { Response } from 'express';
export async function requireActiveUser(
  req: Request,
  res: Response,
): Promise<UserAccess | null> {
  const u = await getUserFromRequest(req);
  if (!u) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  let access: UserAccess | null;
  try {
    access = await loadUserAccess(u.id);
  } catch (err) {
    // Si la consulta falla por algo distinto de "tabla no existe", no
    // bloqueamos al user — preferimos degradar a "permite pasar" antes
    // que romper toda la app por un hiccup transitorio de DB.
    // eslint-disable-next-line no-console
    console.error('loadUserAccess error, allowing through:', (err as Error).message);
    return {
      user_id: u.id,
      email: u.email ?? '',
      full_name: null,
      avatar_url: null,
      status: 'active',
      role: 'lector',
      approved_at: null,
    };
  }
  if (!access) {
    // Race: el trigger aún no creó el row. Permitir paso — el row se
    // creará la próxima vez. Pintamos default "pending" en el frontend.
    return {
      user_id: u.id,
      email: u.email ?? '',
      full_name: null,
      avatar_url: null,
      status: 'pending',
      role: null,
      approved_at: null,
    };
  }
  if (access.status !== 'active') {
    res.status(403).json({
      ok: false,
      error: `access_${access.status}`,
      access: { status: access.status, email: access.email },
    });
    return null;
  }
  return access;
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
