import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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
