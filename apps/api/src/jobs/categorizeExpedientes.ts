/**
 * categorizeExpedientes.ts — Sprint 3 Track P.
 *
 * Job que clasifica expedientes en N de las 51 categorías canónicas CL2
 * usando LLM (criterios subjetivos → doctrina LLM-vs-Algoritmo del cl2-brain).
 *
 * Flujo:
 *   1. Listar categorías vigentes (slug + nombre + area + descripcion).
 *   2. Listar expedientes pendientes:
 *        - target: rows en `sil_expedientes` con título + resumen no nulos
 *        - filtro: NO tienen ninguna fila en cl2_expediente_categorias
 *                  O tienen rows con classified_at < (now() - 7 days).
 *        - scope: por default sólo los que están en watchlist activa de
 *                 cualquier user. Si caller pasa `scope: 'all'`, todos.
 *   3. Procesar en batches de 10 expedientes (rate limit OpenRouter).
 *   4. Para cada expediente, llamar al LLM con el prompt v1 (debajo).
 *   5. Upsert por (expediente_id, categoria_id). Idempotente.
 *
 * Modelo:
 *   - Default: 'anthropic/claude-haiku-4.5' (barato; clasificación
 *     no requiere razonamiento profundo).
 *   - Override: env CL2_EDITORIAL_CAT_MODEL.
 *
 * Mock-friendly: la función `categorizeOneExpediente()` es pura (recibe
 * data + llm caller). El cron-helper `runCategorize()` arma el supabase
 * + el real LLM call y lo pasa.
 *
 * Author: Jred / Claude Code — 2026-05-16
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';
import { withRetry, withTimeout, ResilienceError } from '../services/resilience.js';

// ── Tipos públicos ───────────────────────────────────────────────────────────

export interface CategorizeScope {
  /** 'watchlist' (default) sólo expedientes en alguna watchlist activa.
   *  'all' sobre todos los expedientes con título + resumen. */
  scope?: 'watchlist' | 'all';
  /** Si está set, limita el batch total a N expedientes. Útil para tests. */
  limit?: number;
  /** Por defecto 7 días. Expedientes clasificados más recientes se saltean. */
  freshness_days?: number;
}

export interface CategorizeResult {
  expedientes_evaluados: number;
  expedientes_skipped_fresh: number;
  clasificaciones_insertadas: number;
  clasificaciones_skipped_dup: number;
  errors: number;
  duration_ms: number;
}

/** Resultado tipado del LLM por expediente. */
export interface LlmCategoriaPick {
  slug: string;
  confidence: number;
  razon: string;
}

/** Caller LLM inyectable para testing. */
export type LlmJsonCaller = (args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}) => Promise<string>;

// ── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL =
  process.env.CL2_EDITORIAL_CAT_MODEL ?? 'anthropic/claude-haiku-4.5';
const BATCH_SIZE = 10;
const FRESHNESS_DAYS_DEFAULT = 7;
const OR_TIMEOUT_MS = 60_000;
const OR_RETRY_ATTEMPTS = 2;
const OR_RETRY_BASE_MS = 800;
const OR_BASE = 'https://openrouter.ai/api/v1';

// ── Supabase lazy client ─────────────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'supabase env missing for categorizeExpedientes (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Tipos internos ───────────────────────────────────────────────────────────

interface CategoriaRow {
  id: string;
  slug: string;
  nombre: string;
  area: string;
  descripcion: string | null;
}

interface ExpedienteRow {
  numero: string;
  titulo: string | null;
  /** Resumen extraído de `extras` jsonb (no es columna dedicada en
   *  sil_expedientes — fix 2026-05-16). El SIL web-scraper guarda un
   *  resumen del expediente en `extras.resumen` si el campo está visible
   *  en la página del SIL. Si no hay, el LLM categoriza solo con título
   *  + proponente + tipo (suficiente para la mayoría de casos). */
  resumen: string | null;
  tipo: string | null;
  proponente: string | null;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(categorias: CategoriaRow[]): string {
  const catalogo = categorias
    .map((c) => `  • ${c.slug} — ${c.nombre} (${c.area})${c.descripcion ? `: ${c.descripcion}` : ''}`)
    .join('\n');

  return [
    'Sos un analista de asuntos públicos en Costa Rica trabajando para CL2 Consultoría.',
    'Tu tarea: clasificar un expediente legislativo en hasta 3 categorías de la taxonomía CL2.',
    '',
    'Devolvé JSON estricto con esta forma EXACTA:',
    '```',
    '{"categorias": [{"slug": "...", "confidence": 0.0, "razon": "..."}]}',
    '```',
    '',
    'Reglas:',
    '  1. confidence va de 0.0 a 1.0. Usá ≥ 0.85 sólo si el match es obvio.',
    '  2. razon: 1 oración corta (máx 20 palabras) explicando por qué aplica.',
    '  3. slug DEBE existir en el catálogo de abajo. No inventes slugs.',
    '  4. Si el expediente toca múltiples áreas, listalas ordenadas por confidence desc.',
    '  5. Mínimo 1 categoría. Máximo 3.',
    '  6. NO incluyas texto fuera del JSON. NO uses markdown fences.',
    '',
    'Catálogo CL2 (51 categorías):',
    catalogo,
  ].join('\n');
}

function buildUserPrompt(exp: ExpedienteRow): string {
  return [
    `EXPEDIENTE: ${exp.numero}`,
    `TIPO: ${exp.tipo ?? 'no especificado'}`,
    `TÍTULO: ${exp.titulo ?? '(sin título)'}`,
    `PROPONENTE: ${exp.proponente ?? 'no registrado'}`,
    '',
    'RESUMEN:',
    exp.resumen ?? '(sin resumen)',
    '',
    'Clasificá este expediente.',
  ].join('\n');
}

// ── LLM caller real (OpenRouter chat completions) ────────────────────────────

async function defaultLlmCall(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}): Promise<string> {
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
              max_tokens: 600,
              temperature: 0.2,
              response_format: { type: 'json_object' },
            }),
            signal,
          }),
        { ms: OR_TIMEOUT_MS, label: 'editorial:categorize' },
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
      };
      return json?.choices?.[0]?.message?.content ?? '';
    },
    { attempts: OR_RETRY_ATTEMPTS, baseDelayMs: OR_RETRY_BASE_MS, label: 'editorial:categorize' },
  );
}

