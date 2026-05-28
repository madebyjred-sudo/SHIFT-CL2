/**
 * @feature @lexa-wave4-7-vote-detail
 *
 * Wave 4 #7 validation. Antes del fix, Lexa decía "no encontré la votación
 * específica" sobre 24.998 porque el resultado ("52 votos a favor") nunca
 * quedó en chunks transcript — Gemini lo perdió. Wave 4 #7 ingestó chunks
 * sintéticos desde metadata.resumen.acuerdos, donde el LLM sí capturó la
 * cifra exacta.
 *
 * Si este test pasa, Lexa cita correctamente votos específicos.
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

const CASES = [
  {
    id: 'V1',
    q: 'Con cuántos votos a favor se aprobó el expediente 24.998 en la plenaria del 21 de mayo de 2026',
    expects: [/52\s+votos/i, /24\.?998|24998/],
  },
  {
    id: 'V2',
    q: 'Cuántos votos a favor recibió el expediente 24.642 sobre el PANI',
    expects: [/53\s+votos/i, /24\.?642|24642/],
  },
  {
    id: 'V3',
    q: 'Cuál fue el resultado de la votación del dictamen del expediente 24.099',
    expects: [/29\s+(votos\s+)?en\s+contra/i, /24\.?099|24099/, /rechaz/i],
  },
];

for (const c of CASES) {
  test(`${c.id} ${c.q.slice(0, 60)}`, async ({ page }) => {
    // Doctrina cliente: resultado correcto > rapidez. Damos a Lexa el
    // tiempo que necesite (hasta 5min por query). Cuando validemos que las
    // respuestas son correctas, optimizaremos hacia abajo.
    test.setTimeout(360_000);

    await withAdmin(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 15_000 });

    const input = page.locator('[data-testid="chat-input"]');
    await input.click();
    await input.fill(c.q);
    await page.keyboard.press('Enter');

    const assistant = page.locator('[data-testid="message-assistant"]').last();
    await assistant.waitFor({ state: 'attached', timeout: 240_000 });

    // Stable for 3s (200 × 500ms = 100s max esperando estabilización)
    let lastLen = 0;
    for (let i = 0; i < 200; i++) {
      const txt = await assistant.textContent();
      const n = txt?.length ?? 0;
      if (n > 0 && n === lastLen) break;
      lastLen = n;
      await page.waitForTimeout(500);
    }

    const text = (await assistant.textContent()) ?? '';
    console.log(`\n${c.id} Q: ${c.q}`);
    console.log(`${c.id} A: ${text.slice(0, 400)}\n`);

    for (const r of c.expects) {
      expect(text).toMatch(r);
    }
  });
}
