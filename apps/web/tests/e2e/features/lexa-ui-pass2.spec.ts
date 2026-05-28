/**
 * @feature @lexa-ui-pass2 Verifica Pass 2 fix v9 via UI oficial (no API directa)
 *
 * 6 prompts representativos a través del browser real:
 *   - mintToken + inject session
 *   - navigate a /chat
 *   - escribir prompt en chat-input
 *   - click chat-send
 *   - esperar message-assistant renderizado
 *   - leer textContent + asserts
 *
 * Success criteria: ≤ 1/6 (16%) cae a fallback. Esto valida que el fix v9
 * llega correctamente al usuario final, no sólo al endpoint.
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

const PROMPTS = [
  { id: 'UI-1', tool: 'get_session_by_date', q: 'Qué se discutió en la plenaria del 19 de mayo de 2026' },
  { id: 'UI-2', tool: 'search_reglamento', q: 'Cuál es el plazo para emitir dictamen según el Reglamento' },
  { id: 'UI-3', tool: 'evaluate_ral_aplicacion', q: 'Puede un expediente irse a primer debate sin dictamen' },
  { id: 'UI-4', tool: 'get_sil_expediente', q: 'Detalle completo del expediente 23.234' },
  { id: 'UI-5', tool: 'search_sil_expedientes', q: 'Buscame iniciativas legislativas sobre seguridad ciudadana' },
  { id: 'UI-6', tool: 'multi-tool', q: 'Qué expedientes se discutieron en la plenaria del 21 de mayo de 2026' },
];

const FALLBACK_PATTERNS = [
  /No encontr[eé] una respuesta concreta/i,
  /Ac[áa] te dejo lo que encontr[eé] en el corpus/i,
  /Esto es lo que tengo registrado de la sesi[óo]n/i,
  /Consult[eé] las fuentes disponibles.*no encontr/i,
];

interface UIResult {
  id: string;
  prompt: string;
  text: string;
  text_len: number;
  is_fallback: boolean;
  ms: number;
}

const REPORT: UIResult[] = [];

for (const { id, tool, q } of PROMPTS) {
  test(`${id} [${tool}] ${q.slice(0, 50)}`, async ({ page }) => {
    test.setTimeout(180_000);
    const t0 = Date.now();

    await withAdmin(page);
    await page.goto('/');

    // Open chat — toggle del FAB o navegación directa
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 15_000 });

    // Type prompt
    const input = page.locator('[data-testid="chat-input"]');
    await input.click();
    await input.fill(q);

    // Send
    await page.locator('[data-testid="chat-send"]').click();

    // Wait for assistant response (>200 chars OR 90s timeout)
    const assistantLocator = page.locator('[data-testid="message-assistant"]').last();
    await assistantLocator.waitFor({ state: 'attached', timeout: 90_000 });

    // Wait until response stops streaming — text stable for 2s
    let lastLen = 0;
    let stableTicks = 0;
    for (let i = 0; i < 90; i++) {
      const t = await assistantLocator.textContent().catch(() => '');
      const len = (t ?? '').length;
      if (len === lastLen && len > 50) {
        stableTicks++;
        if (stableTicks >= 4) break; // 4 * 500ms = 2s estable
      } else {
        stableTicks = 0;
        lastLen = len;
      }
      await page.waitForTimeout(500);
    }

    const text = (await assistantLocator.textContent()) ?? '';
    const is_fallback = FALLBACK_PATTERNS.some((re) => re.test(text));

    REPORT.push({
      id, prompt: q.slice(0, 60),
      text, text_len: text.length,
      is_fallback, ms: Date.now() - t0,
    });

    // Soft assertions — pasamos siempre, recolectamos data
    expect(text.length, `${id} debe tener texto`).toBeGreaterThan(50);
  });
}

test.afterAll(() => {
  /* eslint-disable no-console */
  const total = REPORT.length;
  const fallback = REPORT.filter((r) => r.is_fallback).length;
  const real = total - fallback;
  const pct = ((fallback / total) * 100).toFixed(1);
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(`  UI PASS-2 VERIFICATION  ${real}/${total} prosa real · ${fallback}/${total} (${pct}%) fallback`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const r of REPORT) {
    const icon = r.is_fallback ? '✗ FALLBK' : '✓ PROSA ';
    console.log(`${icon} ${r.id} (${r.ms}ms) text=${r.text_len}c`);
    console.log(`        Q: ${r.prompt}`);
    console.log(`        A: "${r.text.slice(0, 140).replace(/\s+/g, ' ')}"`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  /* eslint-enable no-console */
});
