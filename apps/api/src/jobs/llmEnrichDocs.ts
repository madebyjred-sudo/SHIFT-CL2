/**
 * llmEnrichDocs.ts — Sprint demo. Popula `text_resumido`, `por_tanto_text`,
 * `decision_inferida` en `sil_documentos`.
 *
 * Cubre pedidos del cliente:
 *   - 12b "POR TANTO" extraído como columna dedicada (dictamen / resolución).
 *   - 16k resumen 200-300 palabras por documento (≥500 chars).
 *   - decisión inferida con vocab CL2: aprobado | rechazado | archivado |
 *     en_tramite | indeterminado.
 *
 * Doctrina:
 *   - POR TANTO se extrae con regex (heurística — markers en
 *     `legalDocChunker.ts`). Sin LLM.
 *   - text_resumido y decision_inferida son LLM puros (subjetivo,
 *     contextual). Modelo barato: claude-haiku-4.5.
 *
 * Bypass note (Wave 2 deuda):
 *   Este job llama OpenRouter directo, NO via Cerebro Gateway. Conscious
 *   bypass — Cerebro aún no tiene endpoint para batch enrichment de docs
 *   estáticos (no streaming, no SSE, sin scope_user). Cierre vía
 *   `feat/oai-compat` en Cerebro: cuando el agente `cl2-enricher` exista,
 *   esta función llamará a `${CEREBRO_BASE_URL}/v1/chat/completions` con
 *   header `X-CL2-Agent: cl2-enricher`. Mientras tanto, OPENROUTER_API_KEY
 *   directo + ai_call_log queda fuera (logging diferido al cierre).
 *
 * Idempotente: solo procesa rows donde el campo target sea NULL. Re-correr
 * el job sobre los 22k es seguro (skip de rows ya hechas).
 *
 * Author: Jred (via Claude Code) — 2026-05-17
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import { logger } from '../services/logger.js';
import { withRetry, withTimeout, ResilienceError } from '../services/resilience.js';
import { chunkLegalDoc } from '../services/legalDocChunker.js';

// ── Tipos públicos ───────────────────────────────────────────────────────────

export interface LlmEnrichScope {
  /** Si está set, limita el batch total. Útil para tests de costo. */
  limit?: number;
  /** Saltea LLM, hace dry-run con conteos + extracción regex POR TANTO. */
  dry_run?: boolean;
  /** Solo procesa docs con `tipo` en este set. Por default, todos. */
  tipo_filter?: string[];
  /** Concurrencia LLM. Default 5 (OpenRouter rate-limits). */
  concurrency?: number;
  /** Tamaño de página de Supabase. Default 200. */
  page_size?: number;
}

export interface LlmEnrichResult {
  docs_evaluados: number;
  docs_resumen_generado: number;
  docs_por_tanto_extraido: number;
  docs_decision_inferida: number;
  docs_skipped_sin_texto: number;
  errors: number;
  duration_ms: number;
  /** Tokens totales — para proyectar costo */
  tokens_in_total: number;
  tokens_out_total: number;
}

export interface LlmCallOutput {
  content: string;
  tokens_in: number;
  tokens_out: number;
}

export type LlmCaller = (args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens: number;
  jsonMode?: boolean;
}) => Promise<LlmCallOutput>;

// ── Constantes ───────────────────────────────────────────────────────────────

const RESUMEN_MODEL = process.env.CL2_ENRICH_RESUMEN_MODEL ?? 'anthropic/claude-haiku-4.5';
const DECISION_MODEL = process.env.CL2_ENRICH_DECISION_MODEL ?? 'anthropic/claude-haiku-4.5';
const OR_BASE = 'https://openrouter.ai/api/v1'; // Direct bypass — ver comment cabecera
const OR_TIMEOUT_MS = 60_000;
const OR_RETRY_ATTEMPTS = 2;
const OR_RETRY_BASE_MS = 800;

const MIN_TEXT_CHARS_RESUMEN = 500;
const MIN_TEXT_CHARS_POR_TANTO = 200;
const MAX_PER_TANTO_CHARS = 3000;
const MAX_RESUMEN_TOKENS = 700; // ~250-300 palabras; sube de 400 (truncation observada en test 2026-05-17)

