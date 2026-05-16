/**
 * generateResumenMixto.ts — Sprint 3 Track P.
 *
 * Genera el resumen editorial 3-párrafos por expediente:
 *   1. Contexto: qué propone, quién, en qué etapa.
 *   2. Posturas: dictámenes mayoría/minoría, Sala IV, audiencias relevantes.
 *   3. Próximos pasos: qué falta para ley o archivo, plazos, riesgos.
 *
 * Cada bloque cita su fuente (tipo + fecha + URL). La output va a
 * `cl2_resumenes` (resumen_md + fuentes_citadas jsonb). Idempotente
 * por expediente_id.
 *
 * Doctrina LLM-vs-Algoritmo: este job es LLM puro porque la voz editorial
 * y la síntesis de múltiples fuentes son criterios subjetivos.
 *
 * Modelo:
 *   - Default: 'openrouter/anthropic/claude-3.7-sonnet' (mejor calidad
 *     para narrativa con citas). Fallback configurable.
 *   - Override: env CL2_EDITORIAL_RESUMEN_MODEL.
 *
 * Refresh policy:
 *   refresh_after = generated_at + 7 días. El job sólo procesa expedientes
 *   con refresh_after en el pasado (o sin resumen aún).
 *
 * Mock-friendly: `generateOneResumen()` es pura (recibe data + LLM caller).
 * `runGenerateResumenes()` arma Supabase + LLM real.
 *
 * Author: Jred / Claude Code — 2026-05-16
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';
import { withRetry, withTimeout, ResilienceError } from '../services/resilience.js';

// ── Tipos públicos ───────────────────────────────────────────────────────────

export interface ResumenScope {
  scope?: 'watchlist' | 'all';
  limit?: number;
  /** Por defecto 7 días. */
  refresh_days?: number;
  /** Si true, regenera incluso los frescos. Para emergencias. */
  force?: boolean;
}

export interface ResumenResult {
  expedientes_evaluados: number;
  resumenes_generados: number;
  resumenes_skipped_fresh: number;
  errors: number;
  duration_ms: number;
}

export interface FuenteCitada {
  tipo: string; // 'texto_sustitutivo' | 'dictamen' | 'sala' | 'acta' | ...
  fecha?: string;
  url?: string;
  fragmento_citado?: string;
}

export interface LlmResumenOutput {
  resumen_md: string;
  fuentes_citadas: FuenteCitada[];
  tokens_in: number;
  tokens_out: number;
}

export type LlmResumenCaller = (args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}) => Promise<{ content: string; tokens_in: number; tokens_out: number }>;

// ── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL =
  process.env.CL2_EDITORIAL_RESUMEN_MODEL ?? 'openrouter/anthropic/claude-3.7-sonnet';
const PROMPT_VERSION = 'v1';
const REFRESH_DAYS_DEFAULT = 7;
const BATCH_SIZE = 5; // resumen tarda más → menos paralelo
const OR_TIMEOUT_MS = 120_000; // 2 min, narrativa larga
const OR_RETRY_ATTEMPTS = 2;
const OR_RETRY_BASE_MS = 1000;
const OR_BASE = 'https://openrouter.ai/api/v1';
const MAX_OUTPUT_TOKENS = 1200;

// ── Supabase lazy client ─────────────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'supabase env missing for generateResumenMixto (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Tipos internos ───────────────────────────────────────────────────────────

