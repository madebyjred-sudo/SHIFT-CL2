/**
 * @smoke @critical
 *
 * Core páginas cargan + bundles JS no rompen.
 * Cubre las 5 páginas que el cliente abre en la demo.
 */
import { test, expect, type Page } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

async function expectNoConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignorar 401 esperados — el AccessGate los maneja
      if (text.includes('401') || text.includes('Failed to load resource')) return;
      errors.push(text);
    }
  });
  return errors;
}

test.describe('@smoke @critical Core páginas cargan', () => {
  test('Landing público / sin auth', async ({ page }) => {
    const errors = await expectNoConsoleErrors(page);
    await page.goto('/landing');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    await expect(page.locator('body')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Expediente dashboard 23.511 con admin', async ({ page }) => {
    const errors = await expectNoConsoleErrors(page);
    await withAdmin(page);
    await page.goto('/expediente/23.511');
    await page.getByText(/LEY MARCO|RECURSO HÍDRICO/i).first().waitFor({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test('Matriz cliente con admin', async ({ page }) => {
    await withAdmin(page);
    await page.goto('/matriz-cliente');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    await expect(page.getByText(/Matriz por cliente/i)).toBeVisible({ timeout: 8_000 });
  });

  test('Plenario estado con admin', async ({ page }) => {
    await withAdmin(page);
    await page.goto('/plenario/estado');
    await page.getByText(/Estado del Plenario|convocados/i).first().waitFor({ timeout: 15_000 });
    await expect(page.getByText(/45461|decreto/i).first()).toBeVisible();
  });

  test('Centinela con admin', async ({ page }) => {
    await withAdmin(page);
    await page.goto('/centinela');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    // Cualquier de los dos estados: "Sin novedades" o lista de alertas
    const hasContent = await page.getByText(/watchlist|novedades|alertas/i).count();
    expect(hasContent).toBeGreaterThan(0);
  });
});
