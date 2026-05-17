/**
 * preLLMDispatcher — try to answer user queries algorithmically before
 * paying for an LLM call.
 *
 * Architecturally: this lives in CL2 BFF (NOT Cerebro) because routing
 * decisions are app-specific. CL2 knows what Lexa/Atlas/Centinela can
 * answer; Cerebro provides the canonical algorithms via
 * /v1/algorithms/* and CL2 dispatches.
 *
 * Pattern:
 *   1. Receive raw user query.
 *   2. Try pattern matchers (regex + keyword heuristics).
 *   3. If a high-confidence match: call Cerebro algorithm endpoint.
 *   4. If result is satisfactory: return formatted answer + skip LLM.
 *   5. If no match OR algorithm returned no useful answer: return null
 *      and let the caller fall through to LLM.
 *
 * Doctrina LLM-vs-algoritmo: this is the operational implementation of
 * the doctrine. Without this dispatcher, the algorithms in Cerebro stay
 * unused — the apps keep paying $0.01-$0.10/call to ask "¿cuántos días
 * para dictaminar un expediente urgente?" when a hash-lookup answers
 * the same in 1ms for $0.
 *
 * Sampling evidence (cerebro_llm_call_samples 2026-05-17) showed real
 * CL2 traffic asking exactly these procedural questions at high cost.
 * Track wins/misses to validate.
 */
const CEREBRO_BASE = process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro-production.up.railway.app';
const CEREBRO_KEY = process.env.CEREBRO_API_KEY ?? '';

/**
 * Result of trying to answer algorithmically.
 *
 * - handled=true means the dispatcher produced a satisfactory answer.
 *   Caller should SKIP the LLM and send this directly to the user.
 * - handled=false means the caller should proceed to LLM as usual.
 */
export interface DispatchResult {
  handled: boolean;
  response?: string;
  capability_used?: string;
  rule_id?: string;
  latency_ms?: number;
  rationale?: string;
}


// ────────────────────────────────────────────────────────────────
// Pattern matchers
// ────────────────────────────────────────────────────────────────


interface PatternMatch {
  capability: 'rule_engine.plazo_dictamen';
  rule_id: 'cl2.ral.plazo_dictamen';
  inputs: { tipo: string };
  matched_text: string;
}


/**
 * "¿cuántos días tiene la comisión para dictaminar [un expediente]
 * [urgente|ordinario|consulta preceptiva]?"
 *
 * Returns a PatternMatch object when query is a high-confidence ask for
 * dictamen deadline by expediente type. Returns null otherwise.
 */
function matchPlazoDictamen(query: string): PatternMatch | null {
  const lower = query.toLowerCase();

  // Must mention BOTH "días" AND "dictam[en|inar]" to be high-confidence
  // (avoids matching general questions about plazos like "cuántos
  // días faltan para la sesión").
  const mentionsDays = /\b(d[ií]as?|plazo)\b/.test(lower);
  const mentionsDictamen = /\bdictam(en|inar)\b/.test(lower);
  if (!mentionsDays || !mentionsDictamen) {
    return null;
  }

  // Look for the type qualifier near the keywords.
  let tipo: string | null = null;
  if (/\burgent[eo]\b/.test(lower)) tipo = 'urgente';
  else if (/\bordinari[oa]\b/.test(lower)) tipo = 'ordinario';
  else if (/\bratificaci[oó]n\b/.test(lower)) tipo = 'ratificación';
  else if (/\bconsulta preceptiv[oa]\b/.test(lower)) tipo = 'consulta_preceptiva';

  if (!tipo) {
    // High confidence question, but type unspecified — let LLM ask
    // for clarification or use general knowledge. Don't half-answer.
    return null;
  }

  return {
    capability: 'rule_engine.plazo_dictamen',
    rule_id: 'cl2.ral.plazo_dictamen',
    inputs: { tipo },
    matched_text: query.slice(0, 200),
  };
}


// Register all matchers in priority order. Add more as we see real samples.
const MATCHERS: Array<(q: string) => PatternMatch | null> = [
  matchPlazoDictamen,
];


// ────────────────────────────────────────────────────────────────
// Cerebro algorithm caller
// ────────────────────────────────────────────────────────────────