interface ExpedienteData {
  numero: string;
  titulo: string | null;
  resumen: string | null;
  tipo: string | null;
  proponente: string | null;
  estado: string | null;
  comision: string | null;
  fecha_presentacion: string | null;
  tramite: unknown[];
  documentos: unknown[];
  audiencias: unknown[];
  actas: unknown[];
  sala: unknown[];
  ordenDia: unknown[];
  fechas: unknown[];
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'Sos un consultor de asuntos públicos en Costa Rica trabajando para CL2 Consultoría.',
  'Tu tarea: generar un resumen editorial de un expediente legislativo, en 3 párrafos.',
  '',
  'Estructura OBLIGATORIA:',
  '  **Contexto**: qué propone el expediente, quién lo propone, en qué etapa está. (1 párrafo)',
  '  **Posturas**: dictámenes mayoría/minoría, consultas a Sala IV, posiciones de comisiones, audiencias relevantes. (1 párrafo)',
  '  **Próximos pasos**: qué falta para que sea ley o se archive. Plazos estimados. Riesgos. (1 párrafo)',
  '',
  'Reglas de citado:',
  '  - Citá cada bloque indicando el documento fuente (tipo + fecha + URL).',
  '  - Inline, formato: `(dictamen mayoría, 2024-08-15)` o `(Sala IV res 2024-009856)`.',
  '  - Si no tenés fuente para un punto, decí explícitamente "sin documento que respalde".',
  '',
  'Tono:',
  '  - Editorial sobrio. Cero marketing. Cero hype.',
  '  - Español neutro, sin coloquialismos. Voz tercera persona.',
  '  - No exageres. Si el expediente está atascado, decilo.',
  '',
  'Formato de salida (JSON estricto, sin markdown fences):',
  '```',
  '{"resumen_md": "**Contexto**: ...\\n\\n**Posturas**: ...\\n\\n**Próximos pasos**: ...", "fuentes_citadas": [{"tipo": "texto_sustitutivo", "fecha": "2024-08-15", "url": "...", "fragmento_citado": "..."}]}',
  '```',
  '',
  'Tope: resumen_md ≤ 800 tokens. fuentes_citadas: array de las fuentes que efectivamente citaste inline.',
].join('\n');

// Render compacto del expediente para meterlo en el prompt.
// Pasamos JSON estructurado: el LLM lee y elige qué citar.
function buildUserPrompt(data: ExpedienteData): string {
  // Compactar — solo lo relevante para el resumen, no toda la metadata.
  const snapshot = {
    numero: data.numero,
    titulo: data.titulo,
    tipo: data.tipo,
    proponente: data.proponente,
    estado: data.estado,
    comision: data.comision,
    fecha_presentacion: data.fecha_presentacion,
    resumen_estructural: data.resumen,
    tramite_reciente: data.tramite.slice(-8),
    documentos_clave: pickDocsClave(data.documentos),
    audiencias: data.audiencias.slice(0, 10),
    actas_recientes: data.actas.slice(0, 5),
    consultas_sala: data.sala,
    orden_dia: data.ordenDia.slice(0, 6),
    fechas_extraidas: data.fechas,
  };
  return [
    'EXPEDIENTE — datos crudos:',
    '```json',
    JSON.stringify(snapshot, null, 2).slice(0, 30_000), // hard cap por seguridad
    '```',
    '',
    'Generá el resumen editorial.',
  ].join('\n');
}

function pickDocsClave(docs: unknown[]): unknown[] {
  // Prefiere texto_sustitutivo, dictamen_mayoria, dictamen_minoria primero;
  // luego mociones.
  const PRIORITY: Record<string, number> = {
    texto_sustitutivo: 0,
    dictamen_mayoria: 1,
    dictamen_minoria: 2,
    mocion_177: 3,
    mocion_137_segundo_dia: 4,
  };
  const sorted = [...docs].sort((a, b) => {
    const ta = String((a as Record<string, unknown>).tipo ?? '');
    const tb = String((b as Record<string, unknown>).tipo ?? '');
    const pa = PRIORITY[ta] ?? 99;
    const pb = PRIORITY[tb] ?? 99;
    return pa - pb;
  });
  return sorted.slice(0, 8);
}

// ── LLM caller real ──────────────────────────────────────────────────────────

async function defaultLlmCall(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}): Promise<{ content: string; tokens_in: number; tokens_out: number }> {
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
              'X-Title': 'Shift CL2 Editorial',
            },
            body: JSON.stringify({
              model: args.model,
              messages: [
                { role: 'system', content: args.systemPrompt },
                { role: 'user', content: args.userPrompt },
              ],
              max_tokens: MAX_OUTPUT_TOKENS,
              temperature: 0.3,
              response_format: { type: 'json_object' },
            }),
            signal,
          }),
        { ms: OR_TIMEOUT_MS, label: 'editorial:resumen' },
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
    { attempts: OR_RETRY_ATTEMPTS, baseDelayMs: OR_RETRY_BASE_MS, label: 'editorial:resumen' },
  );
}

// ── Parser ───────────────────────────────────────────────────────────────────

