import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Deep Insight protocol — agent-specific behavior changes when DI is on.
 * See docs/AGENTS.md §"Deep Insight" for the design rationale.
 *
 * Per-agent semantics (as of 2026-04-28):
 *   • lexa     → "Pensamiento profundo" (per-turn, ~40% longer responses)
 *   • atlas    → "Construcción ejecutiva" (per-turn, denser hojas)
 *   • centinela → "Análisis de patrones" (scheduled, weekly digest)
 *
 * The handler appends `prompt_addendum` to the persona when DI=true.
 * `workflow_hints` is descriptive; not enforced by code today, but
 * documented in YAML so future iterations can leverage it.
 */
export interface DeepInsightConfig {
  /** Markdown text appended to the agent persona when DI is active. */
  prompt_addendum?: string;
  /** Per-turn (default) or scheduled (Centinela). */
  trigger?: 'per_turn' | 'scheduled';
  default_cadence?: 'daily' | 'weekly' | 'monthly';
  workflow_hints?: Record<string, unknown>;
}

export interface AgentConfig {
  id: string;
  display_name: string;
  tagline: string;
  tenant: string;
  version: string;
  persona: string;
  domain: string;
  default_model: string;
  deep_insight_model: string;
  deep_insight_default_off?: boolean;
  /** New 2026-04-28 — see docs/AGENTS.md. Optional for back-compat. */
  deep_insight?: DeepInsightConfig;
  routing: { triggers?: string[]; surface_priority?: string };
  tools: Array<Record<string, unknown>>;
  response_contract: Record<string, unknown>;
  guardrails: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(HERE, '..', '..', '..', '..', 'packages', 'cerebro-config', 'agents');

// No module-level cache: YAML files are tiny (3 files, ~3KB total) and not
// imported by tsx watch, so caching here would mean editing a persona requires
// an API restart. Re-read on each call keeps dev fast and safe.
export function loadAgents(): AgentConfig[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(AGENTS_DIR, f), 'utf-8')) as AgentConfig);
}

export function getAgent(id: string): AgentConfig | undefined {
  return loadAgents().find((a) => a.id === id);
}

/**
 * Build the effective system prompt for an agent given Deep Insight state.
 *
 * Composition (in order):
 *   1. The agent's `persona` (always present)
 *   2. If `deepInsight === true` AND the YAML defines `deep_insight.prompt_addendum`,
 *      we append the addendum after a separator. This is what differentiates
 *      DI from "same agent with a fancier model" — the addendum carries
 *      agent-specific CoT and workflow rules (see each agent's YAML).
 *
 * The user-facing copy of the Deep Insight toggle is intentionally identical
 * across agents (per Jred 2026-04-28 product call). The differentiation
 * happens server-side, here.
 *
 * Returns the persona unchanged if DI is off OR the agent has no addendum
 * configured (gracefully degrades for legacy YAMLs).
 */
export function buildAgentSystemPrompt(
  agent: AgentConfig,
  deepInsight: boolean,
): string {
  const base = agent.persona;
  if (!deepInsight) return base;
  const addendum = agent.deep_insight?.prompt_addendum?.trim();
  if (!addendum) return base;
  return `${base}\n\n${addendum}`;
}
