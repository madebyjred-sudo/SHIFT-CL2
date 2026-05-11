/**
 * Cerebro LLM client — wrapper de `/v1/llm/invoke`.
 *
 * Para callsites NO-STREAMING (jobs batch, scripts, magic-help de
 * onboarding, etc.). El chat principal del SPA NO usa este módulo
 * todavía — eso espera Track A (extender feat/oai-compat con tool
 * dispatching + streaming SSE).
 *
 * Beneficios sobre llamar OpenRouter directo:
 *   1. enable_memory=true automáticamente activa el memory tool loop
 *      en el servidor — Cerebro lee /memories/{realm}/{user_id} antes
 *      de la inferencia, y escribe back con `memory.create` /
 *      `str_replace` cuando aparece info persistible. Cero código del
 *      lado de CL2.
 *   2. cerebro_llm_calls log automático (cost, cache_hit, latency,
 *      app_id, trace_label). Centralizá la observabilidad de modelo.
 *   3. cache_control en system_blocks llega intacto a Anthropic
 *      (prompt caching).
 *   4. Si Cerebro cambia de provider (OpenRouter → MiniMax → otro),
 *      este módulo no cambia.
 *
 * Auth: `x-shift-internal-token` (mismo token compartido que
 * cerebroNeuron.ts). Server-side only.
 *
 * Failure mode: throws en error. Cada caller decide su política de
 * retry / fallback.
 */

const CEREBRO_BASE_URL =
  process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro-production.up.railway.app';
const CEREBRO_LLM_TIMEOUT_MS = 60_000; // jobs batch pueden tardar; cap defensivo

export interface CerebroInvokeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CerebroInvokeArgs {
  /** OpenRouter model id, e.g. 'anthropic/claude-sonnet-4.6'. */
  model: string;
  /** OAI-shape messages. Si querés system + user pasalos acá. */
  messages: CerebroInvokeMessage[];
  /** Cap tokens del response. */
  max_tokens?: number;
  /** 0.0 (deterministic) → 1.5 (creativo). Default Cerebro: 0.7. */
  temperature?: number;
  /** Identidad operativa del caller (siempre 'cl2' acá). */
  app_id?: string;
  /** Etiqueta de cost-attribution. Recomendado: '{module}:{action}' (ej 'onboarding:magic-help'). */
  trace_label?: string;
  /** Neurona — habilita memory tool loop server-side. */
  realm?: 'cl2';
  user_id?: string | null;
  enable_memory?: boolean;
  /** Tenant scoping en Cerebro (separado de app_id). Default: 'cl2'. */
  tenant?: string;
}

export interface CerebroInvokeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  openrouter_cost_usd?: number;
}

export interface CerebroInvokeResponse {
  /** Texto final del assistant (después del memory loop, si aplica). */
  text: string;
  /** Alias de text — Cerebro devuelve ambos para compatibilidad. */
  output: string;
  usage: CerebroInvokeUsage;
  latency_ms: number;
  call_id: string;
  model: string;
}

function authHeaders(): Record<string, string> {
  const token = process.env.SHIFT_INTERNAL_TOKEN;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['x-shift-internal-token'] = token;
  return h;
}

/**
 * Llamada non-streaming al endpoint canónico de Cerebro. Devuelve texto
 * final + usage tokens. Sin tool-use externo en v1 — para tools de CL2
 * (search_sil etc.) sigue rigiendo openRouterClient.ts hasta Track A/B.
 *
 * @throws Error con shape `cerebro_invoke: {status}: {body}` si el
 * servidor responde no-2xx. AbortError si supera el timeout.
 */
export async function cerebroInvoke(args: CerebroInvokeArgs): Promise<CerebroInvokeResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CEREBRO_LLM_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      app_id: args.app_id ?? 'cl2',
      tenant: args.tenant ?? 'cl2',
    };
    if (args.max_tokens != null) body.max_tokens = args.max_tokens;
    if (args.temperature != null) body.temperature = args.temperature;
    if (args.trace_label) body.trace_label = args.trace_label;
    if (args.realm) body.realm = args.realm;
    if (args.user_id) body.user_id = args.user_id;
    if (args.enable_memory) body.enable_memory = args.enable_memory;

    const r = await fetch(`${CEREBRO_BASE_URL}/v1/llm/invoke`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`cerebro_invoke ${r.status}: ${txt.slice(0, 240)}`);
    }
    return (await r.json()) as CerebroInvokeResponse;
  } finally {
    clearTimeout(timer);
  }
}