export function parseResumenLlm(raw: string): { resumen_md: string; fuentes: FuenteCitada[] } {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  let parsed: unknown = tryParse(raw);
  if (!parsed) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fence) parsed = tryParse(fence[1]!);
  }
  if (!parsed) {
    const open = raw.indexOf('{');
    const close = raw.lastIndexOf('}');
    if (open >= 0 && close > open) parsed = tryParse(raw.slice(open, close + 1));
  }
  if (!parsed) throw new Error('resumen_llm_invalid_json');

  const obj = parsed as { resumen_md?: unknown; fuentes_citadas?: unknown };
  const resumen_md = typeof obj.resumen_md === 'string' ? obj.resumen_md.trim() : '';
  if (!resumen_md) throw new Error('resumen_llm_missing_resumen_md');

  const fuentes: FuenteCitada[] = [];
  if (Array.isArray(obj.fuentes_citadas)) {
    for (const raw of obj.fuentes_citadas) {
      const r = raw as Record<string, unknown>;
      const tipo = typeof r.tipo === 'string' ? r.tipo : '';
      if (!tipo) continue;
      const f: FuenteCitada = { tipo };
      if (typeof r.fecha === 'string') f.fecha = r.fecha;
      if (typeof r.url === 'string') f.url = r.url;
      if (typeof r.fragmento_citado === 'string') {
        f.fragmento_citado = r.fragmento_citado.slice(0, 600);
      }
      fuentes.push(f);
    }
  }
  return { resumen_md, fuentes };
}

// ── Función pura — generar UN resumen ────────────────────────────────────────

export async function generateOneResumen(args: {
  expediente: ExpedienteData;
  model?: string;
  llm?: LlmResumenCaller;
}): Promise<LlmResumenOutput> {
  const model = args.model ?? DEFAULT_MODEL;
  const llm = args.llm ?? defaultLlmCall;
  const userPrompt = buildUserPrompt(args.expediente);
  const { content, tokens_in, tokens_out } = await llm({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    model,
  });
  const { resumen_md, fuentes } = parseResumenLlm(content);
  return {
    resumen_md,
    fuentes_citadas: fuentes,
    tokens_in,
    tokens_out,
  };
}

// ── Helpers Supabase ─────────────────────────────────────────────────────────

async function loadWatchlistNumeros(sb: SupabaseClient): Promise<string[]> {
  const { data, error } = await sb
    .from('centinela_watchlist')
    .select('entity_id')
    .eq('entity_type', 'expediente');
  if (error) throw new Error(`loadWatchlist: ${error.message}`);
  const set = new Set<string>();
  for (const r of (data ?? []) as Array<{ entity_id: string }>) {
    if (r.entity_id) set.add(r.entity_id.trim());
  }
  return [...set];
}

