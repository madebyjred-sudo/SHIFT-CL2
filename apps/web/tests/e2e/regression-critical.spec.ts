/**
 * Regression suite — bugs críticos identificados 2026-05-12.
 *
 * Estos tests deberían detectar AUTOMÁTICAMENTE las regresiones que
 * obligaron a Carlos a reportar manualmente en producción durante el
 * sprint del 12-may. Idea: correr en cada preview deploy ANTES de
 * promote-preview.sh, falla = no promover.
 *
 * Estrategia: **API-level** principalmente (no UI). Más rápido, más
 * estable, y testea el contrato real. La UI ya tiene smoke tests
 * (demo-smoke.spec.ts) — acá vamos al backend porque ahí estuvieron
 * los bugs.
 *
 * Tests usan E2E_BASE_URL o por default http://localhost:5173 con dev
 * server (Vite proxy a localhost:3001 para el BFF).
 *
 * Para correr contra preview deploy:
 *   E2E_BASE_URL=https://preview-xxx---cl2-v2-web-xxx.run.app \
 *   E2E_API_URL=https://preview-xxx---cl2-v2-api-xxx.run.app \
 *   E2E_TEST_TOKEN=<service-role-or-admin-jwt> \
 *   npm run test:e2e
 *
 * Para CI/auto-deploy:
 *   - Después de deploy --preview, hacer un E2E_BASE_URL=<preview-url>
 *     test:e2e antes de promote-preview.sh.
 *   - Si tests fallan → descartar la revision (no promover).
 *   - Si pasan → promote.
 *
 * NOTA: estos tests NO requieren LLM real costoso. Solo verifican:
 *   - El endpoint responde 200
 *   - La respuesta NO es el fallback genérico
 *   - Los hits/citations llegan al cliente
 * Para tests de calidad de respuesta (¿es CORRECTA?), eso es otra suite
 * de eval ad-hoc, no smoke automation.
 */
import { test, expect } from '@playwright/test';

// ── Config ────────────────────────────────────────────────────────────
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001';
const TEST_TOKEN = process.env.E2E_TEST_TOKEN ?? '';
// Sesión "canon" para tests — debe existir en DB con transcript_segments > 1000
// y un YouTube id válido. El Plenario 11 may #07 (3e65413f) cumple ambos
// requisitos. Si se borra, cambiar acá.
const TEST_SESSION_UUID = process.env.E2E_TEST_SESSION_UUID ?? '3e65413f-b870-432a-9822-9d16f946df1e';
// Sesión SIN resumen ejecutivo — para forzar el path tool_calls en chat.
// Plenario #131 20-abril es ejemplo, ajustar si se borra.
const TEST_SESSION_SIN_RESUMEN_UUID =
  process.env.E2E_TEST_SESSION_SIN_RESUMEN ?? 'c643affc-e486-4dea-8d3f-72910b0b1b81';

// Fallback genérico EXACTO que el backend emite cuando assistantText.length===0.
// Cualquier respuesta a una pregunta válida que matchea esto = bug.
const GENERIC_FALLBACK =
  'No encontré una respuesta concreta para esta consulta en el corpus disponible.';