// ── Parser tolerante ─────────────────────────────────────────────────────────

export function parseCategoriasLlm(raw: string): LlmCategoriaPick[] {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  let parsed: unknown = tryParse(raw);
  if (!parsed) {
    // Recover from markdown fences.
    const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fence) parsed = tryParse(fence[1]!);
  }
  if (!parsed) {
    // Last resort: extract first { ... }.
    const open = raw.indexOf('{');
    const close = raw.lastIndexOf('}');
    if (open >= 0 && close > open) parsed = tryParse(raw.slice(open, close + 1));
  }
  if (!parsed) throw new Error('categorize_llm_invalid_json');

  const obj = parsed as { categorias?: unknown };
  if (!Array.isArray(obj.categorias)) throw new Error('categorize_llm_missing_categorias');

  const picks: LlmCategoriaPick[] = [];
  for (const raw of obj.categorias as unknown[]) {
    const r = raw as Record<string, unknown>;
    const slug = typeof r.slug === 'string' ? r.slug.trim() : '';
    const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
    const razon = typeof r.razon === 'string' ? r.razon.trim().slice(0, 280) : '';
    if (!slug) continue;
    if (confidence < 0 || confidence > 1) continue;
    picks.push({ slug, confidence, razon });
  }
  return picks.slice(0, 3); // cap a 3
}

// ── Función pura — clasificar UN expediente ──────────────────────────────────
// Recibe data + LLM caller, devuelve picks. Sin side effects.
// Útil para tests + reutilizable en otros contextos.

export async function categorizeOneExpediente(args: {
  expediente: ExpedienteRow;
  categorias: CategoriaRow[];
  model?: string;
  llm?: LlmJsonCaller;
}): Promise<LlmCategoriaPick[]> {
  const model = args.model ?? DEFAULT_MODEL;
  const llm = args.llm ?? defaultLlmCall;
  const systemPrompt = buildSystemPrompt(args.categorias);
  const userPrompt = buildUserPrompt(args.expediente);

  const raw = await llm({ systemPrompt, userPrompt, model });
  const picks = parseCategoriasLlm(raw);

  // Filtrar slugs que no existen en el catálogo (el LLM puede alucinar).
  const validSlugs = new Set(args.categorias.map((c) => c.slug));
  return picks.filter((p) => validSlugs.has(p.slug));
}

// ── Helpers de query Supabase ────────────────────────────────────────────────

async function loadCategorias(sb: SupabaseClient): Promise<CategoriaRow[]> {
  const { data, error } = await sb
    .from('cl2_categorias')
    .select('id, slug, nombre, area, descripcion')
    .eq('vigente', true)
    .order('area', { ascending: true });
  if (error) throw new Error(`loadCategorias: ${error.message}`);
  return (data ?? []) as CategoriaRow[];
}

async function loadWatchlistExpedienteNumeros(sb: SupabaseClient): Promise<string[]> {
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

async function loadCandidates(
  sb: SupabaseClient,
  scope: 'watchlist' | 'all',
  limit: number | undefined,
): Promise<ExpedienteRow[]> {
  // NO hay columna `resumen` en `sil_expedientes`. El resumen vive en
  // `extras` jsonb si el SIL lo expone. Seleccionamos `extras` completo
  // y extraemos en JS. Fix 2026-05-16 — el código original asumía una
  // columna que nunca existió.
  let query = sb
    .from('sil_expedientes')
    .select('numero, titulo, extras, tipo, proponente')
    .not('titulo', 'is', null);

  if (scope === 'watchlist') {
    const nums = await loadWatchlistExpedienteNumeros(sb);
    if (nums.length === 0) return [];
    query = query.in('numero', nums);
  }
  if (limit && limit > 0) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`loadCandidates: ${error.message}`);

  // Mapear `extras.resumen` (si existe) al campo `resumen` de la row.
  return (data ?? []).map((r: Record<string, unknown>) => {
    const extras = (r.extras ?? {}) as Record<string, unknown>;
    const resumen = typeof extras.resumen === 'string' ? extras.resumen : null;
    return {
      numero: r.numero as string,
      titulo: r.titulo as string | null,
      resumen,
      tipo: r.tipo as string | null,
      proponente: r.proponente as string | null,
    };
  });
}

