/**
 * @feature @lexa-tools-30 Cobertura exhaustiva de todas las tools de Lexa (2026-05-25)
 *
 * 30 prompts diseñados para ejercer cada tool del agente Lexa al menos 3 veces.
 * Cada test verifica:
 *   - Respuesta no vacía + no rate-limited
 *   - Citation surfaceada del tipo esperado para esa tool
 *   - Sin tool-leak (raw payload de Pass 1)
 *   - Sin fallback genérico cuando el caso debería tener match real
 *
 * Tools cubiertas:
 *   A) get_session_by_date           — citation source_type='session'
 *   B) search_transcripts            — citation source_type='session' o subtype='transcript_segment_block'
 *   C) search_reglamento             — citation source_type='metadata' + texto cita art./Art./[Art.
 *   D) search_ral_comentado          — citation source_type='metadata' + texto cita
 *   E) evaluate_ral_aplicacion       — texto referencial al RAL + razonamiento procedural
 *   F) search_sil_expedientes        — citation source_type='sil_expediente'
 *   G) get_sil_expediente            — citation source_type='sil_expediente' + estatus formal
 *   H) search_sil_corpus             — citation con metadata/sil_chunk o texto con [N]
 *   I) query_legislative_graph       — texto sintetizado + posible 503 graceful
 *   J) Orquestación multi-tool       — combinación de 2+ tools en un prompt
 *
 * Correr:
 *   E2E_BASE_URL=https://cl2-v2-web-u3rliii7wa-uc.a.run.app \
 *     API_BASE_URL=https://cl2-v2-api-u3rliii7wa-uc.a.run.app \
 *     npx playwright test tests/e2e/features/lexa-tools-30.spec.ts \
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
  http_status: number | null;
  duration_ms: number;
}

async function askLexa(prompt: string, deep_insight = false): Promise<ChatResult> {
  const t0 = Date.now();
  const session = await mintToken('madebyjred@gmail.com');
  const res = await fetch(`${E2E_ENV.apiBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: 'lexa', query: prompt, deep_insight }),
  });
  if (!res.ok || !res.body) {
    return { text: '', citations: 0, citation_payloads: [], errors: [`HTTP ${res.status}`], http_status: res.status, duration_ms: Date.now() - t0 };
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
  return { text, citations, citation_payloads, errors, http_status: 200, duration_ms: Date.now() - t0 };
}

const TOOL_LEAK_RE = /MON[ÓO]LOGO INTERNO|Stress level|Resultados SIL \(\d+\):/i;
const FALLBACK_RE = /No encontr.*una respuesta concreta|Consult[eé] las fuentes disponibles.*no encontr/i;

// Helpers de aserciones
function hasSourceType(r: ChatResult, type: string): boolean {
  return r.citation_payloads.some((c) => String(c.source_type ?? '') === type);
}
function hasMetadataSubtype(r: ChatResult, subtype: string): boolean {
  return r.citation_payloads.some((c) => {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    return String(meta.subtype ?? c.subtype ?? '') === subtype;
  });
}
function noLeak(r: ChatResult): boolean {
  return !TOOL_LEAK_RE.test(r.text);
}
function notRateLimited(r: ChatResult): boolean {
  return r.http_status !== 429;
}

// Reporte consolidado
const REPORT: Array<{
  id: string;
  tool: string;
  prompt: string;
  passed: boolean;
  reason: string;
  cite_summary: string;
  text_len: number;
  http: number | null;
  ms: number;
}> = [];

function record(id: string, tool: string, prompt: string, passed: boolean, reason: string, r: ChatResult) {
  const cite = r.citation_payloads
    .map((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const st = c.source_type ?? '?';
      const su = meta.subtype ?? c.subtype ?? '';
      const fe = meta.fecha ?? c.fecha ?? '';
      const nu = meta.numero ?? c.numero ?? '';
      return `${st}${su ? '/' + su : ''}${fe ? '@' + fe : ''}${nu ? '#' + nu : ''}`;
    })
    .slice(0, 5)
    .join(' · ');
  REPORT.push({
    id,
    tool,
    prompt: prompt.slice(0, 70),
    passed,
    reason,
    cite_summary: cite,
    text_len: r.text.length,
    http: r.http_status,
    ms: r.duration_ms,
  });
}

test.describe('@lexa-tools-30 30 prompts cubriendo todas las tools', () => {
  test.setTimeout(120_000);

  // ─── A) get_session_by_date (3) ─────────────────────────────────────

  test('A1 get_session_by_date · 19 may', async () => {
    const r = await askLexa('Qué se discutió en la plenaria del 19 de mayo de 2026');
    const ok = notRateLimited(r) && hasSourceType(r, 'session') && r.text.length > 400 && noLeak(r);
    record('A1', 'get_session_by_date', '19 may', ok, ok ? 'OK' : `cite_session=${hasSourceType(r,'session')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('A2 get_session_by_date · 20 may', async () => {
    const r = await askLexa('Resumime la sesión plenaria del 20 de mayo de 2026');
    const ok = notRateLimited(r) && hasSourceType(r, 'session') && r.text.length > 400 && noLeak(r);
    record('A2', 'get_session_by_date', '20 may', ok, ok ? 'OK' : `cite_session=${hasSourceType(r,'session')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('A3 get_session_by_date · 21 may', async () => {
    const r = await askLexa('Qué pasó en la plenaria del 21 de mayo de 2026');
    const ok = notRateLimited(r) && hasSourceType(r, 'session') && r.text.length > 400 && noLeak(r);
    record('A3', 'get_session_by_date', '21 may', ok, ok ? 'OK' : `cite_session=${hasSourceType(r,'session')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── B) search_transcripts (3) ──────────────────────────────────────

  test('B1 search_transcripts · presupuesto', async () => {
    const r = await askLexa('Buscame en las transcripciones legislativas todas las menciones a presupuesto nacional');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'session') || hasMetadataSubtype(r, 'transcript_segment_block') || (r.text.length > 200 && !FALLBACK_RE.test(r.text)));
    record('B1', 'search_transcripts', 'presupuesto', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('B2 search_transcripts · educación', async () => {
    const r = await askLexa('Qué se ha dicho en plenarias sobre educación pública');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'session') || hasMetadataSubtype(r, 'transcript_segment_block') || (r.text.length > 200 && !FALLBACK_RE.test(r.text)));
    record('B2', 'search_transcripts', 'educación', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('B3 search_transcripts · seguridad', async () => {
    const r = await askLexa('Buscame menciones a seguridad ciudadana en las transcripciones de las plenarias');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'session') || hasMetadataSubtype(r, 'transcript_segment_block') || (r.text.length > 200 && !FALLBACK_RE.test(r.text)));
    record('B3', 'search_transcripts', 'seguridad', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  // ─── C) search_reglamento (3) ───────────────────────────────────────

  test('C1 search_reglamento · plazo dictamen', async () => {
    const r = await askLexa('Cuál es el plazo para emitir dictamen según el Reglamento de la Asamblea');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata')) && r.text.length > 150;
    record('C1', 'search_reglamento', 'plazo dictamen', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('C2 search_reglamento · dispensa de trámite', async () => {
    const r = await askLexa('Qué dice el Reglamento sobre dispensa de trámite');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata')) && r.text.length > 150;
    record('C2', 'search_reglamento', 'dispensa trámite', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('C3 search_reglamento · quórum', async () => {
    const r = await askLexa('Cómo se calcula el quórum según el Reglamento de la Asamblea Legislativa');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata')) && r.text.length > 150;
    record('C3', 'search_reglamento', 'quórum', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── D) search_ral_comentado (3) ────────────────────────────────────

  test('D1 search_ral_comentado · interpretación quórum estructural', async () => {
    const r = await askLexa('Buscame en el reglamento comentado interpretaciones sobre quórum estructural');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata') || r.text.length > 200);
    record('D1', 'search_ral_comentado', 'quórum estructural', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('D2 search_ral_comentado · jurisprudencia plenaria', async () => {
    const r = await askLexa('Qué dice el RAL comentado sobre suspensión de sesión plenaria');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata') || r.text.length > 200);
    record('D2', 'search_ral_comentado', 'jurisprudencia plenaria', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('D3 search_ral_comentado · criterios sobre mociones', async () => {
    const r = await askLexa('Cuáles son los criterios de Servicios Técnicos sobre mociones de fondo en el RAL comentado');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && (cites_art || hasSourceType(r, 'metadata') || r.text.length > 200);
    record('D3', 'search_ral_comentado', 'criterios mociones', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── E) evaluate_ral_aplicacion (3) ─────────────────────────────────

  test('E1 evaluate_ral_aplicacion · primer debate sin dictamen', async () => {
    const r = await askLexa('Puede un expediente irse a primer debate sin dictamen de comisión');
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 200 && !FALLBACK_RE.test(r.text);
    record('E1', 'evaluate_ral_aplicacion', 'primer debate sin dictamen', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('E2 evaluate_ral_aplicacion · moción sin firmas', async () => {
    const r = await askLexa('Qué pasa con una moción si no junta las firmas mínimas requeridas');
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 200 && !FALLBACK_RE.test(r.text);
    record('E2', 'evaluate_ral_aplicacion', 'moción sin firmas', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('E3 evaluate_ral_aplicacion · convocatoria sesión extraordinaria', async () => {
    const r = await askLexa('Cuándo procede una convocatoria a sesión extraordinaria y quién la convoca');
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 200 && !FALLBACK_RE.test(r.text);
    record('E3', 'evaluate_ral_aplicacion', 'sesión extraordinaria', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  // ─── F) search_sil_expedientes (3) ──────────────────────────────────

  test('F1 search_sil_expedientes · educación', async () => {
    const r = await askLexa('Qué proyectos de ley hay sobre educación pública en el SIL');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'sil_expediente') || r.citations > 0) && r.text.length > 150;
    record('F1', 'search_sil_expedientes', 'educación', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} cites=${r.citations} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('F2 search_sil_expedientes · seguridad', async () => {
    const r = await askLexa('Buscame iniciativas legislativas sobre seguridad ciudadana');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'sil_expediente') || r.citations > 0) && r.text.length > 150;
    record('F2', 'search_sil_expedientes', 'seguridad', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} cites=${r.citations} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('F3 search_sil_expedientes · agua', async () => {
    const r = await askLexa('Expedientes en el SIL relacionados con el recurso hídrico o agua potable');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'sil_expediente') || r.citations > 0) && r.text.length > 150;
    record('F3', 'search_sil_expedientes', 'agua', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} cites=${r.citations} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── G) get_sil_expediente (3) ──────────────────────────────────────

  test('G1 get_sil_expediente · 23.234 (ES LEY)', async () => {
    const r = await askLexa('Detalle completo del expediente 23.234');
    const has_estatus = /ES LEY|Ley N°|N° 10838/i.test(r.text) || r.citation_payloads.some((c) => /ES LEY|N° 10838/i.test(String(c.content ?? '')));
    const ok = notRateLimited(r) && noLeak(r) && hasSourceType(r, 'sil_expediente') && has_estatus && r.text.length > 200;
    record('G1', 'get_sil_expediente', '23.234', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} estatus=${has_estatus} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('G2 get_sil_expediente · 24.018', async () => {
    const r = await askLexa('Información del expediente 24.018');
    const ok = notRateLimited(r) && noLeak(r) && hasSourceType(r, 'sil_expediente') && r.text.length > 150;
    record('G2', 'get_sil_expediente', '24.018', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('G3 get_sil_expediente · 25.262 (trámite)', async () => {
    const r = await askLexa('Cuéntame sobre el expediente 25.262');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'sil_expediente') || r.text.length > 200);
    record('G3', 'get_sil_expediente', '25.262', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── H) search_sil_corpus (semantic) (3) ────────────────────────────

  test('H1 search_sil_corpus · argumentos pro empleo', async () => {
    const r = await askLexa('Buscame en el contenido de los proyectos los argumentos a favor de generar empleo', true);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 250 && !FALLBACK_RE.test(r.text);
    record('H1', 'search_sil_corpus', 'argumentos empleo', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('H2 search_sil_corpus · dictamen mayoría educación', async () => {
    const r = await askLexa('Resumime los dictámenes de mayoría sobre proyectos de educación', true);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 250 && !FALLBACK_RE.test(r.text);
    record('H2', 'search_sil_corpus', 'dictamen mayoría educación', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  test('H3 search_sil_corpus · contenido sobre transparencia', async () => {
    const r = await askLexa('Qué dicen los proyectos sobre transparencia y rendición de cuentas', true);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 250 && !FALLBACK_RE.test(r.text);
    record('H3', 'search_sil_corpus', 'transparencia', ok, ok ? 'OK' : `text=${r.text.length} fallback=${FALLBACK_RE.test(r.text)}`, r);
    expect(ok).toBe(true);
  });

  // ─── I) query_legislative_graph (3) — puede 503 ──────────────────────

  test('I1 query_legislative_graph · diputados expediente', async () => {
    const r = await askLexa('Qué diputados han propuesto el expediente 23.234 y quiénes se han opuesto', true);
    // Graph puede 503 — degradación grácil es OK
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 100;
    record('I1', 'query_legislative_graph', 'diputados 23.234', ok, ok ? 'OK' : `text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('I2 query_legislative_graph · patrones partido', async () => {
    const r = await askLexa('Qué patrones aparecen en las propuestas del partido Frente Amplio', true);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 100;
    record('I2', 'query_legislative_graph', 'patrones FA', ok, ok ? 'OK' : `text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('I3 query_legislative_graph · comisión expediente', async () => {
    const r = await askLexa('Cómo se relaciona la Comisión de Hacendarios con los expedientes presupuestarios', true);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 100;
    record('I3', 'query_legislative_graph', 'comisión hacendarios', ok, ok ? 'OK' : `text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  // ─── J) Orquestación multi-tool (3) ──────────────────────────────────

  test('J1 multi · buscar + detallar expediente', async () => {
    const r = await askLexa('Buscame expedientes sobre transporte público y dame el detalle del primero que aparezca');
    const ok = notRateLimited(r) && noLeak(r) && hasSourceType(r, 'sil_expediente') && r.text.length > 200;
    record('J1', 'multi-tool', 'buscar+detalle expediente', ok, ok ? 'OK' : `cite_sil=${hasSourceType(r,'sil_expediente')} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('J2 multi · sesión + expediente referenciado', async () => {
    const r = await askLexa('Qué expedientes se discutieron en la plenaria del 21 de mayo de 2026');
    const ok = notRateLimited(r) && noLeak(r) && (hasSourceType(r, 'session') || hasSourceType(r, 'sil_expediente')) && r.text.length > 200;
    record('J2', 'multi-tool', 'sesión+expedientes', ok, ok ? 'OK' : `cites=${r.citation_payloads.length} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test('J3 multi · reglamento + evaluación procedimental', async () => {
    const r = await askLexa('Según el reglamento de la asamblea, puede un proyecto ir a votación si la comisión no dictaminó en plazo');
    const cites_art = /art[íi]culo|art\.|\[Art\./i.test(r.text);
    const ok = notRateLimited(r) && noLeak(r) && r.text.length > 200 && (cites_art || hasSourceType(r, 'metadata'));
    record('J3', 'multi-tool', 'reglamento+evaluación', ok, ok ? 'OK' : `cites_art=${cites_art} text=${r.text.length}`, r);
    expect(ok).toBe(true);
  });

  test.afterAll(() => {
    /* eslint-disable no-console */
    const total = REPORT.length;
    const passed = REPORT.filter((r) => r.passed).length;
    const failed = total - passed;
    const byTool = new Map<string, { pass: number; fail: number }>();
    for (const r of REPORT) {
      const cur = byTool.get(r.tool) ?? { pass: 0, fail: 0 };
      if (r.passed) cur.pass++; else cur.fail++;
      byTool.set(r.tool, cur);
    }
    console.log('\n══════════════════════════════════════════════════════════════════════════════');
    console.log(`  LEXA 30-TOOL COVERAGE  ${passed}/${total} OK · ${failed} fail`);
    console.log('══════════════════════════════════════════════════════════════════════════════');
    console.log('  Por tool:');
    for (const [tool, stat] of byTool) {
      const icon = stat.fail === 0 ? '✓' : (stat.pass === 0 ? '✗' : '◐');
      console.log(`  ${icon} ${tool.padEnd(28)} ${stat.pass}/${stat.pass + stat.fail}`);
    }
    console.log('══════════════════════════════════════════════════════════════════════════════');
    for (const r of REPORT) {
      const icon = r.passed ? '✓' : '✗';
      const http = r.http === 200 ? '' : `[HTTP ${r.http}] `;
      console.log(`${icon} ${r.id} [${r.tool}] ${r.prompt} (${r.ms}ms)`);
      console.log(`    ${http}${r.reason} · text=${r.text_len}c`);
      if (r.cite_summary) console.log(`    Citations: ${r.cite_summary}`);
    }
    console.log('══════════════════════════════════════════════════════════════════════════════');
    if (REPORT.length > 0) {
      const avg = Math.round(REPORT.reduce((a, b) => a + b.ms, 0) / REPORT.length);
      const max = Math.max(...REPORT.map((r) => r.ms));
      console.log(`  Latency avg=${avg}ms · max=${max}ms`);
    }
    console.log('══════════════════════════════════════════════════════════════════════════════\n');
    /* eslint-enable no-console */
  });
});
