import { test, Page } from '@playwright/test';
import fs from 'node:fs';

const SUPABASE_HOST = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace('https://', '').replace('.supabase.co', '');
const SB_KEY = `sb-${SUPABASE_HOST}-auth-token`;

function getSession() {
  return {
    access_token: process.env.E2E_USER_ACCESS_TOKEN,
    refresh_token: 'x', expires_at: Math.floor(Date.now()/1000)+3600,
    expires_in: 3600, token_type: 'bearer',
    user: { id: 'b8a6cbeb-8b6c-463b-8a1a-a12a2e2e9fd4', email: 'madebyjred@gmail.com', aud:'authenticated', role:'authenticated' }
  };
}

async function injectAuth(page: Page) {
  const sess = getSession();
  await page.addInitScript(([k, s]) => {
    localStorage.setItem(k as string, JSON.stringify(s));
    localStorage.setItem('supabase.auth.token', JSON.stringify({currentSession: s}));
  }, [SB_KEY, sess] as any);
}

const DIR = 'test-results/sprint-v3-final';

async function shoot(page: Page, url: string, tab: string|null, file: string, waitMs=3000) {
  await injectAuth(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  await page.waitForTimeout(2500);
  if (tab) {
    await page.getByRole('button', { name: new RegExp(tab, 'i') }).first().click().catch(()=>{});
    await page.waitForTimeout(waitMs);
  }
  await page.screenshot({ path: `${DIR}/${file}`, fullPage: true });
  console.log('✓', file);
}

test('07 + 16g + 16h — Fechas estimadas', async ({ page }) => {
  await shoot(page, '/expediente/23.511', 'Fechas estimadas', '07-fecha-dictamen-REAL.png');
});

test('12a — Sala Constitucional', async ({ page }) => {
  await shoot(page, '/expediente/23.511', 'Sala IV', '12a-sala-constitucional-REAL.png');
});

test('08 — Actas con quién dijo qué', async ({ page }) => {
  await shoot(page, '/expediente/23.511', 'Actas', '08-actas-comisiones-REAL.png');
});

test('16e + 16j — Novedades + audiencias', async ({ page }) => {
  await shoot(page, '/expediente/23.511', 'Novedades', '16ej-novedades-REAL.png');
});

test('16f — Watchlist con comisión Control Fiscalización', async ({ page }) => {
  await shoot(page, '/centinela', null, '16f-watchlist-control.png');
});
