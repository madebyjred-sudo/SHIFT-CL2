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

async function shoot(page: Page, url: string, file: string, waitMs = 3500) {
  await injectAuth(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${DIR}/${file}`, fullPage: true });
  console.log('✓', file);
}

test.setTimeout(60_000);

test('16a — Matriz cliente auto-generada', async ({ page }) => {
  await shoot(page, '/matriz-cliente', '16a-matriz-cliente-REAL.png');
});

test('16c — Parser orden del día por capítulos', async ({ page }) => {
  await shoot(page, '/orden-dia', '16c-orden-dia-REAL.png');
});

test('12b — POR TANTO chunker reducción real', async ({ page }) => {
  await shoot(page, '/por-tanto-demo', '12b-por-tanto-chunker-REAL.png');
});
