/**
 * @feature @lexa-expediente-chat Verifica "Preguntale a Lexa" scopado a expediente
 *
 * Flujo E2E completo:
 *   1. Login como admin
 *   2. Navegar a /expediente/23.234 (expediente con datos enriquecidos)
 *   3. Click en tab "Preguntale a Lexa"
 *   4. Escribir pregunta sobre el expediente
 *   5. Enviar y esperar respuesta
 *   6. Verificar que la respuesta es prosa real (no fallback) y cita fuentes
 *
 * Success criteria:
 *   - El chat input se renderiza dentro del tab del expediente
 *   - La respuesta tiene >150 chars
 *   - La respuesta NO es fallback
 *   - La respuesta menciona el expediente o su contenido (soft assert)
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

const EXPEDIENTE_NUMERO = '23.234';

const PROMPTS = [
  {
    id: 'EXP-1',
    q: '¿De qué trata este expediente?',
    expect_keywords: /expediente|trata|iniciativa|proyecto|ley/i,
  },
  {
    id: 'EXP-2',
    q: '¿Quiénes son los proponentes?',
    expect_keywords: /proponente|diputado|firma|present/i,
  },
  {
    id: 'EXP-3',
    q: '¿En qué estado está la tramitación?',
    expect_keywords: /estado|tramit|comisi|dict|debate/i,
  },
];

const FALLBACK_PATTERNS = [
  /No encontr[eé] una respuesta concreta/i,
  /Ac[áa] te dejo lo que encontr[eé] en el corpus/i,
  /Esto es lo que tengo registrado/i,
  /Consult[eé] las fuentes disponibles.*no encontr/i,
  /No tengo informaci[óo]n suficiente/i,
];

/** El modelo NO debe pedir el número de expediente — ya lo tiene en el system prompt */
const ASKING_FOR_EXPEDIENTE_PATTERNS = [
  /¿Me indicás el número de expediente/i,
  /¿De cuál expediente/i,
  /¿De qué expediente/i,
  /pasame el número de expediente/i,
  /indicame el expediente/i,
];

interface ExpedienteChatResult {
  id: string;
  prompt: string;
  text: string;
  text_len: number;
  is_fallback: boolean;
  keyword_match: boolean;
  asks_for_expediente: boolean;
  ms: number;
}

const REPORT: ExpedienteChatResult[] = [];

for (const { id, q, expect_keywords } of PROMPTS) {
  test(`${id} — ${q}`, async ({ page }) => {
    test.setTimeout(180_000);
    const t0 = Date.now();

    await withAdmin(page);
    await page.goto(`/expediente/${EXPEDIENTE_NUMERO}`);

    // Esperar a que cargue el header del expediente
    await page.waitForSelector(`text=Exp. ${EXPEDIENTE_NUMERO}`, { timeout: 15_000 });

    // Click en tab "Preguntale a Lexa"
    const lexaTab = page.locator('button', { hasText: 'Preguntale a Lexa' });
    await lexaTab.waitFor({ state: 'visible', timeout: 10_000 });
    await lexaTab.click();

    // Esperar a que el chat input se renderice dentro del tab
    const input = page.locator('[data-testid="chat-input"]');
    await input.waitFor({ state: 'visible', timeout: 10_000 });

    // Verificar que el placeholder menciona el expediente (indica scope correcto)
    const placeholder = await input.getAttribute('placeholder');
    expect(placeholder).toContain(EXPEDIENTE_NUMERO);

    // Escribir pregunta
    await input.click();
    await input.fill(q);

    // Enviar
    await page.locator('[data-testid="chat-send"]').click();

    // Esperar respuesta del asistente
    const assistantLocator = page.locator('[data-testid="message-assistant"]').last();
    await assistantLocator.waitFor({ state: 'attached', timeout: 90_000 });

    // Esperar a que termine de stream (texto estable por 2s)
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
    const keyword_match = expect_keywords.test(text);
    const asks_for_expediente = ASKING_FOR_EXPEDIENTE_PATTERNS.some((re) => re.test(text));

    REPORT.push({
      id,
      prompt: q,
      text,
      text_len: text.length,
      is_fallback,
      keyword_match,
      asks_for_expediente,
      ms: Date.now() - t0,
    });

    // Assertions
    expect(text.length, `${id} debe tener respuesta sustancial`).toBeGreaterThan(150);
    expect(is_fallback, `${id} no debe caer a fallback`).toBe(false);
    expect(asks_for_expediente, `${id} NO debe pedir el número de expediente — ya lo tiene en el contexto`).toBe(false);
  });
}

test.afterAll(() => {
  /* eslint-disable no-console */
  const total = REPORT.length;
  const fallback = REPORT.filter((r) => r.is_fallback).length;
  const keyword_hits = REPORT.filter((r) => r.keyword_match).length;
  const asking = REPORT.filter((r) => r.asks_for_expediente).length;
  const real = total - fallback;
  const pct = ((fallback / total) * 100).toFixed(1);

  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(`  EXPEDIENTE CHAT VERIFICATION  ${real}/${total} prosa real · ${fallback}/${total} (${pct}%) fallback`);
  console.log(`  Keyword match: ${keyword_hits}/${total} · Pide expediente: ${asking}/${total}`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const r of REPORT) {
    const icon = r.is_fallback ? '✗ FALLBK' : r.asks_for_expediente ? '? PIDE #' : r.keyword_match ? '✓ PROSA ' : '~ PROSA ';
    console.log(`${icon} ${r.id} (${r.ms}ms) text=${r.text_len}c keyword=${r.keyword_match} asks=${r.asks_for_expediente}`);
    console.log(`        Q: ${r.prompt}`);
    console.log(`        A: "${r.text.slice(0, 140).replace(/\s+/g, ' ')}"`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  /* eslint-enable no-console */
});
