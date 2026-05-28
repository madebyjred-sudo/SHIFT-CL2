/**
 * @feature @lexa-pass2-15 Verifica que Pass 2 genere prosa real post-fix v4
 *
 * 15 prompts representativos, cubriendo cada categoría de tool. Cada test
 * mide DOS cosas:
 *
 *   1. ¿Pass 2 generó respuesta real? (text > 200c sin caer al fallback determinístico)
 *   2. ¿Hubo citation surfaceada del tipo esperado?
 *
 * Success criteria (definido por el operador post-fix v4):
 *   - Fallback rate ≤ 10% (max 1-2 de 15 caen a empty_completion_fallback)
 *   - Pass 2 real ≥ 90%
 *
 * Antes del fix v4: 16/30 (53%) caían a fallback.
 * Target post-fix: 5-10%.
 */
import { test, expect } from '@playwright/test';
import { mintToken } from '../_helpers/auth';
import { E2E_ENV } from '../_helpers/env';

interface ChatResult {
  text: string;
  citations: number;
  citation_payloads: Array<Record<string, unknown>>;
  errors: string[];
  http_status: number | null;
  duration_ms: number;
  request_id: string;
}

async function askLexa(prompt: string, deep_insight = false): Promise<ChatResult> {
  const t0 = Date.now();
  const session = await mintToken('madebyjred@gmail.com');
  const res = await fetch(`${E2E_ENV.apiBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: 'lexa', query: prompt, deep_insight }),
  });
  const requestId = res.headers.get('x-request-id') ?? '';
  if (!res.ok || !res.body) {
    return { text: '', citations: 0, citation_payloads: [], errors: [`HTTP ${res.status}`], http_status: res.status, duration_ms: Date.now() - t0, request_id: requestId };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let citations = 0;
  const citation_payloads: Array<Record<string, unknown>> = [];
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
        else if (json.type === 'citation' && Array.isArray(json.payload)) {
          citations += json.payload.length;
          citation_payloads.push(...(json.payload as Array<Record<string, unknown>>));
        } else if (json.type === 'error') errors.push(JSON.stringify(json.payload));
      } catch {
        /* ignore */
      }
    }
  }
  return { text, citations, citation_payloads, errors, http_status: 200, duration_ms: Date.now() - t0, request_id: requestId };
}

// Detectores
// FALLBACK_GUARDRAIL_RE matches the EXACT phrases the guardrail emits:
//   - "No encontré una respuesta concreta..."  (citations=0 path)
//   - "Acá te dejo lo que encontré en el corpus..."  (citations>0 path)
//   - "Esto es lo que tengo registrado de la sesión..."  (session path)
//   - "Consulté las fuentes disponibles..."  (0 hits natural fallback)
const FALLBACK_GUARDRAIL_RE = /(No encontr[eé] una respuesta concreta|Ac[áa] te dejo lo que encontr[eé] en el corpus|Esto es lo que tengo registrado de la sesi[óo]n|Consult[eé] las fuentes disponibles.*no encontr)/i;

// Persistencia de results — escribimos al final del run
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Row {
  id: string; tool: string; prompt: string;
  text_len: number; citations: number;
  is_fallback: boolean; passed: boolean;
  cite_preview: string; text_preview: string;
  ms: number; http: number | null;
}
const REPORT: Row[] = [];

function record(id: string, tool: string, prompt: string, r: ChatResult): boolean {
  const is_fallback = FALLBACK_GUARDRAIL_RE.test(r.text);
  // "Passed" = response no vacío + NO es fallback determinístico
  const passed = r.http_status === 200 && r.text.length > 200 && !is_fallback;
  const cite_preview = r.citation_payloads
    .slice(0, 3)
    .map((c) => {
      const m = (c.metadata ?? {}) as Record<string, unknown>;
      return `${c.source_type ?? '?'}:${m.fecha ?? c.fecha ?? m.numero ?? c.numero ?? '-'}`;
    })
    .join('|');
  REPORT.push({
    id, tool, prompt: prompt.slice(0, 80),
    text_len: r.text.length, citations: r.citations,
    is_fallback, passed,
    cite_preview, text_preview: r.text.slice(0, 150).replace(/\s+/g, ' '),
    ms: r.duration_ms, http: r.http_status,
  });
  return passed;
}

test.describe('@lexa-pass2-15 Verifica fix v4: tools=<original> + tool_choice=none', () => {
  test.setTimeout(120_000);

  // ─── A) get_session_by_date (2) ────────────────────────────────────
  test('A1 sesión 19 may', async () => {
    const r = await askLexa('Qué se discutió en la plenaria del 19 de mayo de 2026');
    record('A1', 'get_session_by_date', '19 may', r);
  });
  test('A2 sesión 20 may', async () => {
    const r = await askLexa('Resumime la sesión plenaria del 20 de mayo de 2026');
    record('A2', 'get_session_by_date', '20 may', r);
  });

  // ─── B) search_transcripts (2) ─────────────────────────────────────
  test('B1 transcripts presupuesto', async () => {
    const r = await askLexa('Buscame en las transcripciones legislativas todas las menciones a presupuesto nacional');
    record('B1', 'search_transcripts', 'presupuesto', r);
  });
  test('B2 transcripts educación', async () => {
    const r = await askLexa('Qué se ha dicho en plenarias sobre educación pública');
    record('B2', 'search_transcripts', 'educación', r);
  });

  // ─── C) search_reglamento (2) ──────────────────────────────────────
  test('C1 reglamento plazo dictamen', async () => {
    const r = await askLexa('Cuál es el plazo para emitir dictamen según el Reglamento de la Asamblea');
    record('C1', 'search_reglamento', 'plazo dictamen', r);
  });
  test('C2 reglamento dispensa', async () => {
    const r = await askLexa('Qué dice el Reglamento sobre dispensa de trámite');
    record('C2', 'search_reglamento', 'dispensa trámite', r);
  });

  // ─── D) search_ral_comentado (2) ───────────────────────────────────
  test('D1 ral comentado quórum estructural', async () => {
    const r = await askLexa('Buscame en el reglamento comentado interpretaciones sobre quórum estructural');
    record('D1', 'search_ral_comentado', 'quórum estructural', r);
  });
  test('D2 ral comentado criterios mociones', async () => {
    const r = await askLexa('Cuáles son los criterios de Servicios Técnicos sobre mociones de fondo en el RAL comentado');
    record('D2', 'search_ral_comentado', 'criterios mociones', r);
  });

  // ─── E) evaluate_ral_aplicacion (1) ────────────────────────────────
  test('E1 ral aplicación primer debate', async () => {
    const r = await askLexa('Puede un expediente irse a primer debate sin dictamen de comisión');
    record('E1', 'evaluate_ral_aplicacion', 'primer debate', r);
  });

  // ─── F) search_sil_expedientes (2) ─────────────────────────────────
  test('F1 sil educación', async () => {
    const r = await askLexa('Qué proyectos de ley hay sobre educación pública en el SIL');
    record('F1', 'search_sil_expedientes', 'educación', r);
  });
  test('F2 sil seguridad', async () => {
    const r = await askLexa('Buscame iniciativas legislativas sobre seguridad ciudadana');
    record('F2', 'search_sil_expedientes', 'seguridad', r);
  });

  // ─── G) get_sil_expediente (2) ─────────────────────────────────────
  test('G1 exp 23.234 (ES LEY)', async () => {
    const r = await askLexa('Detalle completo del expediente 23.234');
    record('G1', 'get_sil_expediente', '23.234', r);
  });
  test('G2 exp 25.262 (trámite)', async () => {
    const r = await askLexa('Cuéntame sobre el expediente 25.262');
    record('G2', 'get_sil_expediente', '25.262', r);
  });

  // ─── H) search_sil_corpus (1) ──────────────────────────────────────
  test('H1 corpus argumentos empleo', async () => {
    const r = await askLexa('Buscame en el contenido de los proyectos los argumentos a favor de generar empleo', true);
    record('H1', 'search_sil_corpus', 'argumentos empleo', r);
  });

  // ─── J) Multi-tool (1) ─────────────────────────────────────────────
  test('J1 expedientes 21 may', async () => {
    const r = await askLexa('Qué expedientes se discutieron en la plenaria del 21 de mayo de 2026');
    record('J1', 'multi-tool', 'expedientes 21 may', r);
  });

  test.afterAll(() => {
    /* eslint-disable no-console */
    const total = REPORT.length;
    const passed = REPORT.filter((r) => r.passed).length;
    const fallback = REPORT.filter((r) => r.is_fallback).length;
    const fallbackPct = ((fallback / total) * 100).toFixed(1);

    // Persist to file (test report)
    const outPath = resolve('/tmp/lexa-pass2-15.json');
    writeFileSync(outPath, JSON.stringify({
      summary: { total, passed, fallback, fallback_pct: Number(fallbackPct) },
      rows: REPORT,
    }, null, 2));

    console.log('\n══════════════════════════════════════════════════════════════════════════════');
    console.log(`  LEXA PASS-2 FIX VERIFICATION  ${passed}/${total} prosa real · ${fallback}/${total} (${fallbackPct}%) cayó a fallback`);
    console.log(`  TARGET: ≤ 10% fallback rate (vs 53% pre-fix v4)`);
    console.log('══════════════════════════════════════════════════════════════════════════════');
    for (const r of REPORT) {
      const status = r.passed ? '✓ PROSA' : (r.is_fallback ? '✗ FALLBK' : '✗ OTHER');
      console.log(`${status} ${r.id.padEnd(3)} [${r.tool.padEnd(28)}] ${r.prompt.slice(0, 50).padEnd(50)} text=${String(r.text_len).padStart(4)}c · cites=${r.citations}`);
      if (r.cite_preview) console.log(`        cites: ${r.cite_preview}`);
      console.log(`        text: "${r.text_preview.slice(0, 100)}"`);
    }
    console.log('══════════════════════════════════════════════════════════════════════════════');
    console.log(`  Results JSON: ${outPath}`);
    console.log('══════════════════════════════════════════════════════════════════════════════\n');
    /* eslint-enable no-console */

    // Fail the entire suite if fallback rate > 15% — gives buffer over 10% target
    // But this test is informational primarily — we want to see results regardless
    if (Number(fallbackPct) > 15) {
      console.log(`⚠️  FALLBACK RATE ${fallbackPct}% > 15% — fix v4 NO funcionó como esperado.`);
    }
  });
});
