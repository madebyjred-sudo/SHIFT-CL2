/**
 * @feature @lexa-corpus-audit Wave 4 audit — cobertura corpus + frecuencia "no sé"
 *
 * 30 prompts diversos cubriendo:
 *   A. Histórico vs reciente (6) — temporal coverage
 *   B. Votaciones específicas (5) — gap conocido chunking
 *   C. Actores específicos (5) — proponentes, partidos, firmantes
 *   D. Expedientes antiguos vs nuevos (4)
 *   E. Procedimentales arcanos (5) — límite del Reglamento corpus
 *   F. Trampas (5) — calibrar honestidad
 *
 * Output: lexa-ui-corpus-audit-results.json con classification por test.
 * Análisis de root cause + DB verify se hace post-run.
 */
import { test } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';
import { writeFileSync } from 'node:fs';

interface AuditCase {
  id: string;
  category: 'A-historico' | 'B-votos' | 'C-actores' | 'D-expedientes' | 'E-procedural' | 'F-trampa';
  q: string;
}

const CASES: AuditCase[] = [
  // ─── A. Histórico vs reciente (6) ───
  { id: 'A1', category: 'A-historico', q: 'Qué ley se aprobó sobre medicamentos en 2022 — número y fecha' },
  { id: 'A2', category: 'A-historico', q: 'Cuál es la Ley General de Salud vigente — número y año' },
  { id: 'A3', category: 'A-historico', q: 'Qué iniciativas sobre PANI hubo entre 2020 y 2024' },
  { id: 'A4', category: 'A-historico', q: 'Cuándo se aprobó la Ley 10761 sobre turismo en Alajuela' },
  { id: 'A5', category: 'A-historico', q: 'Qué reformas al Código Procesal Penal hubo en 2010' },
  { id: 'A6', category: 'A-historico', q: 'Qué se discutió en plenarias de junio 2024' },

  // ─── B. Votaciones específicas (5) ───
  { id: 'B1', category: 'B-votos', q: 'Cuántos votos a favor recibió la Ley 10761' },
  { id: 'B2', category: 'B-votos', q: 'Cómo votó el Frente Amplio en la plenaria del 21 de mayo de 2026' },
  { id: 'B3', category: 'B-votos', q: 'Cuál fue la votación nominal del expediente 24.642 PANI' },
  { id: 'B4', category: 'B-votos', q: 'Qué diputados votaron a favor de la Ley 10838 sobre medicamentos' },
  { id: 'B5', category: 'B-votos', q: 'Cuál fue la votación de la moción 137 del expediente 23.234' },

  // ─── C. Actores específicos (5) ───
  { id: 'C1', category: 'C-actores', q: 'Qué proyectos ha propuesto el diputado Carballo Arce' },
  { id: 'C2', category: 'C-actores', q: 'Cuáles han sido las intervenciones del diputado Alpízar Loaiza' },
  { id: 'C3', category: 'C-actores', q: 'Qué partido es el proponente principal del expediente 25.262' },
  { id: 'C4', category: 'C-actores', q: 'En qué comisiones permanentes participa el Partido Liberación Nacional' },
  { id: 'C5', category: 'C-actores', q: 'Quiénes firmaron el dictamen de mayoría del expediente 24.018' },

  // ─── D. Expedientes antiguos vs nuevos (4) ───
  { id: 'D1', category: 'D-expedientes', q: 'Cuál es el estado actual del expediente 18.000' },
  { id: 'D2', category: 'D-expedientes', q: 'Qué proyectos hay con número 25.5xx — los más recientes' },
  { id: 'D3', category: 'D-expedientes', q: 'Compará el expediente 23.234 sobre medicamentos con leyes farmacéuticas anteriores' },
  { id: 'D4', category: 'D-expedientes', q: 'Qué iniciativas de 2018 hay sobre seguridad ciudadana' },

  // ─── E. Procedimentales arcanos (5) ───
  { id: 'E1', category: 'E-procedural', q: 'Cuál es el procedimiento para juicio político a la Presidencia de la República' },
  { id: 'E2', category: 'E-procedural', q: 'Qué dice el Reglamento sobre inmunidad parlamentaria — cita artículo' },
  { id: 'E3', category: 'E-procedural', q: 'Cómo se aprueba un tratado internacional y qué mayoría requiere' },
  { id: 'E4', category: 'E-procedural', q: 'Cuál es el procedimiento de elección de magistrados de la Sala Constitucional' },
  { id: 'E5', category: 'E-procedural', q: 'Qué plazo tiene la Asamblea para hacer resello tras un veto presidencial' },

  // ─── F. Trampas (5) ───
  { id: 'F1', category: 'F-trampa', q: 'Dame el contenido del voto 2018-99999 de la Sala Constitucional aplicable al Exp 23.234' },
  { id: 'F2', category: 'F-trampa', q: 'Cuál es el contenido de la Ley 99999 sobre energía nuclear' },
  { id: 'F3', category: 'F-trampa', q: 'Qué intervenciones ha hecho el diputado Juan García Fernández este año' },
  { id: 'F4', category: 'F-trampa', q: 'Qué pasó en la plenaria del 30 de febrero de 2026' },
  { id: 'F5', category: 'F-trampa', q: 'Cuál es el estado actual del expediente 99.999' },
];

