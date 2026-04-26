/**
 * Podcast script generator.
 *
 * Stage 1 of the podcast pipeline: takes a source (sesión / expediente /
 * chat) and asks Lexa to write a narrated briefing script that fits the
 * target duration. Output is a structured JSON `{title, segments[]}`.
 *
 * Why a separate module from `openRouterStream`: this is non-streaming
 * (we want the full structured JSON back atomically) and uses a
 * different system prompt than the chat persona (Lexa-as-narrator
 * instead of Lexa-as-research-assistant). Same agent persona for
 * voice/style; different output contract.
 *
 * Cost ceiling: input is bounded by the source slice we feed in (caller
 * trims) and output is bounded by `max_tokens` here. ~150 words/min →
 * ~200 tokens/min spoken; we add headroom.
 */
import { withTimeout, withRetry } from './resilience.js';
import { getAgent } from './agentLoader.js';
import { logger } from './logger.js';

const OR_BASE = 'https://openrouter.ai/api/v1';
const SCRIPT_TIMEOUT_MS = 60_000;

export interface PodcastSegment {
  /**
   * 'host' = anchor / interviewer voice (uses row.voice_id).
   * 'guest' = analyst / expert voice (uses PODCAST_VOICE_GUEST_ID env).
   * Single-voice modes only emit 'host' segments.
   */
  speaker: 'host' | 'guest';
  text: string;
  /** Optional emotion hint for v3 audio tags. Ignored on multilingual_v2. */
  emotion?: 'neutral' | 'thoughtful' | 'serious' | 'curious' | 'excited' | 'sceptical';
}

export interface PodcastScript {
  title: string;
  segments: PodcastSegment[];
  /** Total chars across all segment texts — used for cost accounting. */
  total_chars: number;
}

export interface ScriptArgs {
  /** Free-form text Lexa should read + condense. Caller trims to budget. */
  source_text: string;
  /** Short label for the source — appears in the title-gen prompt. */
  source_label: string;
  /** Target duration in seconds. Used to budget output length. */
  duration_target_s: number;
  /** 'informativo' = factual briefing tone. 'conversacional' = lighter. */
  style: 'informativo' | 'conversacional';
}

/**
 * Generate the script. Returns parsed JSON; throws on model error or
 * malformed output. Caller is responsible for retry policy (one
 * generation costs real OpenRouter credits, so we don't auto-retry).
 */
export async function generatePodcastScript(args: ScriptArgs): Promise<PodcastScript> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const lexa = getAgent('lexa');
  if (!lexa) throw new Error('lexa agent not found');

  // Rough budget: 150 words ≈ 1 minute spoken. Char cap = words × 6.
  // Add 25% headroom. Cap at 8000 chars regardless to bound cost.
  const wordsBudget = Math.round((args.duration_target_s / 60) * 150 * 1.25);
  const charsBudget = Math.min(wordsBudget * 6, 8_000);

  const systemPrompt = buildScriptSystemPrompt(args.style, args.duration_target_s, charsBudget);
  const userPrompt = buildScriptUserPrompt(args.source_label, args.source_text, args.duration_target_s);

  const res = await withRetry(
    () =>
      withTimeout(
        (signal) =>
          fetch(`${OR_BASE}/chat/completions`, {
            signal,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://agentescl2.com',
              'X-Title': 'CL2 Podcast Script',
            },
            body: JSON.stringify({
              model: lexa.default_model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              response_format: { type: 'json_object' },
              max_tokens: 2_500,
              temperature: 0.6,
            }),
          }),
        { ms: SCRIPT_TIMEOUT_MS, label: 'podcast:script' },
      ),
    { attempts: 2, baseDelayMs: 800, label: 'podcast:script' },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn('podcast_script_http_failed', {
      status: res.status,
      detail: detail.slice(0, 200),
    });
    throw new Error(`script gen ${res.status}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('script gen: empty response');

  // Parse + validate.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('script gen: malformed JSON');
  }
  return validateScript(parsed);
}

// ─── Prompts ─────────────────────────────────────────────────────────

function buildScriptSystemPrompt(
  style: 'informativo' | 'conversacional',
  durationS: number,
  charsBudget: number,
): string {
  const minutes = Math.round((durationS / 60) * 10) / 10;
  if (style === 'conversacional') return buildDialoguePrompt(minutes, charsBudget);
  return buildMonologuePrompt(minutes, charsBudget);
}

function buildMonologuePrompt(minutes: number, charsBudget: number): string {
  return [
    'Sos Lexa, asesora legislativa de CL2. Escribís el guion de un mini-podcast narrado a una sola voz (host).',
    `Duración objetivo: ${minutes} minutos (~${charsBudget} caracteres totales en los segmentos).`,
    'Tono informativo, profesional, directo. Como un briefing de radio pública.',
    '',
    'REGLAS DEL GUION:',
    '- Español de Costa Rica neutro: "vos" no "tú", "acá" no "aquí". Plenario, fracción, expediente, comisión, dictamen — terminología real.',
    '- Cada afirmación factual basada en el material fuente. Si no aparece en la fuente, no lo digas.',
    '- Cuando cites un expediente o un artículo, decilo en voz alta naturalmente: "expediente veintidós mil novecientos dieciocho", "artículo ciento trece del Reglamento". NO leas corchetes ni números crudos como "abrir corchete uno cerrar corchete".',
    '- Estructura recomendada: gancho de apertura (1-2 oraciones) → desarrollo (2-4 segmentos) → cierre con la pregunta política o la implicación práctica.',
    '- Segmentos cortos (1-3 oraciones cada uno). Pausas entre ideas. Ritmo de podcast, no de informe escrito.',
    '- Sin AI hype, sin "inteligencia artificial", sin "vamos a explorar". Empezás directo en el contenido.',
    '',
    'FORMATO DE SALIDA — JSON estricto:',
    '{',
    '  "title": "Título corto editorial (máximo 80 caracteres)",',
    '  "segments": [',
    '    { "speaker": "host", "text": "...", "emotion": "neutral|thoughtful|serious|curious" }',
    '  ]',
    '}',
    'Devolvé SOLO el JSON, sin texto adicional, sin markdown, sin ```.',
  ].join('\n');
}

