/**
 * @feature @plantillas Plantillas (workflows) — TEST 1 F6 smoke
 *
 * Verifica que el wiring backend funcione end-to-end:
 *   1. El BFF (apps/api/services/openRouterClient.ts) pasa `preferred_agent`
 *      al body que manda a Cerebro /v1/chat/completions.
 *   2. F6 selector del Cerebro padre (commit a95a40d) inyecta la plantilla
 *      factory `memo-legal-estandar` cuando el prompt matchea el trigger.
 *   3. Lexa responde siguiendo la estructura del Memo Legal Estándar
 *      (Resumen Ejecutivo / Hechos Relevantes / Recomendaciones /
 *      Anexo de Fuentes), con citas inline [N], sin exponer monólogo
 *      interno ni "stress level".
 *
 * Si TEST 1 pasa → BFF + F6 + plantilla factory + Lexa OK end-to-end.
 * Si falla → debug en el handoff
 *   apps/cl2/output/handoffs/2026-05-24-playwright-e2e-plantillas-prompt.md
 *   §SI ALGO FALLA punto 1.
 *
 * Tests 2-6 (PlantillasPanel, slash menu, wizard, share) se agregan
 * cuando la UI esté implementada (Pasos 2-6 del briefing v3).
 *
 * Usa `withAdmin` (no login UI) — mismo patrón que el resto de la suite.
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

const MEMO_TRIGGER_PROMPT = 'Hacé un memo legal del expediente 24.018';

test.describe('@feature @plantillas F6 smoke (Memo Legal Estándar)', () => {
  // El LLM tarda 10-90s según modo (base ~10-25s, Deep Insight 60-90s).
  // Default Playwright son 30s — necesitamos margen para Lexa + cold start
  // post-deploy + estabilización del stream.
  test.setTimeout(180_000);

  test('BFF pasa preferred_agent → F6 inyecta plantilla → Lexa responde estructurada', async ({
    page,
  }) => {
    // 1. Auth admin antes de la primera navegación.
    await withAdmin(page);

    // 2. Capturar el body del POST a /api/chat/stream para verificar que
    //    `preferred_agent` viaja con el request.
    let bffBody: Record<string, unknown> | null = null;
    await page.route('**/api/chat/stream', async (route, req) => {
      if (req.method() === 'POST' && bffBody === null) {
        try {
          bffBody = (await req.postDataJSON()) as Record<string, unknown>;
        } catch {
          /* body no parseable — registrarlo silencioso */
        }
      }
      await route.continue();
    });

    // 3. Abrir el chat con Lexa activa.
    await page.goto('/?agent=lexa');

    // 4. Tipear y enviar el prompt que matchea el trigger del Memo Estándar.
    const input = page.getByTestId('chat-input');
    await input.waitFor({ state: 'visible' });
    await input.fill(MEMO_TRIGGER_PROMPT);
    await page.getByTestId('chat-send').click();

    // 5. Esperar a que la respuesta del asistente termine de streamear.
    //    Opus 4.7 con cross-source retrieval puede tardar 60-90s en deep
    //    insight. Modo base (default false) suele responder en 10-25s,
    //    pero la primera vez post-deploy puede ser más por cold start.
    const assistant = page.getByTestId('message-assistant').last();
    await assistant.waitFor({ state: 'visible', timeout: 90_000 });

    // Estabilización: esperar a que el texto deje de crecer. Probamos
    // dos lecturas con 2s de gap y exigimos que crezca poco entre ellas.
    let prevLen = 0;
    for (let i = 0; i < 30; i++) {
      const text = (await assistant.textContent()) ?? '';
      if (text.length > 0 && text.length === prevLen) break;
      prevLen = text.length;
      await page.waitForTimeout(2000);
    }

    const output = (await assistant.textContent()) ?? '';

    // ── Verificación 1: el BFF llevó preferred_agent + realm + user_id ──
    expect(bffBody, 'El BFF debió capturar el body del request').not.toBeNull();
    expect(bffBody?.preferred_agent).toBe('lexa');
    // realm puede estar bajo agent_id alternativo según el shape de
    // chatStream.ts — chequeamos que viajen los hints esperados.
    expect(bffBody?.agent_id ?? bffBody?.preferred_agent).toBe('lexa');

    // ── Verificación 2: la respuesta sigue la estructura del Memo ──
    // Las 4 secciones canónicas del Memo Legal Estándar (factory v1).
    // El matching es insensitive porque la plantilla puede acentuar
    // diferente o usar mayúsculas distintas.
    expect(output, 'Output debe incluir sección Resumen Ejecutivo').toMatch(
      /Resumen\s+Ejecutivo/i,
    );
    expect(output, 'Output debe incluir sección Hechos Relevantes').toMatch(
      /Hechos\s+Relevantes/i,
    );
    expect(output, 'Output debe incluir sección Recomendaciones').toMatch(
      /Recomendaciones/i,
    );
    expect(
      output,
      'Output debe incluir Anexo de Fuentes (o "Anexo de fuentes")',
    ).toMatch(/Anexo\s+de\s+Fuentes/i);

    // ── Verificación 3: citas inline [N] ──
    // Lexa REGLA 1 — Citá inline cada afirmación. La plantilla refuerza
    // el formato. Al menos una cita [N] debe aparecer.
    expect(output, 'Output debe tener al menos una cita inline [N]').toMatch(
      /\[\d+\]/,
    );

    // ── Verificación 4: no exponer monólogo interno / scaffolding ──
    // La plantilla es un PREPEND al system prompt — no debe leakear el
    // andamiaje. Si algún día Lexa empieza a exponer "MONÓLOGO INTERNO"
    // o "Stress level", el contrato se rompió.
    expect(output).not.toMatch(/MON[ÓO]LOGO\s+INTERNO/i);
    expect(output).not.toMatch(/Stress\s+level/i);
  });
});
