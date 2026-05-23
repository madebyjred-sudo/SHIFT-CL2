/**
 * tokenAccounting — contador certero de tokens LLM por usuario.
 *
 * SOURCE OF TRUTH:
 *   ai_call_log (migration 0017 + 0048). Una fila por llamada billable.
 *   user_id = auth.uid() del Supabase Auth del usuario que disparó la
 *   acción. route = string corto que identifica el callsite (workspace.
 *   transform, chat.stream, transcript.gemini, etc.).
 *
 * COVERAGE OBJETIVO:
 *   - Chat principal CL2 (openRouterClient.openRouterStream)
 *   - Cerebro invoke (cerebroLlmClient.cerebroInvoke)
 *   - Vertex video transcribe (geminiVideoTranscript.fetchTranscript*)
 *   - Voice STT/TTS (routes/voice.ts — ya existía)
 *   - Workspace transforms (routes/workspace.ts — ya existía)
 *   - LLM enrich docs (jobs/llmEnrichDocs.ts)
 *   - Resúmenes mixtos, informes semanales, categorize (jobs/*)
 *
 * COSTOS:
 *   La PRICING table abajo es la fuente de verdad. Cambios de pricing
 *   se commitean acá (versión = git blame). cost_usd_estimated se
 *   materializa al INSERT — un cambio futuro NO re-calcula histórico.
 *
 * PRECISIÓN ESPERADA:
 *   ±5% para anthropic/openai/gemini cuando el provider devuelve usage
 *   en el response (lo normal). ±15% para casos donde estimamos por
 *   chars (TTS, embeddings sin usage). Errores grandes son flagged como
 *   metadata.estimated=true.
 *
 * PRIVACY:
 *   No guardamos el contenido del prompt ni la respuesta — solo
 *   tokens contados + meta no-PII. La auditoría es por costo, no por
 *   contenido.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

// ── Singleton supabase (service role) ────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('tokenAccounting: supabase env missing');
  _supa = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supa;
}

// ── Pricing table ────────────────────────────────────────────────────────────
//
// USD per 1M tokens. Fuentes:
//   - Anthropic: https://www.anthropic.com/pricing (claude.com)
//   - OpenAI: https://openai.com/api/pricing/
//   - Google Vertex: https://cloud.google.com/vertex-ai/generative-ai/pricing
//   - OpenRouter actúa como passthrough pero cobra ~5% spread. Para
//     simplicidad usamos el pricing del modelo upstream.
//
// Estructura: { input, output, cacheRead?, cacheCreate? } por 1M tokens.
// Si el modelo no figura, usamos UNKNOWN_MODEL_RATE (fallback razonable
// para Sonnet, que es el caso más probable en CL2).

interface ModelRate {
  /** USD por 1M input tokens. */
  input: number;
  /** USD por 1M output tokens. */
  output: number;
  /** USD por 1M tokens leídos de cache (Anthropic prompt caching). */
  cacheRead?: number;
  /** USD por 1M tokens escritos en cache (Anthropic prompt caching, 5min TTL). */
  cacheCreate?: number;
}

