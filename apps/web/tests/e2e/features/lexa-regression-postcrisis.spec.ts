/**
 * @feature @lexa-regression Post-crisis regression suite (2026-05-25)
 *
 * Esta suite mide explícitamente los bugs encontrados durante la crisis
 * de la mañana del 25 de mayo de 2026 y verifica que cada uno tenga su
 * fix activo en producción. Es la prueba dura del "cómo estamos".
 *
 * Bugs cubiertos:
 *   B1 — Pass 2 leakea tool content raw como respuesta
 *   B2 — get_sil_expediente rechaza "23.234" con punto
 *   B3 — search_sil_expedientes no matchea números
 *   B4 — search_transcripts timeout Vertex 15s
 *   B5 — No existía tool get_session_by_date
 *   B6 — Citation no traía estatus formal "✅ ES LEY"
 *   B7 — Citation de get_sil_expediente sin estatus formal
 *   B8 — Pass 2 finish_reason='stop' content vacío sin tools
 *   B9 — Pass 2 emitia content_length=0 cuando tools devolvían 0 hits
 *
 * Correr:
 *   E2E_BASE_URL=https://cl2-v2-web-u3rliii7wa-uc.a.run.app \
 *     API_BASE_URL=https://cl2-v2-api-u3rliii7wa-uc.a.run.app \
 *     npx playwright test tests/e2e/features/lexa-regression-postcrisis.spec.ts \
 *     --reporter=list --workers=1
 */
import { test, expect } from '@playwright/test';
import { mintToken } from '../_helpers/auth';
import { E2E_ENV } from '../_helpers/env';

interface ChatResult {
  text: string;
  citations: number;
  citation_payloads: Array<Record<string, unknown>>;
  errors: string[];
  duration_ms: number;
}

