import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));

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
  routing: { triggers: string[] };
  tools: Array<Record<string, unknown>>;
  response_contract: Record<string, unknown>;
  guardrails: string[];
}

export function loadAgents(): AgentConfig[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(AGENTS_DIR, f), 'utf-8')) as AgentConfig);
}

export function getAgent(id: string): AgentConfig | undefined {
  return loadAgents().find((a) => a.id === id);
}
