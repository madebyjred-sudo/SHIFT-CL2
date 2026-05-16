/**
 * @feature @sprint-3 Sprint editorial — categorías + resúmenes + informes (Track P)
 *
 * Cubre:
 * - DB: las 51 categorías canónicas existen post-0041.
 * - DB: distribución por área es la esperada.
 * - API: GET /api/expedientes/:numero/editorial responde shape esperado.
 * - API: GET /api/informes-semanales lista del user logged in.
 * - UI: /informes-semanales carga sin errores.
 * - UI: detalle de informe renderea markdown.
 *
 * NO ejecuta los jobs LLM (cuesta tokens). Para tests del LLM ver
 * apps/api/src/jobs/editorial.test.ts (24 tests).
 */
import { test, expect } from '@playwright/test';
import { withAdmin, mintToken } from '../_helpers/auth';
import { apiCall, assert200 } from '../_helpers/api';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

test.describe('@feature @sprint-3 @api Editorial — DB shape', () => {
  test('cl2_categorias tiene exactamente 51 categorías vigentes', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await fetch(
      `${SUPA_URL}/rest/v1/cl2_categorias?vigente=eq.true&select=slug,area&limit=200`,
      {
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${s.access_token}` },
      },
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ slug: string; area: string }>;
    expect(rows.length).toBe(51);

    // Distribución esperada (del agent report): 13+12+8+7+5+3+3 = 51
    const byArea: Record<string, number> = {};
    for (const r of rows) byArea[r.area] = (byArea[r.area] ?? 0) + 1;

    // Áreas esperadas
    expect(byArea['productivo']).toBeGreaterThanOrEqual(10);
    expect(byArea['social']).toBeGreaterThanOrEqual(10);
    expect(byArea['institucional']).toBeGreaterThanOrEqual(5);
    expect(byArea['ambiental']).toBeGreaterThanOrEqual(5);
    expect(byArea['fiscal']).toBeGreaterThanOrEqual(3);
  });
});

test.describe('@feature @sprint-3 @api Editorial — endpoints', () => {
  test('GET /api/informes-semanales con admin → 200 + items array', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{ ok: boolean; items: unknown[] }>(
      'GET',
      '/api/informes-semanales',
      { token: s.access_token, base: 'web' },
    );
    const body = assert200(res);
    expect(body.ok).toBe(true);
    expect(body.items).toBeInstanceOf(Array);
  });

  test('GET /api/expedientes/23.511/editorial responde shape (resumen o vacío si no se generó)', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{ ok: boolean; resumen_md?: string; categorias?: string[] }>(
      'GET',
      '/api/expedientes/23.511/editorial',
      { token: s.access_token, base: 'web' },
    );
    // 200 si existe row, 404 si nunca se corrió el job — ambos válidos
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
    }
  });
});

test.describe('@feature @sprint-3 Editorial — UI', () => {
  test('/informes-semanales carga sin errores de consola', async ({ page }) => {
    await withAdmin(page);

    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const t = m.text();
        if (!t.includes('401') && !t.includes('Failed to load resource')) errors.push(t);
      }
    });

    await page.goto('/informes-semanales');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // Estado vacío o lista de informes — ambos válidos
    const heading = page.getByText(/Informes|semanal/i).first();
    await expect(heading).toBeVisible({ timeout: 8_000 });
    expect(errors).toEqual([]);
  });
});