const PRICING: Record<string, ModelRate> = {
  // Anthropic vía OpenRouter / Cerebro
  'anthropic/claude-sonnet-4.6':       { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 },
  'anthropic/claude-sonnet-4':         { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 },
  'anthropic/claude-opus-4':           { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'anthropic/claude-haiku-4':          { input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreate: 0.30 },
  'anthropic/claude-3-5-sonnet':       { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 },
  'anthropic/claude-3-5-haiku':        { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreate: 1.00 },
  // OpenAI
  'openai/gpt-4.1':                    { input: 2.50, output: 10.00 },
  'openai/gpt-4o':                     { input: 2.50, output: 10.00 },
  'openai/gpt-4o-mini':                { input: 0.15, output: 0.60 },
  'openai/o3-mini':                    { input: 1.10, output: 4.40 },
  // Google Vertex (Gemini)
  'google/gemini-2.5-pro':             { input: 1.25, output: 10.00 },
  'google/gemini-2.5-flash':           { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':                    { input: 1.25, output: 10.00 },
  'gemini-2.5-flash':                  { input: 0.30, output: 2.50 },
  // Voice — Whisper STT (por minuto, no por token; trackeado separado)
  // 'openai/whisper-1':                { input: 6.00 /minuto */, output: 0 },
};

const UNKNOWN_MODEL_RATE: ModelRate = { input: 3.00, output: 15.00 };

/**
 * Calcula costo USD certero para una llamada dada el modelo y los tokens
 * efectivamente consumidos. Si el modelo no figura en la pricing table,
 * usa el fallback de Sonnet (overestima costo para Haiku/Flash, lo cual
 * es seguro desde una perspectiva de control de gasto).
 */
export function computeCostUsd(args: {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}): number {
  const rate = PRICING[args.model] ?? UNKNOWN_MODEL_RATE;
  // Input "normal" no incluye los cache_read ni cache_create — Anthropic
  // los reporta como categorías separadas en el usage del response, y
  // el tokens_in del response ya los excluye.
  const inputCost = (args.tokensIn / 1_000_000) * rate.input;
  const outputCost = (args.tokensOut / 1_000_000) * rate.output;
  const cacheReadCost = ((args.cacheReadTokens ?? 0) / 1_000_000) * (rate.cacheRead ?? rate.input);
  const cacheCreateCost = ((args.cacheCreateTokens ?? 0) / 1_000_000) * (rate.cacheCreate ?? rate.input);
  return Number((inputCost + outputCost + cacheReadCost + cacheCreateCost).toFixed(6));
}

// ── Logging ──────────────────────────────────────────────────────────────────

export interface LLMCallRecord {
  /** auth.users.id que disparó la llamada. null si fue cron sin usuario. */
  userId: string | null;
  /** Identificador corto del callsite: chat.stream, workspace.transform, etc. */
  route: string;
  /** "openrouter" | "vertex" | "cerebro" | "elevenlabs" | "openai-direct" */
  provider: string;
  /** Identificador canónico del modelo (matchea PRICING table). */
  model: string;
  /** Tokens de input efectivamente facturados (NO incluye cache hits). */
  tokensIn: number;
  /** Tokens de output generados. */
  tokensOut: number;
  /** Anthropic cache: tokens leídos (~10% costo del input normal). */
  cacheReadTokens?: number;
  /** Anthropic cache: tokens escritos (~125% costo del input normal, TTL 5min). */
  cacheCreateTokens?: number;
  /** Latencia end-to-end de la llamada en ms (opcional pero útil). */
  latencyMs?: number;
  /** Mensaje de error si la llamada falló pero igual consumió tokens. */
  errorMessage?: string;
  /** Metadata adicional non-PII. */
  meta?: Record<string, unknown>;
}

/**
 * Persiste una llamada al LLM en ai_call_log con costo calculado.
 *
 * Diseñado para fail-open: si la DB está caída o falla el insert, NO
 * abortamos la request del usuario. Loggeamos el error y seguimos.
 * El costo de no-trackear una llamada es mucho menor que el de tirarle
 * 500 al cliente.
 */
export async function logLLMCall(rec: LLMCallRecord): Promise<void> {
  try {
    const costUsd = computeCostUsd({
      model: rec.model,
      tokensIn: rec.tokensIn,
      tokensOut: rec.tokensOut,
      cacheReadTokens: rec.cacheReadTokens,
      cacheCreateTokens: rec.cacheCreateTokens,
    });
    const row = {
      user_id: rec.userId,
      route: rec.route,
      provider: rec.provider,
      model: rec.model,
      tokens_in: rec.tokensIn,
      tokens_out: rec.tokensOut,
      cache_read_tokens: rec.cacheReadTokens ?? 0,
      cache_create_tokens: rec.cacheCreateTokens ?? 0,
      cost_usd_estimated: costUsd,
      latency_ms: rec.latencyMs ?? null,
      error_message: rec.errorMessage ?? null,
      meta: rec.meta ?? null,
    };
    const { error } = await supa().from('ai_call_log').insert(row);
    if (error) {
      logger.warn('token_accounting_log_failed', {
        route: rec.route,
        model: rec.model,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn('token_accounting_exception', {
      route: rec.route,
      error: (err as Error).message,
    });
  }
}

// ── Lectura de agregados ─────────────────────────────────────────────────────

export interface UserUsage {
  user_id: string;
  call_count: number;
  tokens_in_sum: number;
  tokens_out_sum: number;
  tokens_total_sum: number;
  cache_read_sum: number;
  cache_create_sum: number;
  cost_usd_sum: number;
  last_call_at: string | null;
  first_call_at: string | null;
  active_days: number;
  models_used: number;
  errors_count: number;
  email?: string;
  full_name?: string;
}

/**
 * Devuelve agregados por usuario (últimos N días) joineando contra
 * profiles para email + nombre. Usado por el endpoint admin.
 */
export async function getUsageByUser(opts: { windowDays?: number; limit?: number } = {}): Promise<UserUsage[]> {
  const windowDays = opts.windowDays ?? 30;
  const limit = Math.min(opts.limit ?? 100, 500);

  // Si window es 30 usamos la view materialized-friendly; si no, query custom.
  if (windowDays === 30) {
    const { data, error } = await supa()
      .from('v_ai_usage_by_user_30d')
      .select('*')
      .order('cost_usd_sum', { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn('token_accounting_read_view_failed', { error: error.message });
      return [];
    }
    return await joinProfiles((data ?? []) as UserUsage[]);
  }

  // Window custom: agregamos en TS para no crear más views/funciones.
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supa()
    .from('ai_call_log')
    .select('user_id, tokens_in, tokens_out, cache_read_tokens, cache_create_tokens, cost_usd_estimated, model, created_at, error_message')
    .gte('created_at', since)
    .limit(50000);
  if (error || !data) {
    logger.warn('token_accounting_read_raw_failed', { error: error?.message });
    return [];
  }
  type Row = {
    user_id: string | null;
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
    cost_usd_estimated: number;
    model: string | null;
    created_at: string;
    error_message: string | null;
  };
  const byUser = new Map<string, UserUsage>();
  for (const r of data as Row[]) {
    if (!r.user_id) continue;
    const cur = byUser.get(r.user_id) ?? {
      user_id: r.user_id,
      call_count: 0,
      tokens_in_sum: 0,
      tokens_out_sum: 0,
      tokens_total_sum: 0,
      cache_read_sum: 0,
      cache_create_sum: 0,
      cost_usd_sum: 0,
      last_call_at: null,
      first_call_at: null,
      active_days: 0,
      models_used: 0,
      errors_count: 0,
    };
    cur.call_count += 1;
    cur.tokens_in_sum += r.tokens_in ?? 0;
    cur.tokens_out_sum += r.tokens_out ?? 0;
    cur.tokens_total_sum += (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
    cur.cache_read_sum += r.cache_read_tokens ?? 0;
    cur.cache_create_sum += r.cache_create_tokens ?? 0;
    cur.cost_usd_sum += Number(r.cost_usd_estimated ?? 0);
    if (r.error_message) cur.errors_count += 1;
    const ts = r.created_at;
    if (!cur.last_call_at || ts > cur.last_call_at) cur.last_call_at = ts;
    if (!cur.first_call_at || ts < cur.first_call_at) cur.first_call_at = ts;
    byUser.set(r.user_id, cur);
  }
  const out = Array.from(byUser.values());
  out.sort((a, b) => b.cost_usd_sum - a.cost_usd_sum);
  return await joinProfiles(out.slice(0, limit));
}

async function joinProfiles(rows: UserUsage[]): Promise<UserUsage[]> {
  if (rows.length === 0) return rows;
  const userIds = rows.map((r) => r.user_id).filter(Boolean);
  const { data: profiles } = await supa()
    .from('profiles')
    .select('user_id, email, full_name')
    .in('user_id', userIds);
  const byId = new Map<string, { email?: string; full_name?: string }>();
  for (const p of (profiles ?? []) as Array<{ user_id: string; email?: string; full_name?: string }>) {
    byId.set(p.user_id, { email: p.email, full_name: p.full_name });
  }
  return rows.map((r) => ({ ...r, ...(byId.get(r.user_id) ?? {}) }));
}

export async function getUsageByUserDetail(userId: string, windowDays = 30): Promise<unknown> {
  const { data, error } = await supa()
    .rpc('ai_usage_by_user', { p_user_id: userId, p_window_days: windowDays });
  if (error) {
    logger.warn('token_accounting_rpc_failed', { user_id: userId, error: error.message });
    return null;
  }
  return Array.isArray(data) ? data[0] : data;
}