const VALID_DECISIONS = new Set([
  'aprobado',
  'rechazado',
  'archivado',
  'en_tramite',
  'indeterminado',
]);

// ── Supabase lazy client ─────────────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('supabase env missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Tipos internos ───────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  expediente_id: number | null;
  tipo: string | null;
  titulo: string | null;
  text_extracted: string | null;
  text_chars: number | null;
  text_resumido: string | null;
  por_tanto_text: string | null;
  decision_inferida: string | null;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const RESUMEN_SYSTEM = [
  'Sos un analista legislativo en Costa Rica trabajando para CL2 Consultoría.',
  'Tu tarea: resumir un documento legislativo en 150-250 palabras.',
  '',
  'Reglas:',
  '  1. Lenguaje técnico, sobrio. Cero hype. Cero marketing.',
  '  2. Si hay fechas, números de ley, números de expediente, votaciones — citalos.',
  '  3. Si el documento es un dictamen, indicá si es mayoría/minoría y la postura.',
  '  4. Si el documento es un proyecto de ley, indicá qué propone y quién lo presenta.',
  '  5. NO INVENTES nada. Si un dato no está, no lo incluyas.',
  '  6. Español neutro. Voz tercera persona.',
  '  7. 1-2 párrafos, máximo 250 palabras.',
  '',
  'Devolvé JSON estricto:',
  '{"resumen": "..."}',
].join('\n');

const DECISION_SYSTEM = [
  'Sos un analista legislativo en Costa Rica.',
  'Te paso el POR TANTO (sección dispositiva) de un documento legislativo.',
  'Clasificá la decisión que expresa, devolviendo EXACTAMENTE una de estas etiquetas:',
  '',
  '  • aprobado      — el dictamen/resolución aprueba el proyecto o recomienda su aprobación.',
  '  • rechazado     — el dictamen/resolución rechaza el proyecto o lo declara inconstitucional.',
  '  • archivado     — la decisión es archivar el expediente sin resolver al fondo.',
  '  • en_tramite    — el documento ordena continuar el trámite, devolver a comisión, audiencias, etc.',
  '  • indeterminado — no hay información suficiente para clasificar.',
  '',
  'Reglas:',
  '  1. Devolvé JSON estricto: {"decision": "<una de las 5 etiquetas>"}',
  '  2. NO expliques. NO uses markdown.',
  '  3. Si dudás entre dos, elegí "indeterminado".',
].join('\n');

function buildResumenUserPrompt(doc: DocRow): string {
  const titulo = doc.titulo ?? '(sin título)';
  const tipo = doc.tipo ?? 'documento';
  const expediente = doc.expediente_id ? `Expediente ${doc.expediente_id}.` : '';
  const text = (doc.text_extracted ?? '').slice(0, 24_000); // hard cap input
  return [
    `Tipo: ${tipo}`,
    `Título: ${titulo}`,
    expediente,
    '',
    'DOCUMENTO (texto crudo):',
    '```',
    text,
    '```',
    '',
    'Generá el resumen.',
  ].join('\n');
}

function buildDecisionUserPrompt(porTanto: string): string {
  return [
    'POR TANTO (sección dispositiva):',
    '```',
    porTanto.slice(0, 4000),
    '```',
    '',
    'Clasificá la decisión.',
  ].join('\n');
}

// ── LLM caller real ──────────────────────────────────────────────────────────

