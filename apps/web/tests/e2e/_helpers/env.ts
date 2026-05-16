/**
 * Test env resolver — single source of truth para URLs + Supabase creds.
 *
 * Defaults asumen local dev. Override con env vars para correr contra prod
 * o ambiente preview.
 */

export const E2E_ENV = {
  /** Base URL del web (Vite dev por default). Override: E2E_BASE_URL */
  webBaseUrl:
    process.env.E2E_BASE_URL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    'http://localhost:5173',

  /** Base URL del API. Override: API_BASE_URL */
  apiBaseUrl:
    process.env.API_BASE_URL ??
    'http://localhost:3001',

  /** Supabase URL. Override: NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl:
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    '',

  /** Service role para mintear tokens en setup. NUNCA enviar al browser. */
  supabaseServiceKey:
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',

  /** Anon/publishable key para token-grant flow. */
  supabaseAnonKey:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    '',

  /** Si true, los tests corren contra prod (afecta cleanup + workers). */
  isProd: !!process.env.E2E_AGAINST_PROD || (process.env.E2E_BASE_URL ?? '').includes('run.app'),
};

export function assertEnvReady(): void {
  if (!E2E_ENV.supabaseUrl) {
    throw new Error('E2E env missing: NEXT_PUBLIC_SUPABASE_URL (or VITE_SUPABASE_URL)');
  }
  if (!E2E_ENV.supabaseServiceKey) {
    throw new Error('E2E env missing: SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!E2E_ENV.supabaseAnonKey) {
    throw new Error('E2E env missing: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
}

/**
 * Project ref del Supabase (primer subdomain del URL).
 * Usado para construir el storage key del JWT en localStorage:
 *   sb-<projectRef>-auth-token
 */
export function supabaseProjectRef(): string {
  return E2E_ENV.supabaseUrl.replace('https://', '').replace('.supabase.co', '');
}
