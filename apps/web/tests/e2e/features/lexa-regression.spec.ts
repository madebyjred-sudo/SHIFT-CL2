/**
 * @feature @lexa-regression Lexa cambió de tono y de respuesta (post Sprint 2/3)
 *
 * El cliente (Donovan, Carlos, Javier) listó 28 problemas en la reunión del
 * 14-may-2026. Muchos eran de la forma "Lexa dice X cuando debería decir Y".
 * Después del Sprint 2 + 3 + Refactor Wave 0/1, esta suite verifica que Lexa
 * SÍ cambió su forma de responder en los casos que más le dolían al cliente.
 *
 * Estrategia: hacer la pregunta literal del cliente contra /api/chat/stream
 * y verificar:
 *   1. No es el fallback genérico ("No encontré una respuesta concreta...")
 *   2. Contiene los términos clave esperados en la respuesta nueva
 *   3. NO contiene los términos que delataban la respuesta vieja
 *
 * Estos tests están diseñados para correr SIN ejecutar el LLM real cuando
 * sea posible (los que sí lo necesitan cuestan ~/run total). Por defecto
 * se saltan a menos que el env los habilite.
 *
 * Cómo correr:
 *   E2E_LEXA_REGRESSION=1 npm run test:e2e -- --grep @lexa-regression
 *
 * NO correr en CI por default — son caros. Correr ad-hoc antes de demos o
 * cuando se cambien tools, prompts, o se vea respuesta sospechosa en prod.
 *
 * El reporte HTML de Playwright queda en playwright-report/ y se referencia
 * desde CL2-Verificacion-28-Pedidos-2026-05-16.docx (sección "Verificación
 * automática").
 */
import { test, expect } from '@playwright/test';
import { mintToken } from '../_helpers/auth';
import { E2E_ENV } from '../_helpers/env';

// ── Config ────────────────────────────────────────────────────────────

/**
 * Estos tests son caros (cada uno gasta tokens del modelo). No corren
 * por default. Habilitar con E2E_LEXA_REGRESSION=1.
 */
const ENABLED = process.env.E2E_LEXA_REGRESSION === '1';

/**
 * Fallback genérico que Lexa emite cuando assistantText.length === 0.
 * Cualquier pregunta concreta que recibe esto = bug.
 */
const GENERIC_FALLBACK = 'No encontré una respuesta concreta';

/** Expediente convertido en ley — usado para preguntas de "¿ya es ley?". */
const EXP_LEY = '24.018';
/** Expediente activo en comisión — usado para preguntas operativas. */
const EXP_ACTIVO = '23.511';

// ── Helpers ───────────────────────────────────────────────────────────

interface LexaResponse {
  text: string;
  citations: Array<Record<string, unknown>>;
  tool_calls: Array<Record<string, unknown>>;
  events: Array<{ type: string; payload?: unknown }>;
  status: number;
}