async function defaultLlmCall(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens: number;
  jsonMode?: boolean;
}): Promise<LlmCallOutput> {
  const orKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!orKey) throw new Error('OPENROUTER_API_KEY not set');

  return withRetry(
    async () => {
      const res = await withTimeout(
        (signal) =>
          fetch(`${OR_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${orKey}`,
              'HTTP-Referer': 'https://agentescl2.com',
              'X-Title': 'Shift CL2 Doc Enrichment',
            },
            body: JSON.stringify({
              model: args.model,
              messages: [
                { role: 'system', content: args.systemPrompt },
                { role: 'user', content: args.userPrompt },
              ],
              max_tokens: args.maxTokens,
              temperature: 0.2,
              ...(args.jsonMode ? { response_format: { type: 'json_object' } } : {}),
            }),
            signal,
          }),
        { ms: OR_TIMEOUT_MS, label: 'enrich:doc' },
      );

      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new ResilienceError(`openrouter ${res.status}: ${text.slice(0, 200)}`, 'aborted');
        }
        throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: json?.choices?.[0]?.message?.content ?? '',
        tokens_in: json?.usage?.prompt_tokens ?? 0,
        tokens_out: json?.usage?.completion_tokens ?? 0,
      };
    },
    { attempts: OR_RETRY_ATTEMPTS, baseDelayMs: OR_RETRY_BASE_MS, label: 'enrich:doc' },
  );
}

// ── Parsers tolerantes ───────────────────────────────────────────────────────

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function recoverJson(raw: string): unknown {
  let parsed = tryParseJson(raw);
  if (parsed) return parsed;
  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    parsed = tryParseJson(fence[1]!);
    if (parsed) return parsed;
  }
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) {
    parsed = tryParseJson(raw.slice(open, close + 1));
    if (parsed) return parsed;
  }
  return null;
}

export function parseResumen(raw: string): string {
  const obj = recoverJson(raw);
  if (obj && typeof (obj as any).resumen === 'string') {
    return ((obj as any).resumen as string).trim();
  }
  // Fallback: si el LLM ignora el JSON mode y devuelve texto plano, lo
  // aceptamos siempre que tenga >50 chars.
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (stripped.length > 50 && !stripped.startsWith('{')) {
    return stripped;
  }
  // Recover from TRUNCATED JSON — LLM topa con max_tokens antes de cerrar
  // la string. Patrón típico: '```json\n{"resumen": "...texto sin cierre'.
  // Extraemos manualmente el contenido entre "resumen": "..." y devolvemos
  // como resumen, aún si está cortado a media oración.
  const m = raw.match(/"resumen"\s*:\s*"([\s\S]+?)(?:"\s*[},]|$)/);
  if (m && m[1] && m[1].length > 50) {
    // Unescape JSON: \" → ", \n → \n literal, etc.
    const text = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    // Cortar al último punto/cierre de oración decente.
    const lastDot = text.lastIndexOf('.');
    if (lastDot > 100) {
      return text.slice(0, lastDot + 1);
    }
    return text;
  }
  throw new Error('resumen_invalid_json');
}

export function parseDecision(raw: string): string {
  const obj = recoverJson(raw);
  let value: string | null = null;
  if (obj && typeof (obj as any).decision === 'string') {
    value = ((obj as any).decision as string).trim().toLowerCase();
  } else {
    // Fallback: extraer la etiqueta del texto plano.
    const lower = raw.toLowerCase();
    for (const v of VALID_DECISIONS) {
      if (lower.includes(v)) { value = v; break; }
    }
  }
  if (!value || !VALID_DECISIONS.has(value)) {
    return 'indeterminado';
  }
  return value;
}

// ── Extracción regex POR TANTO ───────────────────────────────────────────────

/**
 * Devuelve el POR TANTO si el documento tiene marker reconocible, null si no.
 * Usa `chunkLegalDoc()` que ya tiene los markers (POR TANTO, FALLO,
 * CONCLUSIONES, RECOMIENDA) anclados a límite de palabra.
 *
 * IMPORTANTE: la función pasa `doc_class='dictamen_comision'` forzado para
 * que el chunker corra la rama legal incluso cuando `detectDocClass()`
 * devuelve 'generico' (lo hace cuando el header no tiene las pistas
 * obvias — Sala/Procuraduría — pero el doc igual tiene CONSIDERANDO +
 * POR TANTO).
 */
