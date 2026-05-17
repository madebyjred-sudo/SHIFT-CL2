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
import { withRetry } from './resilience.js';
import { getAgent } from './agentLoader.js';
import { logger } from './logger.js';
import { cerebroInvoke } from './cerebroLlmClient.js';

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
  /**
   * Optional user-supplied directive (≤140 chars) — surfaces what the
   * listener wants emphasized. Threaded into the user prompt as a
   * "DIRECTRIZ DEL USUARIO" block. Empty/undefined = standard behavior.
   */
  user_prompt?: string | null;
}

/**
 * Generate the script. Returns parsed JSON; throws on model error or
 * malformed output. Caller is responsible for retry policy (one
 * generation costs real OpenRouter credits, so we don't auto-retry).
 */
export async function generatePodcastScript(args: ScriptArgs): Promise<PodcastScript> {
  const apiKey = process.env.CEREBRO_API_KEY;
  if (!apiKey) throw new Error('CEREBRO_API_KEY not set');

  const lexa = getAgent('lexa');
  if (!lexa) throw new Error('lexa agent not found');

  // Rough budget: 150 words ≈ 1 minute spoken. Char cap = words × 6.
  // Add 25% headroom. Cap at 8000 chars regardless to bound cost.
  const wordsBudget = Math.round((args.duration_target_s / 60) * 150 * 1.25);
  const charsBudget = Math.min(wordsBudget * 6, 8_000);

  const systemPrompt = buildScriptSystemPrompt(args.style, args.duration_target_s, charsBudget);
  const userPrompt = buildScriptUserPrompt(args.source_label, args.source_text, args.duration_target_s, args.user_prompt);

  // Track 0c — via Cerebro `/v1/llm/invoke`. apiKey ya no se usa
  // (Cerebro maneja OpenRouter del otro lado). El worker no tiene email
  // del user a mano, así que no habilitamos memory para podcasts — la
  // generación de podcasts es system-driven (toma el source pre-elegido
  // por el user via UI) y la preferencia personal viene en `user_prompt`,
  // no en memory.
  void apiKey;
  const llmResp = await withRetry(
    () =>
      cerebroInvoke({
        model: lexa.default_model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2_500,
        temperature: 0.6,
        app_id: 'cl2',
        trace_label: `podcast:script:${args.style}`,
      }),
    { attempts: 2, baseDelayMs: 800, label: 'podcast:script' },
  );

  const content = (llmResp.text || '').trim();
  if (!content) throw new Error('script gen: empty response');

  // Parse + validate. Some models (Claude on OpenRouter, occasional Gemini)
  // wrap the JSON in markdown fences (```json ... ```) even when we ask for
  // response_format: json_object. Strip them defensively before parsing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Try stripping ```json / ```  fences.
    const stripped = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // Last-ditch: extract the largest {...} block.
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // Give up — log a useful preview so the next failure is debuggable
          // from logs alone (no need to repro).
          logger.warn('podcast_script_unparseable', {
            preview: content.slice(0, 400),
            length: content.length,
          });
          throw new Error('script gen: malformed JSON');
        }
      } else {
        logger.warn('podcast_script_unparseable', {
          preview: content.slice(0, 400),
          length: content.length,
        });
        throw new Error('script gen: malformed JSON');
      }
    }
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

// Cap del material fuente que llega al LLM. Subido 2026-05-12 de 12k a
// 80k (~20k tokens) para que el podcast sobre una sesión de 6h reciba
// contexto real, no truncado al 30%. Sonnet 4.6 acepta 200k tokens; el
// resto del budget queda para system prompt + script output.
// IMPORTANTE: este cap debe estar alineado con PODCAST_SOURCE_CAP en
// routes/podcasts.ts. Si uno se cambia, el otro también.
const SCRIPT_SOURCE_CAP = 80_000;

function buildScriptUserPrompt(
  label: string,
  source: string,
  durationS: number,
  userDirective?: string | null,
): string {
  const lines: string[] = [
    `Material fuente — ${label}:`,
    '"""',
    source.slice(0, SCRIPT_SOURCE_CAP),
    '"""',
    '',
  ];
  // Hard cap to 280 chars (140 user + 140 enhanced) so a malicious
  // caller can't blow up the prompt budget. Trim whitespace too.
  const directive = (userDirective ?? '').trim().slice(0, 280);
  if (directive) {
    lines.push(
      'DIRECTRIZ DEL USUARIO (priorizá esto, sin contradecir el material fuente):',
      `"${directive}"`,
      '',
    );
  }
  lines.push(
    `Escribí un guion de podcast de aproximadamente ${Math.round(durationS / 60)} minuto${
      durationS >= 90 ? 's' : ''
    } basado en lo anterior. Devolvé el JSON.`,
  );
  return lines.join('\n');
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

// ─── Prompt enhancement ──────────────────────────────────────────────
//
// Used by POST /api/podcasts/enhance-prompt. The user types a 140-char
// idea ("hablá del impacto fiscal y mencioná a Otto"); a flash model
// rewrites it into a tighter directive that scripts read better.
// Output also capped at 140 chars so the modal can show it inline and
// the generation request stays below the 280-char hard cap.
//
// Model selection: deliberately NOT Lexa's default (Sonnet-class) —
// this is a one-shot rewrite of <140 chars, the cheap-and-fast tier
// gives indistinguishable quality at ~1/40th the price + ~1/3 the
// latency. Same default as the workspace transform pipeline. Override
// via env if a faster model becomes available.
const ENHANCE_TIMEOUT_MS = 20_000;
const ENHANCE_MAX_LEN = 140;
const ENHANCE_MODEL = process.env.PODCAST_ENHANCE_MODEL ?? 'deepseek/deepseek-v4-flash';

export async function enhancePodcastPrompt(rawPrompt: string): Promise<string> {
  const apiKey = process.env.CEREBRO_API_KEY;
  if (!apiKey) throw new Error('CEREBRO_API_KEY not set');

  const trimmed = rawPrompt.replace(/\s+/g, ' ').trim().slice(0, ENHANCE_MAX_LEN);
  if (!trimmed) throw new Error('empty prompt');

  // Voice still matches Lexa's editorial register, but we bypass the
  // agent loader since we don't need persona/tools — just a single
  // string-in / string-out call.
  const sys = [
    'Sos Lexa, asesora legislativa de CL2.',
    `Reescribís la directriz que el usuario quiere darle al podcast en una sola oración española de Costa Rica, máximo ${ENHANCE_MAX_LEN} caracteres.`,
    'Mantenés la intención original. Sumás especificidad concreta sólo si está implícita (ej: "hablá del impacto fiscal" → "Enfocá el guion en el impacto fiscal y los actores legislativos involucrados").',
    'NO inventes datos. NO agregues actores ni números no mencionados. NO uses comillas. Devolvé sólo la oración mejorada, sin prefijos como "Aquí está:" ni explicaciones.',
  ].join(' ');

  // Track 0c — via Cerebro. apiKey kept for env presence check above.
  void apiKey;
  void ENHANCE_TIMEOUT_MS; // timeout vive ahora dentro de cerebroInvoke (60s default)
  const llmResp = await cerebroInvoke({
    model: ENHANCE_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: trimmed },
    ],
    max_tokens: 120,
    temperature: 0.4,
    app_id: 'cl2',
    trace_label: 'podcast:enhance',
  });

  const out = (llmResp.text || '').trim();
  if (!out) throw new Error('enhance: empty response');
  // Strip surrounding quotes if Lexa wrapped them anyway, collapse
  // whitespace, hard cap.
  const cleaned = out
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ENHANCE_MAX_LEN);
  return cleaned;
}