async function loadExpedienteData(
  sb: SupabaseClient,
  numero: string,
): Promise<ExpedienteData | null> {
  // Pull en paralelo. Si una tabla auxiliar no existe (no migrada), graceful
  // degradation a array vacío.
  const safe = async <T>(p: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> => {
    try {
      const r = await p;
      if (r.error) return [];
      return r.data ?? [];
    } catch {
      return [];
    }
  };

  const [general, tramite, documentos, audiencias, actas, sala, ordenDia, fechas] =
    await Promise.all([
      sb.from('sil_expedientes').select('*').eq('numero', numero).maybeSingle(),
      sb
        .from('sil_expediente_tramite')
        .select('*')
        .eq('expediente_id', numero)
        .order('fecha_inicio', { ascending: true }),
      sb
        .from('sil_expediente_documentos')
        .select('*')
        .eq('expediente_id', numero)
        .order('tipo', { ascending: true }),
      safe(
        sb
          .from('sil_expediente_audiencias')
          .select('*')
          .eq('expediente_id', numero)
          .order('fecha', { ascending: true }),
      ),
      safe(
        sb
          .from('sil_expediente_actas_indexadas')
          .select('*')
          .eq('expediente_id', numero)
          .order('fecha_sesion', { ascending: false }),
      ),
      safe(
        sb
          .from('sil_expediente_consultas_sala')
          .select('*')
          .eq('expediente_id', numero)
          .order('fecha_resolucion', { ascending: false }),
      ),
      safe(
        sb
          .from('sil_expediente_orden_dia_apariciones')
          .select('*')
          .eq('expediente_id', numero)
          .order('fecha_sesion', { ascending: false }),
      ),
      safe(
        sb.from('sil_expediente_fechas_vigentes').select('*').eq('expediente_id', numero),
      ),
    ]);

  if (general.error || !general.data) return null;
  const g = general.data as Record<string, unknown>;
  return {
    numero,
    titulo: (g.titulo as string | null) ?? null,
    resumen: (g.resumen as string | null) ?? null,
    tipo: (g.tipo as string | null) ?? null,
    proponente: (g.proponente as string | null) ?? null,
    estado: (g.estado as string | null) ?? null,
    comision: (g.comision as string | null) ?? null,
    fecha_presentacion: (g.fecha_presentacion as string | null) ?? null,
    tramite: (tramite.data ?? []) as unknown[],
    documentos: (documentos.data ?? []) as unknown[],
    audiencias: audiencias as unknown[],
    actas: actas as unknown[],
    sala: sala as unknown[],
    ordenDia: ordenDia as unknown[],
    fechas: fechas as unknown[],
  };
}

// ── Función principal ────────────────────────────────────────────────────────

export async function runGenerateResumenes(
  opts: ResumenScope = {},
  llmOverride?: LlmResumenCaller,
): Promise<ResumenResult> {
  const startMs = Date.now();
  const scope = opts.scope ?? 'watchlist';
  const refreshDays = opts.refresh_days ?? REFRESH_DAYS_DEFAULT;
  const force = opts.force ?? false;
  const result: ResumenResult = {
    expedientes_evaluados: 0,
    resumenes_generados: 0,
    resumenes_skipped_fresh: 0,
    errors: 0,
    duration_ms: 0,
  };

  logger.info('resumen_mixto_start', { scope, refresh_days: refreshDays, force });

  const sb = supa();

  // 1. Lista de candidatos.
  let candidatos: string[] = [];
  if (scope === 'watchlist') {
    candidatos = await loadWatchlistNumeros(sb);
  } else {
    const { data, error } = await sb
      .from('sil_expedientes')
      .select('numero')
      .not('titulo', 'is', null)
      .limit(opts.limit ?? 1000);
    if (error) throw new Error(`loadAll: ${error.message}`);
    candidatos = ((data ?? []) as Array<{ numero: string }>).map((r) => r.numero);
  }
  if (opts.limit && opts.limit > 0) candidatos = candidatos.slice(0, opts.limit);

  if (candidatos.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.info('resumen_mixto_no_candidates', { scope });
    return result;
  }

  // 2. Filtrar los frescos (resumen reciente con refresh_after > now).
  const nowIso = new Date().toISOString();
  const { data: existing } = await sb
    .from('cl2_resumenes')
    .select('expediente_id, refresh_after')
    .in('expediente_id', candidatos);
  const freshSet = new Set<string>();
  if (!force) {
    for (const r of (existing ?? []) as Array<{ expediente_id: string; refresh_after: string | null }>) {
      if (r.refresh_after && r.refresh_after > nowIso) {
        freshSet.add(r.expediente_id);
      }
    }
  }
  const todo = candidatos.filter((n) => !freshSet.has(n));
  result.resumenes_skipped_fresh = candidatos.length - todo.length;

  // 3. Procesar en batches.
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);

    const settles = await Promise.allSettled(
      batch.map(async (numero) => {
        const data = await loadExpedienteData(sb, numero);
        if (!data) throw new Error('expediente_not_found');
        const out = await generateOneResumen({ expediente: data, llm: llmOverride });
        return { numero, out };
      }),
    );

    for (const settle of settles) {
      if (settle.status === 'rejected') {
        result.errors++;
        result.expedientes_evaluados++;
        logger.warn('resumen_one_failed', {
          error: (settle.reason as Error)?.message ?? String(settle.reason),
        });
        continue;
      }
      const { numero, out } = settle.value;
      result.expedientes_evaluados++;

      const refreshAfter = new Date(
        Date.now() + refreshDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      const { error: upErr } = await sb.from('cl2_resumenes').upsert(
        {
          expediente_id: numero,
          resumen_md: out.resumen_md,
          fuentes_citadas: out.fuentes_citadas,
          modelo: DEFAULT_MODEL,
          prompt_version: PROMPT_VERSION,
          tokens_in: out.tokens_in,
          tokens_out: out.tokens_out,
          generated_at: new Date().toISOString(),
          refresh_after: refreshAfter,
        },
        { onConflict: 'expediente_id' },
      );

      if (upErr) {
        result.errors++;
        logger.warn('resumen_persist_failed', { numero, error: upErr.message });
        continue;
      }
      result.resumenes_generados++;
    }
  }

  result.duration_ms = Date.now() - startMs;
  logger.info('resumen_mixto_complete', { ...result, scope });
  return result;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetSupaClient(): void {
  _supa = null;
}
