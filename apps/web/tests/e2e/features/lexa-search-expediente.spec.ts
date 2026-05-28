/**
 * @feature @lexa-search-expediente Verifica búsqueda de expedientes (Issue #2)
 *
 * Flujo: login → navegar a /sil → buscar "24.009" → verificar que aparece
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

test('Buscar expediente 24.009 en catálogo SIL', async ({ page }) => {
  test.setTimeout(60_000);

  await withAdmin(page);
  await page.goto('/sil');

  // Esperar a que cargue la página de SIL
  await page.waitForSelector('input[placeholder*="Buscar"], input[placeholder*="buscar"]', { timeout: 15_000 });

  // Buscar 24.009
  const searchInput = page.locator('input[placeholder*="Buscar"], input[placeholder*="buscar"]').first();
  await searchInput.fill('24.009');
  await searchInput.press('Enter');

  // Esperar resultados
  await page.waitForTimeout(3_000);

  // Verificar que aparece el expediente (por número o título)
  const pageText = await page.locator('body').textContent();
  const hasMatch = pageText?.includes('24.009') || pageText?.includes('24.009');

  expect(hasMatch, 'El expediente 24.009 debe aparecer en los resultados de búsqueda').toBe(true);
});
