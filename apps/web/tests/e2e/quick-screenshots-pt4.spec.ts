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

test('16i — Estado del Plenario (decretos)', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/plenario/estado');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // Wait for real content (numero_decreto or convocados count)
  await page.getByText(/Decreto|convocados|45461/i).first().waitFor({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/16i-decretos-REAL.png`, fullPage: true });
  console.log('✓ 16i-decretos-REAL.png');
});

test('16j — Algoritmo Carlos (novedades vivas)', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/expediente/23.511');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.getByText(/LEY MARCO|RECURSO/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Novedades/i }).first().click().catch(() => {});
  await page.getByText(/algoritmo|SharePoint|moci.n/i).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/16j-algoritmo-REAL.png`, fullPage: true });
  console.log('✓ 16j-algoritmo-REAL.png');
});

test('16k — Documentos con texto sustitutivo destacado', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/expediente/23.511');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.getByText(/LEY MARCO|RECURSO/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Documentos/i }).first().click().catch(() => {});
  await page.getByText(/sustitutivo/i).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/16k-documentos-REAL.png`, fullPage: true });
  console.log('✓ 16k-documentos-REAL.png');
});
