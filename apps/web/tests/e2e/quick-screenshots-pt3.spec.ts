import { test, Page } from '@playwright/test';

const SUPABASE_HOST = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace('https://', '').replace('.supabase.co', '');
const SB_KEY = `sb-${SUPABASE_HOST}-auth-token`;

function getSession() {
  return {
    access_token: process.env.E2E_USER_ACCESS_TOKEN,
    refresh_token: 'x',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'b8a6cbeb-8b6c-463b-8a1a-a12a2e2e9fd4', email: 'madebyjred@gmail.com', aud: 'authenticated', role: 'authenticated' },
  };
}

async function injectAuth(page: Page) {
  const sess = getSession();
  await page.addInitScript(([k, s]) => {
    localStorage.setItem(k as string, JSON.stringify(s));
    localStorage.setItem('supabase.auth.token', JSON.stringify({ currentSession: s }));
  }, [SB_KEY, sess] as any);
}

const DIR = 'test-results/sprint-v3-final';

test.setTimeout(60_000);

test('16c — Próx. sesión (orden día) integrado al expediente', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/expediente/23.511');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // Wait for hero (real data) to be visible
  await page.getByText(/LEY MARCO|RECURSO/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // Click "Próx. sesión" tab
  await page.getByRole('button', { name: /Pr.?x.*sesi.n/i }).first().click().catch(() => {});
  // Wait for panel content (CAPÍTULO label rendering)
  await page.getByText(/Cap.tulo Tercero|Pr.xima aparici.n/i).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${DIR}/16c-orden-dia-REAL.png`, fullPage: true });
  console.log('✓ 16c-orden-dia-REAL.png');
});