function buildDialoguePrompt(minutes: number, charsBudget: number): string {
  return [
    'Estás escribiendo el guion de un mini-podcast en formato ENTREVISTA entre dos personas:',
    '- HOST: anchor / conductora del podcast. Hace preguntas, contextualiza, cierra cada segmento. Voz cálida, periodística.',
    '- GUEST: Lexa, asesora legislativa de CL2. Responde con datos del archivo, cita expedientes/artículos, mantiene autoridad técnica sin sonar acartonada.',
    '',
    `Duración objetivo: ${minutes} minutos (~${charsBudget} caracteres totales sumando ambas voces).`,
    'Tono conversacional, accesible, con calidez. Pensá en una sección de "Dateline" con dos personas, no un monólogo cortado.',
    '',
    'REGLAS DEL GUION:',
    '- Empezá con HOST presentando el tema en 1-2 oraciones — sin saludo formal, directo al gancho.',
    '- Alterná HOST → GUEST → HOST → GUEST. Segmentos de 1-3 oraciones cada uno (40-200 caracteres). Pausas entre ideas, ritmo de podcast.',
    '- HOST puede repreguntar, repetir un dato para énfasis, dudar abiertamente ("¿espera, eso quiere decir que...?"). GUEST responde con precisión, sin condescender.',
    '- Cerrá con HOST formulando la implicación política o la pregunta abierta, no con un resumen seco.',
    '- Español de Costa Rica neutro: "vos" no "tú", "acá" no "aquí". Plenario, fracción, expediente, comisión, dictamen.',
    '- Cada afirmación factual de GUEST basada en el material fuente. Si no aparece, no lo decís.',
    '- Cuando GUEST cite un expediente o artículo, en voz alta y natural: "expediente veintidós mil novecientos dieciocho", "artículo ciento trece del Reglamento". Sin corchetes, sin números técnicos crudos.',
    '- Sin AI hype, sin "inteligencia artificial", sin "soy un asistente" — GUEST se llama Lexa y punto.',
    '- Emociones disponibles para audio tags v3: neutral, thoughtful, serious, curious, excited, sceptical. Usalas con moderación, no en cada segmento.',
    '',
    'FORMATO DE SALIDA — JSON estricto:',
    '{',
    '  "title": "Título corto editorial (máximo 80 caracteres)",',
    '  "segments": [',
    '    { "speaker": "host", "text": "...", "emotion": "curious" },',
    '    { "speaker": "guest", "text": "...", "emotion": "thoughtful" }',
    '  ]',
    '}',
    'Devolvé SOLO el JSON, sin texto adicional, sin markdown, sin ```.',
  ].join('\n');
}

function buildScriptUserPrompt(label: string, source: string, durationS: number): string {
  return [
    `Material fuente — ${label}:`,
    '"""',
    source.slice(0, 12_000),
    '"""',
    '',
    `Escribí un guion de podcast de aproximadamente ${Math.round(durationS / 60)} minuto${
      durationS >= 90 ? 's' : ''
    } basado en lo anterior. Devolvé el JSON.`,
  ].join('\n');
}

// ─── Validation ──────────────────────────────────────────────────────

function validateScript(raw: unknown): PodcastScript {
  if (typeof raw !== 'object' || raw === null) throw new Error('script: not an object');
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 200) : '';
  if (!title) throw new Error('script: title missing');
  const segs = obj.segments;
  if (!Array.isArray(segs) || segs.length === 0) throw new Error('script: segments empty');
  const validated: PodcastSegment[] = [];
  let total = 0;
  for (const s of segs) {
    if (typeof s !== 'object' || s === null) continue;
    const seg = s as Record<string, unknown>;
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    const speaker: PodcastSegment['speaker'] =
      seg.speaker === 'guest' ? 'guest' : 'host';
    const emotion = (() => {
      const e = typeof seg.emotion === 'string' ? seg.emotion : 'neutral';
      const allowed = ['neutral', 'thoughtful', 'serious', 'curious', 'excited', 'sceptical'];
      return allowed.includes(e) ? (e as PodcastSegment['emotion']) : 'neutral';
    })();
    validated.push({ speaker, text, emotion });
    total += text.length;
  }
  if (validated.length === 0) throw new Error('script: no valid segments');
  // Hard cap on output size — stops a runaway model from blowing TTS cost.
  if (total > 9_000) {
    throw new Error(`script: total ${total} chars exceeds cap`);
  }
  return { title, segments: validated, total_chars: total };
}