interface CerebroRuleResult {
  status: 'ok' | 'error';
  rule_id?: string;
  description?: string;
  result?: number | string | boolean | null;
  context_used?: Record<string, unknown>;
  error?: string;
}


async function callRuleEngine(
  ruleId: string,
  context: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<CerebroRuleResult | null> {
  if (!CEREBRO_KEY) {
    console.warn('[preLLMDispatcher] CEREBRO_API_KEY missing — skipping');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CEREBRO_BASE}/v1/algorithms/rule_engine/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CEREBRO_KEY}`,
      },
      body: JSON.stringify({ rule_id: ruleId, context }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[preLLMDispatcher] rule_engine ${res.status}: ${await res.text().catch(() => '?')}`);
      return null;
    }
    return (await res.json()) as CerebroRuleResult;
  } catch (err) {
    console.warn(`[preLLMDispatcher] rule_engine fetch failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}


// ────────────────────────────────────────────────────────────────
// Response formatters
// ────────────────────────────────────────────────────────────────


function formatPlazoDictamenResponse(
  tipo: string,
  diasResult: number | string | boolean | null | undefined,
): string {
  if (typeof diasResult !== 'number') {
    // Unknown type — bail to LLM rather than misinform.
    return '';
  }

  // Localized type labels for the response.
  const tipoLabel: Record<string, string> = {
    urgente: 'urgente',
    ordinario: 'ordinario',
    ratificación: 'de ratificación',
    consulta_preceptiva: 'consultado preceptivamente',
  };
  const label = tipoLabel[tipo] ?? tipo;

  return [
    `# Plazo para dictaminar — ${label}`,
    '',
    `Según el **Reglamento de la Asamblea Legislativa de Costa Rica** (art. 81 y concordancias), una comisión tiene **${diasResult} días** para dictaminar un expediente ${label}.`,
    '',
    `_Fuente: catálogo CL2 RAL plazos. Si el expediente tiene calificación especial o se invocó moción de plazo extendido, los días pueden variar — consultá el detalle del expediente._`,
  ].join('\n');
}


// ────────────────────────────────────────────────────────────────
// Main entry — try to dispatch algorithmically
// ────────────────────────────────────────────────────────────────


/**
 * Attempt algorithmic answer. Returns { handled: true, response } if a
 * high-confidence pattern matched AND Cerebro algorithm produced a
 * satisfactory result. Returns { handled: false } otherwise (caller falls
 * to LLM).
 *
 * This function is **deterministic + cheap** — it makes at most one HTTP
 * call to Cerebro with 3s timeout. It NEVER blocks the chat indefinitely.
 */
export async function tryPreLLMDispatch(
  query: string,
  agentId: string,
): Promise<DispatchResult> {
  // Only Lexa for now — Atlas and Centinela have different domains, defer
  // until we see samples that justify rules for them.
  if (agentId !== 'lexa') {
    return { handled: false };
  }

  const t0 = Date.now();

  for (const matcher of MATCHERS) {
    const match = matcher(query);
    if (!match) continue;

    // High-confidence match — call Cerebro algorithm.
    const result = await callRuleEngine(match.rule_id, match.inputs);
    if (!result || result.status !== 'ok' || result.result === null || result.result === undefined) {
      // Algorithm couldn't answer (rule miss or Cerebro down). Fall to LLM.
      return { handled: false };
    }

    // Format the response based on capability.
    let response = '';
    if (match.capability === 'rule_engine.plazo_dictamen') {
      response = formatPlazoDictamenResponse(
        match.inputs.tipo,
        result.result as number,
      );
    }

    if (!response) {
      // Couldn't format — fall to LLM.
      return { handled: false };
    }

    return {
      handled: true,
      response,
      capability_used: match.capability,
      rule_id: match.rule_id,
      latency_ms: Date.now() - t0,
      rationale: `Matched pattern ${match.capability}; rule ${match.rule_id} returned ${result.result}.`,
    };
  }

  return { handled: false };
}


// ────────────────────────────────────────────────────────────────
// Test helpers (not exported to runtime path)
// ────────────────────────────────────────────────────────────────


export const _testHelpers = {
  matchPlazoDictamen,
  formatPlazoDictamenResponse,
};