export function extractPorTanto(text: string, tipo?: string): string | null {
  const fileName = tipo ?? '';
  // forzamos un fileName que dispare la rama legal
  const docResult = chunkLegalDoc(text, { fileName: `dictamen ${fileName}` });
  if (docResult.strategy !== 'por_tanto' || !docResult.por_tanto_text) return null;
  const pt = docResult.por_tanto_text.trim();
  if (pt.length < 30) return null; // muy corto, probable falso positivo
  return pt.slice(0, MAX_PER_TANTO_CHARS);
}

// ── Función pura — enriquecer UN documento ───────────────────────────────────

export interface EnrichOneResult {
  text_resumido?: string;
  por_tanto_text?: string;
  decision_inferida?: string;
  tokens_in: number;
  tokens_out: number;
}

export async function enrichOneDoc(args: {
  doc: DocRow;
  dry_run?: boolean;
  llm?: LlmCaller;
}): Promise<EnrichOneResult> {
  const { doc, dry_run = false } = args;
  const llm = args.llm ?? defaultLlmCall;
  const text = doc.text_extracted ?? '';
  const result: EnrichOneResult = { tokens_in: 0, tokens_out: 0 };

  // 1) POR TANTO regex (sin LLM)
  let porTanto: string | null = null;
  if ((doc.text_chars ?? text.length) >= MIN_TEXT_CHARS_POR_TANTO && doc.por_tanto_text == null) {
    porTanto = extractPorTanto(text, doc.tipo ?? undefined);
    if (porTanto) {
      result.por_tanto_text = porTanto;
    }
  }

  // 2) Resumen LLM (todos con text_chars > 500)
  if ((doc.text_chars ?? text.length) >= MIN_TEXT_CHARS_RESUMEN && doc.text_resumido == null) {
    if (!dry_run) {
      const callRes = await llm({
        systemPrompt: RESUMEN_SYSTEM,
        userPrompt: buildResumenUserPrompt(doc),
        model: RESUMEN_MODEL,
        maxTokens: MAX_RESUMEN_TOKENS,
        jsonMode: true,
      });
      result.tokens_in += callRes.tokens_in;
      result.tokens_out += callRes.tokens_out;
      try {
        result.text_resumido = parseResumen(callRes.content);
      } catch (err) {
        logger.warn('enrich_resumen_parse_failed', { doc_id: doc.id, raw: callRes.content.slice(0, 300) });
        throw err;
      }
    } else {
      result.text_resumido = '[DRY_RUN]';
    }
  }

  // 3) Decisión LLM (solo si tenemos POR TANTO — recién extraído o ya en DB)
  const porTantoForDecision = porTanto ?? doc.por_tanto_text;
  if (porTantoForDecision && doc.decision_inferida == null) {
    if (!dry_run) {
      const callRes = await llm({
        systemPrompt: DECISION_SYSTEM,
        userPrompt: buildDecisionUserPrompt(porTantoForDecision),
        model: DECISION_MODEL,
        maxTokens: 50,
        jsonMode: true,
      });
      result.tokens_in += callRes.tokens_in;
      result.tokens_out += callRes.tokens_out;
      result.decision_inferida = parseDecision(callRes.content);
    } else {
      result.decision_inferida = 'indeterminado';
    }
  }

  return result;
}

// ── Función principal — orquestador ──────────────────────────────────────────