/**
 * Para un set de expedientes, devuelve cuáles tienen clasificación reciente
 * (classified_at >= now() - freshness_days). Esos se saltean.
 */
async function loadFreshExpedientes(
  sb: SupabaseClient,
  numeros: string[],
  freshnessDays: number,
): Promise<Set<string>> {
  if (numeros.length === 0) return new Set();
  const cutoff = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('cl2_expediente_categorias')
    .select('expediente_id, classified_at')
    .in('expediente_id', numeros)
    .gte('classified_at', cutoff);
  if (error) throw new Error(`loadFresh: ${error.message}`);
  const fresh = new Set<string>();
  for (const r of (data ?? []) as Array<{ expediente_id: string }>) {
    fresh.add(r.expediente_id);
  }
  return fresh;
}

// ── Función principal ────────────────────────────────────────────────────────

/**
 * Corre una pasada completa de clasificación.
 *
 * Errores:
 *   - Fatales (no se pudo listar categorías/expedientes) → throw.
 *   - Per-expediente → log warn + result.errors++ + continue.
 */
export async function runCategorizeExpedientes(
  opts: CategorizeScope = {},
  llmOverride?: LlmJsonCaller,
): Promise<CategorizeResult> {
  const startMs = Date.now();
  const scope = opts.scope ?? 'watchlist';
  const freshnessDays = opts.freshness_days ?? FRESHNESS_DAYS_DEFAULT;
  const result: CategorizeResult = {
    expedientes_evaluados: 0,
    expedientes_skipped_fresh: 0,
    clasificaciones_insertadas: 0,
    clasificaciones_skipped_dup: 0,
    errors: 0,
    duration_ms: 0,
  };

  logger.info('categorize_expedientes_start', { scope, freshness_days: freshnessDays });

  const sb = supa();
  const categorias = await loadCategorias(sb);
  if (categorias.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.warn('categorize_expedientes_no_categorias', {});
    return result;
  }
  const slugToId = new Map(categorias.map((c) => [c.slug, c.id]));

  const candidates = await loadCandidates(sb, scope, opts.limit);
  if (candidates.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.info('categorize_expedientes_no_candidates', { scope });
    return result;
  }

  const freshSet = await loadFreshExpedientes(
    sb,
    candidates.map((c) => c.numero),
    freshnessDays,
  );

  // Filtrar fresh + dejar sólo los que necesitan trabajo.
  const todo = candidates.filter((c) => !freshSet.has(c.numero));
  result.expedientes_skipped_fresh = candidates.length - todo.length;

  // Procesar en batches.
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);

    // Concurrencia por batch: 10 a la vez. Promise.allSettled para no
    // tumbar el batch entero si uno falla.
    const settles = await Promise.allSettled(
      batch.map(async (exp) => {
        const picks = await categorizeOneExpediente({
          expediente: exp,
          categorias,
          llm: llmOverride,
        });
        return { numero: exp.numero, picks };
      }),
    );

    for (const settle of settles) {
      if (settle.status === 'rejected') {
        result.errors++;
        result.expedientes_evaluados++;
        logger.warn('categorize_expediente_failed', {
          error: (settle.reason as Error)?.message ?? String(settle.reason),
        });
        continue;
      }
      const { numero, picks } = settle.value;
      result.expedientes_evaluados++;

      if (picks.length === 0) continue;

      // Upsert N rows. Idempotente por (expediente_id, categoria_id).
      const rows = picks
        .map((p) => {
          const cid = slugToId.get(p.slug);
          if (!cid) return null;
          return {
            expediente_id: numero,
            categoria_id: cid,
            confidence: p.confidence,
            razon_llm: p.razon,
            metodo: 'llm' as const,
            classified_at: new Date().toISOString(),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length === 0) continue;

      const { data: inserted, error: insErr } = await sb
        .from('cl2_expediente_categorias')
        .upsert(rows, { onConflict: 'expediente_id,categoria_id' })
        .select('id');

      if (insErr) {
        result.errors++;
        logger.warn('categorize_persist_failed', {
          numero,
          error: insErr.message,
        });
        continue;
      }
      // upsert con onConflict actualiza/inserta — todas las filas devueltas
      // representan operaciones exitosas. No tenemos un buen proxy para
      // "skipped_dup" porque upsert siempre escribe (update or insert), así
      // que contamos todo como "inserted/updated".
      result.clasificaciones_insertadas += (inserted ?? []).length;
    }
  }

  result.duration_ms = Date.now() - startMs;
  logger.info('categorize_expedientes_complete', {
    ...result,
    scope,
    freshness_days: freshnessDays,
  });
  return result;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetSupaClient(): void {
  _supa = null;
}
