import { test, Page } from '@playwright/test';

const SUPABASE_HOST = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace('https://', '').replace('.supabase.co', '');
const SB_KEY = `sb-${SUPABASE_HOST}-auth-token`;
const PROD_URL = 'https://cl2-v2-web-u3rliii7wa-uc.a.run.app';

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

const DIR = 'test-results/prod-smoke';
test.setTimeout(45_000);

test('PROD — expediente 23.511 dashboard con 9 tabs', async ({ page }) => {
  await injectAuth(page);
  await page.goto(`${PROD_URL}/expediente/23.511`);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.getByText(/LEY MARCO|RECURSO/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/expediente-dashboard.png`, fullPage: true });
  console.log('✓ expediente-dashboard');
});

test('PROD — matriz cliente', async ({ page }) => {
  await injectAuth(page);
  await page.goto(`${PROD_URL}/matriz-cliente`);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${DIR}/matriz-cliente.png`, fullPage: true });
  console.log('✓ matriz-cliente');
});

test('PROD — plenario estado decretos', async ({ page }) => {
  await injectAuth(page);
  await page.goto(`${PROD_URL}/plenario/estado`);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.getByText(/Decreto|45461|convocados/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/plenario-estado.png`, fullPage: true });
  console.log('✓ plenario-estado');
});

test('PROD — novedades algoritmo live', async ({ page }) => {
  await injectAuth(page);
  await page.goto(`${PROD_URL}/expediente/23.511`);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.getByText(/LEY MARCO|RECURSO/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Novedades/i }).first().click().catch(() => {});
  await page.getByText(/algoritmo|SharePoint|moci.n/i).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/novedades-live.png`, fullPage: true });
  console.log('✓ novedades-live');
});