// ── Helpers ───────────────────────────────────────────────────────────

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TEST_TOKEN ? { Authorization: `Bearer ${TEST_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function apiGet(path: string) {
  return fetch(`${API_URL}${path}`, {
    headers: TEST_TOKEN ? { Authorization: `Bearer ${TEST_TOKEN}` } : {},
  });
}

/** Lee un stream SSE completo y devuelve la concatenación de tokens emitidos. */
async function consumeChatStream(res: Response): Promise<{
  text: string;
  citations: unknown[];
  events: Array<{ type: string; payload: unknown }>;
}> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const citations: unknown[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as { type: string; payload: unknown };
        events.push(json);
        if (json.type === 'token' && typeof json.payload === 'string') {
          text += json.payload;
        } else if (json.type === 'citation' && Array.isArray(json.payload)) {
          citations.push(...json.payload);
        }
      } catch {
        // skip malformed
      }
    }
  }
  return { text, citations, events };
}

// ── Tests ─────────────────────────────────────────────────────────────

test.describe('Regression — Health & API contract', () => {
  test('API /health responde ok=true', async () => {
    const res = await apiGet('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

test.describe('Regression — Cola de revisión (TranscriptsSection)', () => {
  test.skip(!TEST_TOKEN, 'requires E2E_TEST_TOKEN');

  test('GET /api/admin/transcripts/sessions?status=pending_review devuelve items', async () => {
    const res = await apiGet('/api/admin/transcripts/sessions?status=pending_review&limit=10');
    expect(res.status, 'auth ok').toBe(200);
    const body = await res.json();
    // Estructura mínima esperada
    expect(Array.isArray(body.sessions)).toBe(true);
    // Si hay sesiones pending_review en DB (típicamente >0), todas deben
    // tener status='pending_review'.
    if (body.sessions.length > 0) {
      for (const s of body.sessions) {
        expect(s.status).toBe('pending_review');
      }
    }
  });

  test('GET /api/admin/transcripts/sessions/:id devuelve segments paginados (no cap 200)', async () => {
    const res = await apiGet(`/api/admin/transcripts/sessions/${TEST_SESSION_UUID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBeDefined();
    expect(Array.isArray(body.segments)).toBe(true);
    // Plenario de 6h debe tener >1000 segments. Si caen a 200 = regresión.
    expect(
      body.segments.length,
      'segments paginados — sin cap a 200',
    ).toBeGreaterThan(1000);
  });

  test('POST /api/admin/transcripts/sessions/:id/review approve|reject', async () => {
    // Verificación que el endpoint EXISTE y valida action — no llamamos
    // approve en realidad porque cambia state global.
    const res = await apiPost(`/api/admin/transcripts/sessions/${TEST_SESSION_UUID}/review`, {
      action: 'invalid',
    });
    expect(res.status, 'rechaza action inválida con 400').toBe(400);
  });
});

test.describe('Regression — Lexa scope_session_uuid', () => {
  test.skip(!TEST_TOKEN, 'requires E2E_TEST_TOKEN');

  test('Sesión CON resumen ejecutivo: pass1 responde directo, no fallback', async () => {
    const res = await apiPost('/api/chat/stream', {
      agent_id: 'lexa',
      query: '¿De qué se trató esta sesión?',
      conversation_id: null,
      deep_insight: false,
      scope: { session_uuid: TEST_SESSION_UUID },
      history: [],
    });
    expect(res.status).toBe(200);

    const { text, events } = await consumeChatStream(res);
    expect(text.length, 'respuesta no vacía').toBeGreaterThan(50);
    expect(
      text.startsWith(GENERIC_FALLBACK),
      `respuesta NO debe ser el fallback genérico — recibido: "${text.slice(0, 100)}"`,
    ).toBe(false);
    // Debería emitir al menos un token chunk
    expect(events.some((e) => e.type === 'token')).toBe(true);
  });

  test('Sesión SIN resumen: pass2 emite texto (no fallback) usando tool results', async () => {
    const res = await apiPost('/api/chat/stream', {
      agent_id: 'lexa',
      query: '¿Qué pasó en esta sesión?',
      conversation_id: null,
      deep_insight: false,
      scope: { session_uuid: TEST_SESSION_SIN_RESUMEN_UUID },
      history: [],
    });
    expect(res.status).toBe(200);

    const { text, citations } = await consumeChatStream(res);
    // BUG 2026-05-12: este es el caso que rompía intermitentemente.
    // Pass1 → tool_call → tool ejecuta → citations OK → pass2 vacío → fallback.
    // El refactor v3 garantiza fallback determinístico desde tool results,
    // entonces O recibimos respuesta del LLM (mejor) O recibimos los extractos
    // crudos. NUNCA debería caer al genérico si la tool encontró hits.
    expect(text.length, 'respuesta no vacía').toBeGreaterThan(50);
    if (citations.length > 0) {
      // Si hay citations (la tool encontró hits), el texto NUNCA debe ser
      // el fallback genérico. Sería UX rota: "no encontré nada" + 6 citas.
      expect(
        text.startsWith(GENERIC_FALLBACK),
        'tenemos citas → respuesta no puede ser fallback genérico',
      ).toBe(false);
    }
  });
});

test.describe('Regression — Sesion public view (sessions.ts)', () => {
  test('GET /api/sessions/:id/transcript pagina segments (>1000)', async () => {
    const res = await apiGet(`/api/sessions/${TEST_SESSION_UUID}/transcript`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcript.segments.length).toBeGreaterThan(1000);
    // El cronómetro del player necesita duration_s coherente — la regresión
    // de las 50min ocurría porque devolvía solo 1000 segments y caía
    // la duración derivada del último cue.
    const lastSeg = body.transcript.segments[body.transcript.segments.length - 1];
    expect(lastSeg.end, 'video largo: último cue debe estar a >1h').toBeGreaterThan(3600);
  });
});
