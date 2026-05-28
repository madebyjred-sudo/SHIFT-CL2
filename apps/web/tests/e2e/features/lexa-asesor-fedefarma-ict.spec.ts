/**
 * @feature @lexa-asesor-fedefarma-ict
 *
 * Audit fresh — 10 preguntas tipo abogado / consultor de asuntos públicos
 * que NUNCA fueron testeadas. Mitad FEDEFARMA (farmacéutico), mitad ICT
 * (turismo). Diseño explícito para descubrir bugs nuevos en producción.
 *
 * Capacidades que cada pregunta intenta disparar:
 *   - search_sil_expedientes (estado + dictámenes)
 *   - get_sil_expediente (detalle profundo)
 *   - search_sil_corpus (búsqueda libre por sector/tema)
 *   - search_transcripts (votaciones, debate en plenarias)
 *   - search_reglamento (procedural RAL)
 *   - search_constitucion_loal (Wave 4 #2)
 *   - search_ral_comentado (jurisprudencia procesal)
 *
 * Convención del expects:
 *   - expects[] son patrones que la respuesta debería contener si responde
 *     correctamente (cita expediente, artículo, número, fecha).
 *   - forbids[] son patrones que indicarían que Lexa NO supo responder
 *     ("no encontré", error explícito, etc).
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';

interface AsesorCase {
  id: string;
  cliente: 'FEDEFARMA' | 'ICT' | 'GENERAL';
  q: string;
  expects: RegExp[];
  forbids?: RegExp[];
}

const CASES: AsesorCase[] = [
  // ─── FEDEFARMA ────────────────────────────────────────────────────
  {
    id: 'F1',
    cliente: 'FEDEFARMA',
    q: 'Para FEDEFARMA: ¿qué estado tiene actualmente el expediente 23.496 sobre importación paralela de medicamentos? ¿Tiene dictamen?',
    expects: [/23\.?496|23496/, /(dictamen|comisi[óo]n|tr[áa]mite)/i],
    forbids: [/^.*no encontr[eé].*$/i],
  },
  {
    id: 'F2',
    cliente: 'FEDEFARMA',
    q: 'Como asesor de FEDEFARMA: lista los expedientes activos que tratan sobre regulación de mercado de medicamentos en Costa Rica',
    expects: [/(medicamentos|farmac)/i, /expediente|Exp\./i],
    forbids: [/no se encontr[oó] ning[uú]n expediente/i],
  },
  {
    id: 'F3',
    cliente: 'FEDEFARMA',
    q: 'Para el expediente 24.819 (responsabilidad farmacéutica por residuos): ¿quién es el proponente y qué comisión lo está estudiando?',
    expects: [/24\.?819|24819/, /(proponente|diputad|comisi[óo]n)/i],
  },
  {
    id: 'F4',
    cliente: 'FEDEFARMA',
    q: 'Bajo el Reglamento de la Asamblea, ¿cuántos diputados se necesitan para aprobar una reforma a la Ley de Medicamentos en segundo debate? Cita el artículo del RAL',
    expects: [/Art\.?\s*\d+|art[íi]culo\s*\d+/i, /\d+\s+votos|mayor[íi]a/i],
  },
  {
    id: 'F5',
    cliente: 'FEDEFARMA',
    q: 'Como asesor: ¿el expediente 25.136 sobre canasta básica de medicamentos avanzó en mayo de 2026? Resúmelo brevemente',
    expects: [/25\.?136|25136/, /(canasta|medicamentos|salud)/i],
  },

  // ─── ICT ──────────────────────────────────────────────────────────
  {
    id: 'I1',
    cliente: 'ICT',
    q: 'Para ICT: ¿hubo algún expediente sobre Polo Turístico Golfo de Papagayo discutido en plenarias de mayo 2026? Si sí, dime el número',
    expects: [/(Papagayo|PTGP|tur[íi]stico)/i],
  },
  {
    id: 'I2',
    cliente: 'ICT',
    q: 'Como asesor del ICT: lista los expedientes activos sobre zona marítimo-terrestre o concesiones costeras. Dame los proponentes principales',
    expects: [/(mar[íi]timo|costeras?|concesi)/i, /(diputad|proponente|expediente)/i],
  },
  {
    id: 'I3',
    cliente: 'ICT',
    q: 'Para ICT: ¿qué expedientes vigentes tocan el régimen de Airbnb, hospedaje o alquileres de corta estancia?',
    expects: [/(Airbnb|hospedaje|alquiler|alojamiento|tur[íi]stico)/i],
  },

  // ─── GENERAL / Procedural lawyer-grade ────────────────────────────
  {
    id: 'G1',
    cliente: 'GENERAL',
    q: '¿Cuántos votos necesita la Asamblea para aprobar un convenio internacional bilateral en segundo debate? Cita el artículo de la Constitución Política',
    expects: [/Art\.?\s*\d+|art[íi]culo\s*\d+/i, /(Constituci[óo]n|votos|mayor[íi]a)/i],
  },
  {
    id: 'G2',
    cliente: 'GENERAL',
    q: 'Bajo el Reglamento, cuando un expediente entra a consulta facultativa ante la Sala IV, ¿puede continuar el debate en plenario mientras la Sala resuelve? Cita el artículo',
    expects: [/Art\.?\s*\d+|art[íi]culo\s*\d+/i, /(suspende|continúa|Sala|consulta)/i],
  },
];

interface Result {
  id: string;
  cliente: string;
  q: string;
  text: string;
  text_len: number;
  expects_met: boolean[];
  forbids_violated: boolean[];
  ms: number;
}

const REPORT: Result[] = [];

for (const c of CASES) {
  test(`${c.id}[${c.cliente}] ${c.q.slice(0, 50)}`, async ({ page }) => {
    test.setTimeout(360_000);
    const t0 = Date.now();

    await withAdmin(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 15_000 });

    const input = page.locator('[data-testid="chat-input"]');
    await input.click();
    await input.fill(c.q);
    await page.keyboard.press('Enter');

    const assistant = page.locator('[data-testid="message-assistant"]').last();
    await assistant.waitFor({ state: 'attached', timeout: 240_000 });

    // Wait until stable for ~3s
    let lastLen = 0;
    for (let i = 0; i < 200; i++) {
      const txt = await assistant.textContent();
      const n = txt?.length ?? 0;
      if (n > 0 && n === lastLen) break;
      lastLen = n;
      await page.waitForTimeout(500);
    }

    const text = (await assistant.textContent()) ?? '';
    const expectsMet = c.expects.map((r) => r.test(text));
    const forbidsViolated = (c.forbids ?? []).map((r) => r.test(text));
    const result: Result = {
      id: c.id,
      cliente: c.cliente,
      q: c.q,
      text,
      text_len: text.length,
      expects_met: expectsMet,
      forbids_violated: forbidsViolated,
      ms: Date.now() - t0,
    };
    REPORT.push(result);

    const passedExpects = expectsMet.filter(Boolean).length;
    const totalExpects = expectsMet.length;
    const totalForbids = forbidsViolated.filter(Boolean).length;
    const status =
      passedExpects === totalExpects && totalForbids === 0
        ? '✓ EXCL'
        : passedExpects > 0 && totalForbids === 0
          ? '◐ PART'
          : '✗ FAIL';

    console.log(
      `${status} ${c.id}[${c.cliente}] (${result.ms}ms · ${result.text_len}c · ${passedExpects}/${totalExpects} expects · ${totalForbids} forbids violated)\n        Q: ${c.q}\n        A: "${text.slice(0, 350)}"`,
    );

    // No bloqueamos el spec si parcial — solo si TODOS los expects fallaron o
    // se violó algún forbid. Esto permite ver el panorama completo del audit.
    expect(passedExpects, `${c.id}: 0 expects matched`).toBeGreaterThan(0);
    expect(totalForbids, `${c.id}: forbid pattern matched`).toBe(0);
  });
}

test.afterAll(() => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ASESOR FEDEFARMA + ICT — REPORT FINAL');
  console.log('══════════════════════════════════════════════════════════');
  const excl = REPORT.filter((r) => r.expects_met.every(Boolean) && r.forbids_violated.every((v) => !v)).length;
  const part = REPORT.filter((r) => r.expects_met.some(Boolean) && !r.expects_met.every(Boolean)).length;
  const fail = REPORT.length - excl - part;
  console.log(`Resultados: ${excl} EXCL · ${part} PART · ${fail} FAIL (sobre ${REPORT.length})\n`);
});