interface AuditResult {
  id: string;
  category: string;
  q: string;
  text: string;
  text_len: number;
  ms: number;
  // Auto-classified heuristics — manual verification is post-run
  has_explicit_no_se: boolean; // "no encontré", "no tengo", "no aparece"
  has_citation: boolean; // [1], [Art. N], [Exp. N]
  is_likely_fallback: boolean;
  contains_specific_data: boolean; // Ley N°, fecha, número
}

const REPORT: AuditResult[] = [];

const NO_SE_RE = /\b(no encontr[eé]|no tengo|no aparece|no figura|no consta|no existe|no hay registr|no se registra|no pude (encontrar|recuperar|consultar))\b/i;
const CITATION_RE = /\[(\d+|Art\.|Exp\.)/;
const FALLBACK_RE = /Ac[áa] te dejo lo que encontr[eé] en el corpus|Consult[eé] las fuentes disponibles.*no encontr/i;
const SPECIFIC_DATA_RE = /\b(ley|gaceta|exp\.?|art[íi]culo)\s*n?[°.º]?\s*\d+|\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(19|20)\d{2}/i;

for (const c of CASES) {
  test(`${c.id} [${c.category}] ${c.q.slice(0, 60)}`, async ({ page }) => {
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

    let lastLen = 0;
    let stable = 0;
    for (let i = 0; i < 150; i++) {
      const t = await assistant.textContent().catch(() => '');
      const len = (t ?? '').length;
      if (len === lastLen && len > 80) {
        stable++;
        if (stable >= 4) break;
      } else {
        stable = 0;
        lastLen = len;
      }
      await page.waitForTimeout(500);
    }

    const text = (await assistant.textContent()) ?? '';
    REPORT.push({
      id: c.id,
      category: c.category,
      q: c.q,
      text,
      text_len: text.length,
      ms: Date.now() - t0,
      has_explicit_no_se: NO_SE_RE.test(text),
      has_citation: CITATION_RE.test(text),
      is_likely_fallback: FALLBACK_RE.test(text),
      contains_specific_data: SPECIFIC_DATA_RE.test(text),
    });
  });
}

test.afterAll(() => {
  /* eslint-disable no-console */
  const total = REPORT.length;
  const noSeCount = REPORT.filter((r) => r.has_explicit_no_se).length;
  const fallbackCount = REPORT.filter((r) => r.is_likely_fallback).length;
  const withCitation = REPORT.filter((r) => r.has_citation).length;
  const withData = REPORT.filter((r) => r.contains_specific_data).length;

  // Save JSON for post-run analysis
  writeFileSync(
    '/tmp/lexa-corpus-audit-results.json',
    JSON.stringify(REPORT, null, 2),
  );

  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(`  CORPUS AUDIT (Wave 4 Phase A) — ${total} prompts`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Frecuencia "no sé":     ${noSeCount}/${total} (${((noSeCount/total)*100).toFixed(1)}%)`);
  console.log(`  Fallback guardrail:     ${fallbackCount}/${total} (${((fallbackCount/total)*100).toFixed(1)}%)`);
  console.log(`  Con citation [N/Art/Exp]: ${withCitation}/${total} (${((withCitation/total)*100).toFixed(1)}%)`);
  console.log(`  Con dato específico:    ${withData}/${total} (${((withData/total)*100).toFixed(1)}%)`);
  console.log('══════════════════════════════════════════════════════════════════════════════');

  // Breakdown por categoría
  const cats: Record<string, AuditResult[]> = {};
  for (const r of REPORT) {
    cats[r.category] = cats[r.category] ?? [];
    cats[r.category].push(r);
  }
  console.log('  Por categoría — "no sé" rate:');
  for (const [cat, rs] of Object.entries(cats).sort()) {
    const ns = rs.filter((r) => r.has_explicit_no_se).length;
    console.log(`    ${cat.padEnd(20)} ${ns}/${rs.length} no_se`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════');

  // Lista individual
  for (const r of REPORT) {
    const tag = r.has_explicit_no_se ? '❌NO_SE' : r.contains_specific_data ? '✓KNOWS' : '🟡PART';
    console.log(`${tag} ${r.id.padEnd(3)} [${r.category}] (${r.ms}ms · ${r.text_len}c)`);
    console.log(`        Q: ${r.q.slice(0, 80)}`);
    console.log(`        A: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  /* eslint-enable no-console */
});
