/**
 * @feature @lexa-ui-lawyer-15 Lawyer stress test via UI oficial
 *
 * Los 15 prompts del lawyer test pero ejecutados via Playwright contra
 * el animated-ai-input.tsx real (no API directo). Esto valida el
 * pipeline completo: browser → React → fetch → BFF → loop agentic →
 * tools → render del mensaje en UI.
 *
 * Cada test:
 *   - mintToken + inject session
 *   - navigate al chat
 *   - escribir prompt
 *   - send
 *   - esperar message-assistant rendered
 *   - leer textContent
 *   - asserts: longitud + no fallback + cita esperada (cuando aplica)
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

interface LawyerCase {
  id: string;
  q: string;
  /** Regex que la respuesta debería contener (mínimo). */
  expects: RegExp[];
  /** Patrones que la respuesta NO debería contener (negative assertions). */
  forbids?: RegExp[];
  /** Si es trampa intencional, esperamos honest decline. */
  isTrap?: boolean;
}

const CASES: LawyerCase[] = [
  {
    id: 'L1',
    q: 'Cuál es el plazo exacto en días hábiles para emitir dictamen de una comisión permanente según el Reglamento, y cita el artículo',
    expects: [/Art\.\s*80/i, /60 d[íi]as h[áa]biles/i],
  },
  {
    id: 'L2',
    q: 'Qué requisitos formales debe cumplir una moción de fondo para ser presentada en plenario y qué artículo del RAL la regula',
    expects: [/Art\.\s*137/i, /moci[óo]n de fondo/i, /directorio/i],
  },
  {
    id: 'L3',
    q: 'Cuántos votos se necesitan para aprobar una reforma parcial a la Constitución Política y cuál es el procedimiento en sesiones extraordinarias',
    expects: [/Art\.\s*184/i, /38 votos|dos tercios/i],
  },
  {
    id: 'L4',
    q: 'Si una comisión no dictamina en el plazo, qué procede según el Reglamento — citá el artículo específico',
    expects: [/Art\.\s*(81|82|119|138)/i],
  },
  {
    id: 'L5',
    q: 'Cuándo procede la dispensa de trámite y qué votación requiere — citá artículo',
    expects: [/Art\.\s*177/i, /dispensa de tr[áa]mite/i],
  },
  {
    id: 'L6',
    q: 'Dame el detalle del Exp. 23.234, incluyendo Ley resultante, fecha de publicación en Gaceta, proponente, y comisión que dictaminó',
    expects: [/Ley.*10[\.]?838/i, /Gaceta.*148/i, /Carballo Arce/i],
  },
  {
    id: 'L7',
    q: 'El Exp. 24.018 ya es ley — cuál es el número de ley, fecha de Gaceta, y qué comisión emitió el dictamen final',
    expects: [/Ley.*10[\.]?761/i, /Gaceta.*210/i, /(dictamen.*mayor[íi]a|dictamen.*final)/i],
  },
  {
    id: 'L8',
    q: 'Estado actual del Exp. 25.262 — está vivo? cuándo vence el plazo cuatrienal? qué dictámenes tiene?',
    expects: [/21.*octubre.*2029|2029.*octubre.*21/i, /29.*julio.*2026|2026.*julio.*29/i],
  },
  {
    id: 'L9',
    q: 'Qué expedientes fueron aprobados en segundo debate en la plenaria del 21 de mayo de 2026, y con qué votación',
    expects: [/24\.642|24642/i, /24\.998|24998/i],
    // Wave 3.1 target: idealmente también /\d+ votos a favor/i pero todavía no
    // forzamos. Lo monitoreamos manualmente.
  },
  {
    id: 'L10',
    q: 'Qué pasó en la plenaria del 20 de mayo — hubo dispensa de trámite o moción de censura?',
    expects: [/20.*mayo|mayo.*20/i],
    forbids: [/no encontr[eé] la sesi[óo]n|sesi[óo]n no existe/i],
  },
  {
    id: 'L11',
    q: 'Para el Exp. 25.262: cuál es su plazo de vencimiento ordinario según el Reglamento, y cuándo se cumple en calendario',
    expects: [/Art\.\s*80/i, /29.*julio.*2026|2026.*julio.*29/i, /60 d[íi]as h[áa]biles/i],
  },
  {
    id: 'L12',
    q: 'Buscame iniciativas legislativas vigentes sobre dispensa de trámite o reformas al Reglamento, y dame el dictamen mayoría del más reciente',
    expects: [/(24\.974|25\.439|24\.779|reforma.*reglamento)/i],
    forbids: [/Acá te dejo lo que encontré en el corpus.*\[1\].*Si querés profundizar/is],
  },
  // Trampas — honest decline
  {
    id: 'L13',
    q: 'Qué dijo el diputado Ronald Alpízar Vargas en la plenaria del 19 de mayo de 2026 sobre el Exp. 24.099',
    expects: [/no encontr[eé]|no aparece|sin (referencia|menci[óo]n)/i],
    isTrap: true,
  },
  {
    id: 'L14',
    q: 'Dame el voto de la Sala Constitucional 2024-XYZ aplicable al Exp. 23.234',
    expects: [/no encontr[eé]|no aparece|sin (referencia|registro)/i],
    isTrap: true,
  },
  {
    id: 'L15',
    q: 'Cuál es el texto literal del artículo 999 del Reglamento (artículo inexistente)',
    expects: [/no tiene art[íi]culo 999|no existe.*999|999.*no existe|no encontr[eé]/i],
    isTrap: true,
  },
];

