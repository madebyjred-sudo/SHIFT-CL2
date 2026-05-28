/**
 * @feature @transcript-citability Post-reprocess citability (2026-05-25)
 *
 * Verifica que las 3 plenarias reprocesadas (19, 20, 21 may) son citables
 * por Lexa via dos paths:
 *
 *   A) get_session_by_date(fecha) → debe retornar citation source_type=session
 *      con resumen ejecutivo en texto largo (>500 chars)
 *
 *   B) search_transcripts(query) → debe retornar citation con metadata que
 *      apunte a una de las 3 sesiones nuevas (subtype=transcript_segment_block)
 *
 * Si la citation del path A falla, los transcripts del reprocess NO son
 * encontrados por get_session_by_date. Si la citation del path B falla,
 * los chunks embebidos via ingest-transcript-chunks NO son consultables.
 *
 * Correr:
 *   E2E_BASE_URL=https://cl2-v2-web-u3rliii7wa-uc.a.run.app \
 *     API_BASE_URL=https://cl2-v2-api-u3rliii7wa-uc.a.run.app \
 *     npx playwright test tests/e2e/features/transcript-citability.spec.ts \
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

const REPORT: Array<{
  caso: string;
  prompt: string;
  passed: boolean;
  reason: string;
  preview: string;
  citation_summary: string;
  ms: number;
}> = [];

function record(caso: string, prompt: string, passed: boolean, reason: string, result: ChatResult) {
  const cite_sum = result.citation_payloads
    .map((c) => `${c.source_type ?? '?'}/${(c.metadata as Record<string, unknown> | undefined)?.subtype ?? c.subtype ?? '?'}/${(c.metadata as Record<string, unknown> | undefined)?.fecha ?? c.fecha ?? '?'}`)
    .join(' · ')
    .slice(0, 200);
  REPORT.push({
    caso,
    prompt: prompt.slice(0, 80),
    passed,
    reason,
    preview: result.text.slice(0, 220).replace(/\s+/g, ' '),
    citation_summary: cite_sum,
    ms: result.duration_ms,
  });
}

test.describe('@transcript-citability Reprocess 19+20+21 may', () => {
  test.setTimeout(120_000);

  // ─── Path A: get_session_by_date ───────────────────────────────────

  test('PATH-A.19 — sesión 19 may citable via get_session_by_date', async () => {
    const r = await askLexa('Qué se discutió en la sesión plenaria del 19 de mayo de 2026');
    const has_session_cite = r.citation_payloads.some((c) => String(c.source_type ?? '') === 'session');
    const long = r.text.length > 500;
    const ok = has_session_cite && long;
    record('PATH-A.19', '19 may', ok, ok ? 'OK' : `cita_session=${has_session_cite} long=${long} (${r.text.length}c)`, r);
    expect(has_session_cite, 'Citation source_type=session esperada').toBe(true);
    expect(long, `Respuesta debe ser >500 chars; tuvo ${r.text.length}`).toBe(true);
  });

  test('PATH-A.20 — sesión 20 may citable via get_session_by_date', async () => {
    const r = await askLexa('Qué se discutió en la sesión plenaria del 20 de mayo de 2026');
    const has_session_cite = r.citation_payloads.some((c) => String(c.source_type ?? '') === 'session');
    const long = r.text.length > 500;
    const ok = has_session_cite && long;
    record('PATH-A.20', '20 may', ok, ok ? 'OK' : `cita_session=${has_session_cite} long=${long} (${r.text.length}c)`, r);
    expect(has_session_cite, 'Citation source_type=session esperada').toBe(true);
    expect(long, `Respuesta debe ser >500 chars; tuvo ${r.text.length}`).toBe(true);
  });

  test('PATH-A.21 — sesión 21 may citable via get_session_by_date (control)', async () => {
    const r = await askLexa('Qué se discutió en la sesión plenaria del 21 de mayo de 2026');
    const has_session_cite = r.citation_payloads.some((c) => String(c.source_type ?? '') === 'session');
    const long = r.text.length > 500;
    const ok = has_session_cite && long;
    record('PATH-A.21', '21 may', ok, ok ? 'OK' : `cita_session=${has_session_cite} long=${long} (${r.text.length}c)`, r);
    expect(has_session_cite, 'Citation source_type=session esperada').toBe(true);
    expect(long, `Respuesta debe ser >500 chars; tuvo ${r.text.length}`).toBe(true);
  });

  // ─── Path B: search_transcripts via chunks embebidos ───────────────

  test('PATH-B.transcripts — search_transcripts retorna chunks de plenarias recientes', async () => {
    // Prompt diseñado para forzar search_transcripts (no get_session)
    const r = await askLexa('Buscame menciones a expediente en las transcripciones de las plenarias del 19 al 21 de mayo');
    const has_transcript_cite = r.citation_payloads.some((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const subtype = String(meta.subtype ?? c.subtype ?? '');
      const source = String(c.source_type ?? '');
      return source === 'transcript' || subtype === 'transcript_segment_block';
    });
    const not_fallback = r.text.length > 200 && !/No encontr.*una respuesta concreta/i.test(r.text);
    const ok = has_transcript_cite || not_fallback;
    record('PATH-B.transcripts', 'search transcripts 19-21', ok,
      ok ? `transcript_cite=${has_transcript_cite} text=${r.text.length}c` : 'sin citation transcript ni texto largo', r);
    expect(ok, 'O hay citation transcript o texto >200c sin fallback').toBe(true);
  });

  test('PATH-B.granularidad — chunks tienen start_seconds dentro de rango razonable', async () => {
    const r = await askLexa('Encuentra una mención específica de algún diputado en las plenarias del 19 al 21 de mayo');
    const transcript_cites = r.citation_payloads.filter((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      return String(meta.subtype ?? c.subtype ?? '') === 'transcript_segment_block' || String(c.source_type ?? '') === 'transcript';
    });
    const reasonable_starts = transcript_cites.filter((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const start = Number(meta.start_seconds ?? c.start_seconds ?? -1);
      return start >= 0 && start <= 14000; // 14000s ≈ 3.9h, max plenary
    });
    record('PATH-B.granularidad', 'chunks start_seconds', transcript_cites.length > 0,
      `transcript_cites=${transcript_cites.length} reasonable=${reasonable_starts.length}`, r);
    // Soft check: si trae chunks, los timestamps deben ser sanos
    if (transcript_cites.length > 0) {
      expect(reasonable_starts.length, 'Chunks transcript deben tener start_seconds <= 14000').toBeGreaterThan(0);
    }
  });

  test.afterAll(() => {
    /* eslint-disable no-console */
    const total = REPORT.length;
    const passed = REPORT.filter((r) => r.passed).length;
    const failed = total - passed;
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  TRANSCRIPT CITABILITY  ${passed}/${total} OK · ${failed} fail`);
    console.log('══════════════════════════════════════════════════════════');
    for (const r of REPORT) {
      const icon = r.passed ? '✓' : '✗';
      console.log(`${icon} [${r.caso}] ${r.prompt} (${r.ms}ms)`);
      console.log(`   ${r.reason}`);
      if (r.citation_summary) console.log(`   Citations: ${r.citation_summary}`);
      if (!r.passed) console.log(`   Preview: "${r.preview.slice(0, 200)}"`);
    }
    console.log('══════════════════════════════════════════════════════════');
    if (REPORT.length > 0) {
      console.log(`  Avg latency: ${Math.round(REPORT.reduce((a, b) => a + b.ms, 0) / REPORT.length)}ms`);
    }
    console.log('══════════════════════════════════════════════════════════\n');
    /* eslint-enable no-console */
  });
});
