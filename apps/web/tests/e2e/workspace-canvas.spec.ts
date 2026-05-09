/**
 * Workspace canvas — pruebas no-LLM.
 *
 * Sin créditos OpenRouter no podemos disparar /turn, /architect, /transform.
 * Verificamos que las URLs montan sin crash y que la UI degrada
 * limpiamente cuando el JWT mock no pasa validación.
 */
import { test, expect } from '@playwright/test';

test.describe('workspace surfaces — montaje sin crash', () => {
  test('/hojas no rompe sin sesión válida', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/hojas');
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length).toBeGreaterThan(20);

    const fatal = consoleErrors.filter((e) =>
      !e.includes('NetworkError') && !e.includes('401') && !e.includes('chunk')
    );
    expect(fatal).toEqual([]);
  });

  test('/hojas/:id con UUID inexistente cae a estado vacío', async ({ page }) => {
    const fakeId = '00000000-0000-0000-0000-000000000999';
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(`/hojas/${fakeId}`);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length).toBeGreaterThan(20);

    const fatal = consoleErrors.filter((e) =>
      !e.includes('NetworkError') && !e.includes('401') && !e.includes('chunk')
    );
    expect(fatal).toEqual([]);
  });
});

test.describe('workspace API contract — endpoints existen', () => {
  test('/api/workspace responde 401 con JWT inválido (no 404)', async ({ request }) => {
    const resp = await request.get('http://localhost:3001/api/workspace', {
      headers: { Authorization: 'Bearer mock.eyJhbGciOiJIUzI1NiJ9.test' },
      failOnStatusCode: false,
    });
    // 401 = endpoint existe y exige auth válida. 404 sería ruta inexistente.
    expect([401, 403]).toContain(resp.status());
  });

  test('/api/workspace sin Authorization devuelve 401', async ({ request }) => {
    const resp = await request.get('http://localhost:3001/api/workspace', {
      failOnStatusCode: false,
    });
    expect([401, 403]).toContain(resp.status());
  });
});