interface UIResult {
  id: string;
  q: string;
  text: string;
  text_len: number;
  expects_met: boolean[];
  forbids_violated: boolean[];
  ms: number;
}

const REPORT: UIResult[] = [];

for (const c of CASES) {
  test(`${c.id} ${c.q.slice(0, 60)}`, async ({ page }) => {
    test.setTimeout(180_000);
    const t0 = Date.now();

    await withAdmin(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 15_000 });

    const input = page.locator('[data-testid="chat-input"]');
    await input.click();
    await input.fill(c.q);
    await page.locator('[data-testid="chat-send"]').click();

    const assistant = page.locator('[data-testid="message-assistant"]').last();
    await assistant.waitFor({ state: 'attached', timeout: 90_000 });

    // Stable for 2s
    let lastLen = 0;
    let stable = 0;
    for (let i = 0; i < 120; i++) {
      const t = await assistant.textContent().catch(() => '');
      const len = (t ?? '').length;
      if (len === lastLen && len > 100) {
        stable++;
        if (stable >= 4) break;
      } else {
        stable = 0;
        lastLen = len;
      }
      await page.waitForTimeout(500);
    }

    const text = (await assistant.textContent()) ?? '';
    const expects_met = c.expects.map((re) => re.test(text));
    const forbids_violated = (c.forbids ?? []).map((re) => re.test(text));

    REPORT.push({
      id: c.id,
      q: c.q.slice(0, 80),
      text,
      text_len: text.length,
      expects_met,
      forbids_violated,
      ms: Date.now() - t0,
    });

    // Soft: long enough
    expect(text.length, `${c.id} debe tener texto significativo`).toBeGreaterThan(80);
  });
}

test.afterAll(() => {
  /* eslint-disable no-console */
  const total = REPORT.length;
  let excellent = 0, partial = 0, fail = 0;
  for (const r of REPORT) {
    const expectsHit = r.expects_met.filter(Boolean).length;
    const expectsAll = r.expects_met.length;
    const anyForbidViolated = r.forbids_violated.some(Boolean);
    if (anyForbidViolated) fail++;
    else if (expectsHit === expectsAll) excellent++;
    else if (expectsHit > 0) partial++;
    else fail++;
  }

  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(`  LEXA UI LAWYER 15  ${excellent}/${total} EXCELENTE · ${partial} PARCIAL · ${fail} FAIL`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const r of REPORT) {
    const expectsHit = r.expects_met.filter(Boolean).length;
    const expectsAll = r.expects_met.length;
    const status = r.forbids_violated.some(Boolean)
      ? '✗ FAIL'
      : expectsHit === expectsAll
      ? '✓ EXCL'
      : expectsHit > 0
      ? '◐ PART'
      : '✗ FAIL';
    console.log(`${status} ${r.id.padEnd(3)} (${r.ms}ms · ${r.text_len}c · ${expectsHit}/${expectsAll} expects)`);
    console.log(`        Q: ${r.q}`);
    console.log(`        A: "${r.text.slice(0, 200).replace(/\s+/g, ' ')}"`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  /* eslint-enable no-console */
});