export async function runLlmEnrichDocs(
  opts: LlmEnrichScope = {},
  llmOverride?: LlmCaller,
): Promise<LlmEnrichResult> {
  const startMs = Date.now();
  const dry = opts.dry_run ?? false;
  const concurrency = opts.concurrency ?? 5;
  // Default a 50 (era 200). PostgreSQL tiraba "statement timeout" al paginar
  // sobre `sil_documentos` (22.4k filas) con select * + WHERE filter complejos.
  // 50 es trade-off entre round-trips y evitar el timeout. Override via opts.
  const pageSize = opts.page_size ?? 50;
  const result: LlmEnrichResult = {
    docs_evaluados: 0,
    docs_resumen_generado: 0,
    docs_por_tanto_extraido: 0,
    docs_decision_inferida: 0,
    docs_skipped_sin_texto: 0,
    errors: 0,
    duration_ms: 0,
    tokens_in_total: 0,
    tokens_out_total: 0,
  };

  logger.info('llm_enrich_start', { dry_run: dry, limit: opts.limit, concurrency, page_size: pageSize });

  const sb = supa();
  const limit = pLimit(concurrency);

  // Paginar por id para no traer 22k filas a memoria.
  let lastId: string | null = null;
  let processed = 0;
  const totalCap = opts.limit ?? Infinity;

  while (processed < totalCap) {
    // Build query: solo rows pendientes (text_resumido null + text_chars > 0)
    let q = sb
      .from('sil_documentos')
      .select('id, expediente_id, tipo, titulo, text_extracted, text_chars, text_resumido, por_tanto_text, decision_inferida')
      .is('text_resumido', null)
      .gt('text_chars', 0)
      .order('id', { ascending: true })
      .limit(Math.min(pageSize, totalCap - processed));
    if (lastId) q = q.gt('id', lastId);
    if (opts.tipo_filter && opts.tipo_filter.length > 0) q = q.in('tipo', opts.tipo_filter);

    const { data, error } = await q;
    if (error) {
      logger.error('llm_enrich_page_failed', { error: error.message });
      throw new Error(`page query failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    lastId = (data[data.length - 1] as any).id;

    const tasks = (data as DocRow[]).map((doc) =>
      limit(async () => {
        try {
          if (!doc.text_extracted || (doc.text_chars ?? 0) === 0) {
            result.docs_skipped_sin_texto++;
            return;
          }
          const enrich = await enrichOneDoc({ doc, dry_run: dry, llm: llmOverride });
          result.docs_evaluados++;
          result.tokens_in_total += enrich.tokens_in;
          result.tokens_out_total += enrich.tokens_out;

          if (enrich.por_tanto_text) result.docs_por_tanto_extraido++;
          if (enrich.text_resumido && enrich.text_resumido !== '[DRY_RUN]') result.docs_resumen_generado++;
          if (enrich.decision_inferida && !dry) result.docs_decision_inferida++;

          if (!dry) {
            // Split en dos updates: (1) resumen + por_tanto (sin constraint
            // CHECK), (2) decision_inferida (con constraint). Así si la
            // constraint rechaza la etiqueta nueva (en_tramite/aprobado/
            // etc., antes de aplicar 0044) al menos persiste el resumen.
            const updateMain: Record<string, unknown> = { updated_at: new Date().toISOString() };
            if (enrich.text_resumido !== undefined) updateMain.text_resumido = enrich.text_resumido;
            if (enrich.por_tanto_text !== undefined) updateMain.por_tanto_text = enrich.por_tanto_text;
            if (Object.keys(updateMain).length > 1) {
              const { error: upErr } = await sb.from('sil_documentos').update(updateMain).eq('id', doc.id);
              if (upErr) {
                logger.warn('llm_enrich_persist_main_failed', { doc_id: doc.id, error: upErr.message });
                result.errors++;
              }
            }
            if (enrich.decision_inferida !== undefined) {
              const { error: upErrDec } = await sb
                .from('sil_documentos')
                .update({ decision_inferida: enrich.decision_inferida })
                .eq('id', doc.id);
              if (upErrDec) {
                logger.warn('llm_enrich_persist_decision_failed', {
                  doc_id: doc.id,
                  decision: enrich.decision_inferida,
                  error: upErrDec.message,
                });
                // No incrementamos errors — el doc principal sí persistió.
              }
            }
          }
        } catch (err) {
          result.errors++;
          logger.warn('llm_enrich_one_failed', {
            doc_id: doc.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await Promise.all(tasks);
    processed += data.length;
    logger.info('llm_enrich_page_done', {
      processed,
      page: data.length,
      ok: result.docs_evaluados,
      errors: result.errors,
      tokens_in: result.tokens_in_total,
      tokens_out: result.tokens_out_total,
    });

    if (data.length < pageSize) break;
  }

  result.duration_ms = Date.now() - startMs;
  logger.info("llm_enrich_complete", { ...result });
  return result;
}

// ── Helpers exportados para tests ────────────────────────────────────────────

export function _resetSupaClient(): void {
  _supa = null;
}
