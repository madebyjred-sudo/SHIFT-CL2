/**
 * @feature @lexa-stress Lexa stress test — prompts difíciles
 *
 * Suite de prompts que prueban cada path de Lexa contra prod o local.
 * NO valida una respuesta literal — captura los outputs y emite warnings
 * cuando ocurre algo sospechoso (fallback genérico, finish_reason='stop'
 * con content vacío, citations vacías). El operador revisa después.
 *
 * Categorías:
 *   T1 — expediente directo (verifica estatus formal)
 *   T2 — sesión por fecha (verifica resumen ejecutivo)
 *   T3 — reglamento (verifica tools de RAL)
 *   T4 — transcripts (verifica search_transcripts con keyword)
 *   T5 — comparativos (cruzar dos expedientes)
 *   T6 — preguntas trampa (info que NO debería estar)
 *   T7 — vagas (deben caer en fallback elegante, no en crash)
 *
 * Correr local:
 *   cd apps/web && E2E_BASE_URL=http://localhost:5173 \
 *     API_BASE_URL=http://localhost:3001 \
 *     npx playwright test tests/e2e/features/lexa-stress.spec.ts \
 *       --reporter=list --workers=1
 *
 * Correr prod:
 *   E2E_BASE_URL=https://cl2-v2-web-u3rliii7wa-uc.a.run.app \
 *     API_BASE_URL=https://cl2-v2-api-u3rliii7wa-uc.a.run.app ...
 */
import { test, expect } from '@playwright/test';
import { mintToken } from '../_helpers/auth';
import { E2E_ENV } from '../_helpers/env';

interface ChatResult {
  text: string;
  citations: number;
  errors: string[];
}