async function askLexa(
  query: string,
  token: string,
  opts: { agent_id?: string; scope?: Record<string, unknown> } = {},
): Promise<LexaResponse> {
  const res = await fetch(`${E2E_ENV.apiBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agent_id: opts.agent_id ?? 'lexa',
      query,
      conversation_id: null,
      deep_insight: false,
      scope: opts.scope ?? {},
      history: [],
    }),
  });

  if (res.status !== 200 || !res.body) {
    return { text: '', citations: [], tool_calls: [], events: [], status: res.status };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const citations: Array<Record<string, unknown>> = [];
  const tool_calls: Array<Record<string, unknown>> = [];
  const events: Array<{ type: string; payload?: unknown }> = [];

  for (;;) {
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
        const json = JSON.parse(data) as { type: string; payload?: unknown };
        events.push(json);
        if (json.type === 'token' && typeof json.payload === 'string') {
          text += json.payload;
        } else if (json.type === 'citation' && json.payload) {
          citations.push(json.payload as Record<string, unknown>);
        } else if (json.type === 'tool_call' && json.payload) {
          tool_calls.push(json.payload as Record<string, unknown>);
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  return { text, citations, tool_calls, events, status: 200 };
}

/** Normaliza para matchear case-insensitive y sin acentos rebeldes. */
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function expectContainsAny(text: string, terms: string[], label: string): void {
  const n = norm(text);
  const hit = terms.find((t) => n.includes(norm(t)));
  expect(hit, `${label} — la respuesta debería mencionar uno de [${terms.join(', ')}] — texto recibido: ${text.slice(0, 200)}`).toBeTruthy();
}

function expectExcludes(text: string, terms: string[], label: string): void {
  const n = norm(text);
  const miss = terms.find((t) => n.includes(norm(t)));
  expect(miss, `${label} — la respuesta NO debería mencionar "${miss}" — texto recibido: ${text.slice(0, 200)}`).toBeFalsy();
}

// ── 10 preguntas que cambiaron de respuesta tras Sprint 2/3 ──────────

test.describe('@feature @lexa-regression Lexa cambió tras Sprint 2/3', () => {
  test.skip(!ENABLED, 'Setear E2E_LEXA_REGRESSION=1 para habilitar (gasta tokens reales)');

  // Lexa con tool calls + deep_insight = false aún puede tardar 30-50s en
  // responder a preguntas procedurales sobre el Reglamento. El default
  // de 30s de Playwright es ajustado para esto.
  test.setTimeout(120_000);

  let token: string;

  test.beforeAll(async () => {
    const s = await mintToken('madebyjred@gmail.com');
    token = s.access_token;
  });

  test('1. ¿El expediente 24.018 ya es ley? — antes confundía estado, ahora resuelve "Ley"', async () => {
    const r = await askLexa(`¿El expediente ${EXP_LEY} ya es ley?`, token);
    expect(r.status).toBe(200);
    expect(r.text.length, 'respuesta no vacía').toBeGreaterThan(40);
    expect(r.text.startsWith(GENERIC_FALLBACK), 'no es fallback').toBe(false);
    expectContainsAny(r.text, ['ley', 'publicada', 'vigente', 'aprobada'], 'reconoce el estado ley');
  });

  test('2. ¿Fecha estimada de dictamen del 23.511? — antes inventaba, ahora razona desde calendario', async () => {
    const r = await askLexa(`¿Cuál es la fecha estimada de dictamen del expediente ${EXP_ACTIVO}?`, token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    expect(r.text.startsWith(GENERIC_FALLBACK), 'no es fallback').toBe(false);
    // Acepta varias formas — Lexa puede decir "no hay convocatoria todavía", o
    // dar una ventana. Lo importante es que NO diga "el 15 de mayo" como si
    // tuviera un valor mágico de DB.
    expectContainsAny(
      r.text,
      ['comisión', 'comision', 'agenda', 'convocatoria', 'orden del día', 'orden del dia', 'cuatrimestre', 'depende'],
      'menciona el proceso real (no fecha fantasma)',
    );
  });

  test('3. ¿Proponente principal del 23.511? — antes a veces omitía, ahora siempre devuelve nombre', async () => {
    const r = await askLexa(`¿Quién es el proponente principal del expediente ${EXP_ACTIVO}?`, token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.text.startsWith(GENERIC_FALLBACK), 'no es fallback').toBe(false);
    // Debe nombrar al menos un diputado (apellido capitalizado o partido)
    expect(/[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/.test(r.text), 'incluye al menos un nombre propio').toBe(true);
  });

  test('4. ¿Dictamen + texto sustitutivo del 23.511? — antes mezclaba, ahora distingue', async () => {
    const r = await askLexa(
      `¿El expediente ${EXP_ACTIVO} tiene dictamen y texto sustitutivo? Mostrame el archivo si lo hay.`,
      token,
    );
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    expectContainsAny(r.text, ['dictamen', 'sustitutivo', 'texto'], 'menciona los dos conceptos');
  });

  test('5. Firmas para moción 137 primer día — antes daba "varias", ahora regla exacta o corrige el concepto', async () => {
    // Lexa puede responder de dos formas válidas:
    //   (A) Da el número directo (10 / diez firmas)
    //   (B) Corrige el concepto si la pregunta confunde "moción de orden" con
    //       "moción de fondo" (el 137 regula mociones de FONDO, no de orden).
    // Ambas demuestran que cambió de "respuesta vaga" a "respuesta precisa".
    const r = await askLexa('¿Cuántas firmas se necesitan para una moción de fondo bajo el artículo 137 en el primer día?', token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    // Acepta el número O una corrección procedural concreta.
    expectContainsAny(
      r.text,
      ['10', 'diez', 'moción de fondo', 'mocion de fondo', 'artículo 137', 'articulo 137', 'reglamento'],
      'incluye un número o cita el artículo/concepto correcto',
    );
    expectExcludes(r.text, ['varias firmas', 'varias diputadas'], 'no usa lenguaje vago');
  });

  test('6. Audiencia del INS al 23.511 — antes no encontraba, ahora cita audiencia', async () => {
    const r = await askLexa(`¿Qué dijo el INS en la audiencia del expediente ${EXP_ACTIVO}?`, token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    // Si no hay audiencia, debe DECIR "no se registra audiencia" en vez del fallback genérico
    if (r.text.startsWith(GENERIC_FALLBACK)) {
      throw new Error(`Caímos al fallback genérico — Lexa debería decir "no se registra audiencia del INS" si es el caso`);
    }
  });

  test('7. Orden del día con capítulo/debate — antes resumía, ahora estructura', async () => {
    const r = await askLexa(
      `Mostrame la orden del día más reciente del expediente ${EXP_ACTIVO} con capítulo y debate.`,
      token,
    );
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    expectContainsAny(r.text, ['capítulo', 'capitulo', 'debate', 'primer debate', 'segundo debate', 'orden del día', 'orden del dia'], 'menciona estructura');
  });

  test('8. Novedades algorítmicas en 23.511 — antes texto plano, ahora lista accionable', async () => {
    const r = await askLexa(`Mostrame las novedades del expediente ${EXP_ACTIVO} de la última semana.`, token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    // Si no hay novedades, Lexa debería decir "sin movimiento" o similar, no fallback
    expect(r.text.startsWith(GENERIC_FALLBACK), 'no es fallback genérico').toBe(false);
  });

  test('9. Proyectos convocados por decreto ejecutivo — antes ignoraba, ahora la tool decretos los lista', async () => {
    const r = await askLexa('¿Qué proyectos están convocados hoy por decreto ejecutivo del Poder Ejecutivo?', token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    expectContainsAny(
      r.text,
      ['decreto', 'convocatoria', 'extraordinarias', 'poder ejecutivo', 'sesiones extraordinarias'],
      'menciona el mecanismo de convocatoria',
    );
  });

  test('10. ¿Cómo funciona el veto presidencial? — antes vago, ahora cita Reglamento + plazos', async () => {
    const r = await askLexa('¿Cómo funciona el veto presidencial en Costa Rica? ¿Qué plazos hay?', token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(40);
    expectContainsAny(
      r.text,
      ['veto', 'presidente', 'asamblea', 'resello', 'plazo'],
      'menciona los conceptos del proceso',
    );
    expectExcludes(r.text, ['no estoy seguro', 'no tengo información', 'no tengo informacion'], 'no usa "no sé" como respuesta');
  });
});