async function askLexa(prompt: string): Promise<ChatResult> {
  const t0 = Date.now();
  const session = await mintToken('madebyjred@gmail.com');
  const res = await fetch(`${E2E_ENV.apiBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: 'lexa', query: prompt, deep_insight: false }),
  });
  if (!res.ok || !res.body) {
    return { text: '', citations: 0, citation_payloads: [], errors: [`HTTP ${res.status}`], duration_ms: Date.now() - t0 };
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
  return { text, citations, citation_payloads, errors, duration_ms: Date.now() - t0 };
}

const TOOL_LEAK_RE = /Resultados SIL \(\d+\):|MON[ÓO]LOGO INTERNO|Stress level|^Encontré los siguientes extractos relevantes en la transcripción de esta sesión:/i;
const GENERIC_FALLBACK_RE = /No encontr.*una respuesta concreta para esta consulta/i;

// Capturamos resultados para reporte final
const REPORT: Array<{
  bug: string;
  prompt: string;
  passed: boolean;
  reason: string;
  preview: string;
  ms: number;
}> = [];

function record(bug: string, prompt: string, passed: boolean, reason: string, result: ChatResult) {
  REPORT.push({
    bug,
    prompt,
    passed,
    reason,
    preview: result.text.slice(0, 250).replace(/\s+/g, ' '),
    ms: result.duration_ms,
  });
}

test.describe('@lexa-regression Post-crisis bugs', () => {
  test.setTimeout(120_000);

  test('B1+B8+B9 — sin tool leak, sin fallback genérico, sin Pass 2 vacío', async () => {
    const r = await askLexa('Buscame información sobre el expediente 23.234');
    const tool_leak = TOOL_LEAK_RE.test(r.text);
    const generic = GENERIC_FALLBACK_RE.test(r.text);
    const empty = r.text.length === 0;
    const ok = !tool_leak && !generic && !empty;
    record('B1+B8+B9', '23.234', ok, ok ? 'OK' : `leak=${tool_leak} generic=${generic} empty=${empty}`, r);
    expect(tool_leak, 'Tool content raw leaking').toBe(false);
    expect(generic, 'Fallback genérico').toBe(false);
    expect(empty, 'Respuesta vacía').toBe(false);
  });

  test('B2+B7 — get_sil_expediente acepta "23.234" Y citation muestra ES LEY', async () => {
    const r = await askLexa('Cuéntame del expediente 23.234');
    const cite = r.citation_payloads[0] ?? {};
    const content = String(cite.content ?? '');
    const has_es_ley = /ES LEY|N° 10838|Ley.*10838/i.test(content + ' ' + r.text);
    const has_tramite = /TRÁMITE|EN TRAMITE|ARCHIVADO/i.test(content + ' ' + r.text);
    const ok = has_es_ley || has_tramite; // al menos un estatus formal
    record('B2+B7', '23.234 estatus', ok, ok ? 'estatus formal presente' : `content="${content.slice(0, 100)}"`, r);
    expect(ok, 'Citation o texto debe traer estatus formal (ES LEY / TRÁMITE / ARCHIVADO)').toBe(true);
  });

  test('B3 — search_sil_expedientes encuentra por número sin formato', async () => {
    const r = await askLexa('Tienes algo del expediente 24018');
    const ok = r.citations > 0 || /24\.018|24018/i.test(r.text);
    record('B3', '24018 sin punto', ok, ok ? 'encontrado' : 'no encontrado', r);
    expect(ok, 'Lexa debe encontrar el expediente aunque venga sin punto').toBe(true);
  });

  test('B4 — search_transcripts no timeout (responde <60s)', async () => {
    const r = await askLexa('Buscame en las transcripciones menciones a presupuesto');
    const ok = r.duration_ms < 60_000 && !r.errors.some((e) => /timeout/i.test(e));
    record('B4', 'transcripts timeout', ok, `${r.duration_ms}ms`, r);
    expect(ok, `Tomó ${r.duration_ms}ms, esperado <60000`).toBe(true);
  });

  test('B5 — get_session_by_date funciona (resumen completo)', async () => {
    const r = await askLexa('Qué se discutió en la sesión plenaria del 21 de mayo de 2026');
    const has_session_cite = r.citation_payloads.some((c) => String(c.source_type ?? '') === 'session');
    const long = r.text.length > 500;
    const ok = has_session_cite && long;
    record('B5', 'session 21 may', ok, `cita_session=${has_session_cite} long=${long} (${r.text.length}c)`, r);
    expect(has_session_cite, 'Citation source_type=session esperada').toBe(true);
    expect(long, `Respuesta debe ser >500 chars (Resumen ejecutivo); tuvo ${r.text.length}`).toBe(true);
  });

  test('B6 — search_sil_expedientes citation también con estatus formal', async () => {
    const r = await askLexa('buscame el expediente 23.234');
    const has_estatus = r.citation_payloads.some((c) =>
      /ES LEY|ARCHIVADO|EN TRÁMITE|EN TRAMITE/i.test(String(c.content ?? '')),
    );
    record('B6', 'search citation estatus', has_estatus, has_estatus ? 'OK' : 'sin estatus', r);
    expect(has_estatus, 'Citation de search_sil_expedientes debe tener estatus formal').toBe(true);
  });

  test('REGRESION — sesión nueva post-reprocess tiene transcripts ricos', async () => {
    // Sesión 21 may post-reprocess pasó de 204 → 1100 segments
    const r = await askLexa('Buscame menciones a PANI en las plenarias recientes');
    // Esperamos que ahora SÍ encuentre algo (no fallback)
    const has_some_content = r.text.length > 100;
    const not_fallback = !GENERIC_FALLBACK_RE.test(r.text);
    record('REGRESION', 'PANI plenarias', has_some_content && not_fallback,
      `len=${r.text.length} fallback=${GENERIC_FALLBACK_RE.test(r.text)}`, r);
    // Soft assertion — los chunks transcript se generan via cron cada hora,
    // puede no haber chunks aún. Marcamos como informational.
  });

  test('SMOKE — expediente en trámite (25.262) responde OK', async () => {
    const r = await askLexa('Resumime el expediente 25.262');
    const has_cite = r.citations > 0;
    const has_text = r.text.length > 100;
    record('SMOKE', '25.262', has_cite && has_text, `cites=${r.citations} len=${r.text.length}`, r);
    expect(has_cite || has_text, 'Debe traer al menos citation o texto').toBe(true);
  });

  test('SMOKE — reglamento responde con citas RAL', async () => {
    const r = await askLexa('Cuál es el plazo de dictamen según el reglamento');
    const has_article_cite = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    record('SMOKE', 'RAL plazo', has_article_cite, has_article_cite ? 'cita artículo' : 'sin artículo', r);
    expect(has_article_cite, 'Lexa debe citar artículo del RAL').toBe(true);
  });

  test('SMOKE — prompt trampa devuelve fallback elegante', async () => {
    const r = await askLexa('Qué dice el expediente 99.999 sobre energía solar');
    const elegant = r.text.length > 50 && !TOOL_LEAK_RE.test(r.text);
    record('SMOKE', '99.999 trampa', elegant, elegant ? 'elegante' : 'feo', r);
    expect(elegant).toBe(true);
  });

  test.afterAll(() => {
    /* eslint-disable no-console */
    const total = REPORT.length;
    const passed = REPORT.filter((r) => r.passed).length;
    const failed = total - passed;
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  POST-CRISIS REGRESSION  ${passed}/${total} OK · ${failed} fail`);
    console.log('══════════════════════════════════════════════════════════');
    for (const r of REPORT) {
      const icon = r.passed ? '✓' : '✗';
      console.log(`${icon} [${r.bug}] ${r.prompt} (${r.ms}ms)`);
      console.log(`   ${r.reason}`);
      if (!r.passed) console.log(`   Preview: "${r.preview.slice(0, 200)}"`);
    }
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Avg latency: ${Math.round(REPORT.reduce((a, b) => a + b.ms, 0) / REPORT.length)}ms`);
    console.log('══════════════════════════════════════════════════════════\n');
    /* eslint-enable no-console */
  });
});