async function askLexa(prompt: string, deep_insight = false): Promise<ChatResult> {
  const session = await mintToken('madebyjred@gmail.com');
  const apiBase = E2E_ENV.apiBaseUrl;
  const res = await fetch(`${apiBase}/api/chat/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agent_id: 'lexa', query: prompt, deep_insight }),
  });
  if (!res.ok || !res.body) {
    return { text: '', citations: 0, errors: [`HTTP ${res.status}`] };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let citations = 0;
  const errors: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(line.slice(6)) as { type?: string; payload?: unknown };
        if (json.type === 'token' && typeof json.payload === 'string') text += json.payload;
        else if (json.type === 'citation' && Array.isArray(json.payload)) citations += json.payload.length;
        else if (json.type === 'error') errors.push(JSON.stringify(json.payload));
      } catch {
        /* malformed line */
      }
    }
  }

  return { text, citations, errors };
}

const GENERIC_FALLBACK_REGEX = /No encontr.*una respuesta concreta para esta consulta/i;
const CONSULTE_FUENTES_REGEX = /Consult[eé].*las fuentes disponibles/i;
const TOOL_LEAK_REGEX = /Resultados SIL \(\d+\):|MON[ÓO]LOGO INTERNO|Stress level/i;

// ════════════════════════════════════════════════════════════════════════════
// REPORTE: capturamos cada respuesta a un objeto compartido para imprimir
// al final un resumen completo. Esto permite ver el panorama de toda la
// suite en una sola corrida.
// ════════════════════════════════════════════════════════════════════════════
const REPORT: Array<{
  tier: string;
  prompt: string;
  ok: boolean;
  flags: string[];
  preview: string;
  citations: number;
  text_len: number;
}> = [];

function analyze(prompt: string, result: ChatResult, tier: string): { ok: boolean; flags: string[] } {
  const flags: string[] = [];
  if (result.errors.length > 0) flags.push('errors:' + result.errors.join('|'));
  if (TOOL_LEAK_REGEX.test(result.text)) flags.push('TOOL_LEAK');
  if (GENERIC_FALLBACK_REGEX.test(result.text)) flags.push('GENERIC_FALLBACK');
  if (CONSULTE_FUENTES_REGEX.test(result.text)) flags.push('FUENTES_FALLBACK');
  if (result.text.length === 0) flags.push('EMPTY_RESPONSE');
  if (result.text.length < 50 && !flags.includes('EMPTY_RESPONSE')) flags.push('VERY_SHORT');

  const ok = flags.filter((f) => !['VERY_SHORT', 'FUENTES_FALLBACK'].includes(f)).length === 0;
  return { ok, flags };
}

async function runPrompt(tier: string, prompt: string, mustContain?: RegExp[]) {
  const result = await askLexa(prompt);
  const { ok, flags } = analyze(prompt, result, tier);
  const preview = result.text.slice(0, 300).replace(/\s+/g, ' ');
  REPORT.push({ tier, prompt, ok, flags, preview, citations: result.citations, text_len: result.text.length });

  // Cada test verifica lo mínimo: respuesta no vacía y sin tool leak.
  expect(result.text.length, `[${tier}] respuesta vacía a: "${prompt}"`).toBeGreaterThan(0);
  expect(TOOL_LEAK_REGEX.test(result.text), `[${tier}] TOOL LEAK detectado: ${result.text.slice(0, 200)}`).toBe(false);

  if (mustContain) {
    for (const re of mustContain) {
      const matches = re.test(result.text);
      if (!matches) {
        // Lo registramos como flag pero NO fail — algunas respuestas son válidas aunque no matcheen el regex
        REPORT[REPORT.length - 1]!.flags.push(`MISS:${re.source.slice(0, 30)}`);
      }
    }
  }
}

test.describe('@lexa-stress Lexa — preguntas difíciles', () => {
  test.setTimeout(120_000);

  // T1 — Expediente directo, verifica estatus formal
  test('T1.1 — expediente que es ley (23.234)', async () => {
    await runPrompt('T1.1', 'El expediente 23.234 ya es ley? Dame número y gaceta', [
      /10838|ES LEY/i,
    ]);
  });

  test('T1.2 — expediente en trámite (25.262)', async () => {
    await runPrompt('T1.2', 'Cuéntame sobre el expediente 25.262', [/25\.262/]);
  });

  test('T1.3 — expediente sin formato canónico ("expediente 24018")', async () => {
    await runPrompt('T1.3', 'Tienes algo del expediente 24018', [/24\.018|24018/]);
  });

  // T2 — Sesiones por fecha
  test('T2.1 — plenaria 21 mayo 2026', async () => {
    await runPrompt('T2.1', 'Qué se discutió en la sesión plenaria del 21 de mayo de 2026', [
      /plenaria|sesi[óo]n|discusi[óo]n/i,
    ]);
  });

  test('T2.2 — formato fecha alternativo', async () => {
    await runPrompt('T2.2', 'Resumeme la plenaria del 20/05/2026', [/plenaria|sesi[óo]n/i]);
  });

  // T3 — Reglamento
  test('T3.1 — artículo específico del RAL', async () => {
    await runPrompt('T3.1', 'Cuál es el plazo de dictamen según el reglamento?', [
      /art[íi]culo|plazo|d[íi]as/i,
    ]);
  });

  test('T3.2 — moción de orden artículo 137', async () => {
    await runPrompt('T3.2', 'Cómo se vota una moción de orden según el artículo 137', [
      /137|moci[óo]n/i,
    ]);
  });

  // T4 — Transcripts keyword
  test('T4.1 — keyword genérica', async () => {
    await runPrompt('T4.1', 'Buscame menciones a recurso hídrico en las plenarias recientes');
  });

  test('T4.2 — keyword muy específica', async () => {
    await runPrompt('T4.2', 'Dame las menciones a PANI en la plenaria del 21 de mayo');
  });

  // T5 — Comparativos
  test('T5.1 — comparación de dos expedientes', async () => {
    await runPrompt('T5.1', 'Comparame los expedientes 23.234 y 23.511, cuál es ley?');
  });

  // T6 — Trampa: info que no existe
  test('T6.1 — expediente inventado', async () => {
    await runPrompt('T6.1', 'Qué dice el expediente 99.999 sobre energía solar');
  });

  test('T6.2 — sesión que no existe', async () => {
    await runPrompt('T6.2', 'Resume la plenaria del 1 de enero de 2000');
  });

  // T7 — Prompts vagos
  test('T7.1 — vago sobre tema amplio', async () => {
    await runPrompt('T7.1', 'Qué está pasando con las pensiones?');
  });

  test('T7.2 — vago sin contexto', async () => {
    await runPrompt('T7.2', 'Resumime lo importante');
  });

  // ════════════════════════════════════════════════════════════════════════
  // Reporte final
  // ════════════════════════════════════════════════════════════════════════
  test.afterAll(() => {
    const sorted = [...REPORT].sort((a, b) => Number(a.ok) - Number(b.ok));
    /* eslint-disable no-console */
    console.log('\n\n══════════════════════════════════════════════════════════');
    console.log('  LEXA STRESS REPORT                              ' + new Date().toISOString());
    console.log('══════════════════════════════════════════════════════════');
    for (const r of sorted) {
      const icon = r.ok ? '✓' : '✗';
      console.log(
        `${icon} [${r.tier}] (${r.text_len}c · ${r.citations}cit) ${r.flags.length > 0 ? '— ' + r.flags.join(', ') : ''}`,
      );
      console.log(`   Q: ${r.prompt}`);
      console.log(`   A: ${r.preview.slice(0, 200)}...`);
    }
    const totals = {
      total: REPORT.length,
      ok: REPORT.filter((r) => r.ok).length,
      tool_leak: REPORT.filter((r) => r.flags.includes('TOOL_LEAK')).length,
      generic: REPORT.filter((r) => r.flags.includes('GENERIC_FALLBACK')).length,
      empty: REPORT.filter((r) => r.flags.includes('EMPTY_RESPONSE')).length,
      avg_len: Math.round(REPORT.reduce((a, b) => a + b.text_len, 0) / REPORT.length),
    };
    console.log('\nTOTALES:');
    console.log(`  ${totals.ok}/${totals.total} OK`);
    console.log(`  ${totals.tool_leak} con TOOL_LEAK`);
    console.log(`  ${totals.generic} con GENERIC_FALLBACK`);
    console.log(`  ${totals.empty} EMPTY_RESPONSE`);
    console.log(`  Avg length: ${totals.avg_len} chars`);
    console.log('══════════════════════════════════════════════════════════\n');
    /* eslint-enable no-console */
  });
});
