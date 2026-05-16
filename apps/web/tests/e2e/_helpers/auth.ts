/**
 * Auth helper compartido para todos los specs Playwright.
 *
 * Reemplaza el patrón duplicado que cada spec implementaba (mintear token,
 * inyectar localStorage). Cachea tokens por 50 minutos para evitar pagar
 * el password-grant en cada test.
 *
 * Uso:
 *   import { withAdmin } from '../_helpers/auth';
 *   test('foo', async ({ page }) => {
 *     await withAdmin(page);
 *     await page.goto('/expediente/23.511');
 *     // ...
 *   });
 */
import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { E2E_ENV, assertEnvReady, supabaseProjectRef } from './env';

export interface E2ESession {
  access_token: string;
  user_id: string;
  email: string;
  role: 'admin' | 'editor' | 'operador' | 'lector' | null;
  status: 'pending' | 'active' | 'rejected' | 'suspended' | null;
}

interface CacheEntry {
  session: E2ESession;
  expires_at: number;
}

// In-memory cache. Persiste durante toda la corrida de la suite.
const _cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 50 * 60 * 1000; // 50 min (Supabase JWT default 60 min)

/**
 * Mintea un JWT real para un test user. Cacheado en proceso.
 *
 * NO usar en production code — esto rota la password del user que
 * se le pasa, lo que está OK para test users pero MAL para users reales.
 */
export async function mintToken(email: string): Promise<E2ESession> {
  assertEnvReady();

  const cached = _cache.get(email);
  if (cached && cached.expires_at > Date.now()) {
    return cached.session;
  }

  const supa = createClient(E2E_ENV.supabaseUrl, E2E_ENV.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // 1. Encontrar el user por email
  const { data, error: listErr } = await supa.auth.admin.listUsers();
  if (listErr) throw new Error(`auth.admin.listUsers failed: ${listErr.message}`);
  const user = data.users.find((u) => u.email === email);
  if (!user) throw new Error(`Test user no existe: ${email}. Correr seed-e2e-users.ts primero.`);

  // 2. Rotar password (la del user real queda sobrescrita, OK para test users)
  const tempPw = 'cl2-e2e-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  const { error: pwErr } = await supa.auth.admin.updateUserById(user.id, { password: tempPw });
  if (pwErr) throw new Error(`updateUser failed: ${pwErr.message}`);

  // 3. Token-grant flow
  const res = await fetch(`${E2E_ENV.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: E2E_ENV.supabaseAnonKey,
      Authorization: `Bearer ${E2E_ENV.supabaseAnonKey}`,
    },
    body: JSON.stringify({ email, password: tempPw }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`token-grant failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  // 4. Lookup role/status en user_access (puede ser null para users pending)
  const { data: ua } = await supa
    .from('user_access')
    .select('role, status')
    .eq('user_id', user.id)
    .maybeSingle();

  const session: E2ESession = {
    access_token: body.access_token,
    user_id: user.id,
    email,
    role: (ua?.role as E2ESession['role']) ?? null,
    status: (ua?.status as E2ESession['status']) ?? null,
  };

  _cache.set(email, { session, expires_at: Date.now() + CACHE_TTL_MS });
  return session;
}

/**
 * Inyecta la sesión en localStorage antes de la primera navegación del page.
 * Debe llamarse ANTES de page.goto(...).
 */
export async function injectAuth(page: Page, session: E2ESession): Promise<void> {
  const projectRef = supabaseProjectRef();
  const storageKey = `sb-${projectRef}-auth-token`;

  const storedSession = {
    access_token: session.access_token,
    refresh_token: 'x',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: session.user_id,
      email: session.email,
      aud: 'authenticated',
      role: 'authenticated',
    },
  };

  await page.addInitScript(
    ([k, s]) => {
      try {
        localStorage.setItem(k as string, JSON.stringify(s));
        // Legacy key — algunos componentes lo siguen leyendo
        localStorage.setItem('supabase.auth.token', JSON.stringify({ currentSession: s }));
      } catch {
        /* noop */
      }
    },
    [storageKey, storedSession] as [string, unknown],
  );
}

// ─── Personas pre-configuradas ────────────────────────────────────────────

/**
 * Admin canónico — madebyjred@gmail.com con role=admin.
 * Si el user no existe, falla con mensaje claro.
 */
export async function withAdmin(page: Page): Promise<E2ESession> {
  const s = await mintToken('madebyjred@gmail.com');
  if (s.role !== 'admin') {
    throw new Error(`Expected madebyjred@gmail.com to be role=admin, got ${s.role}`);
  }
  await injectAuth(page, s);
  return s;
}

/**
 * Lector — entra a la app pero NO al admin panel.
 * Requiere seed-e2e-users.ts haber creado e2e-lector@cl2.test.
 */
export async function withLector(page: Page): Promise<E2ESession> {
  const s = await mintToken('e2e-lector@cl2.test');
  await injectAuth(page, s);
  return s;
}

/**
 * Operador — entra al admin panel pero NO a config sensible.
 */
export async function withOperador(page: Page): Promise<E2ESession> {
  const s = await mintToken('e2e-operador@cl2.test');
  await injectAuth(page, s);
  return s;
}

/**
 * Pending — user que no fue aprobado. La app debería mostrar
 * PendingApprovalScreen.
 */
export async function withPending(page: Page): Promise<E2ESession> {
  const s = await mintToken('e2e-pending@cl2.test');
  await injectAuth(page, s);
  return s;
}

/**
 * Sin sesión — útil para testear que las páginas protegidas redirigen
 * al login.
 */
export async function withoutAuth(page: Page): Promise<void> {
  // No-op: simplemente no inyectes nada. La SPA debe mostrar el auth view.
  return;
}

/**
 * Limpia el cache (útil entre suites si querés forzar re-mintear).
 * Normalmente no es necesario llamarlo.
 */
export function clearTokenCache(): void {
  _cache.clear();
}
