/**
 * CL2 Agent Registry — 3 legislative agents.
 * Backend YAMLs: packages/cerebro-config/agents/{lexa,atlas,centinela}.yaml
 */

export interface AgentMeta {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  pod: number;
  podName: string;
}

export const AGENT_REGISTRY: Record<string, AgentMeta> = {
  lexa: {
    id: 'lexa',
    name: 'Lexa',
    role: 'Análisis Plenario',
    emoji: '⚖️',
    // Burgundy desaturado — toga, autoridad, primo serio del coral
    color: '#7A3B47',
    pod: 1,
    podName: 'Legislativo',
  },
  atlas: {
    id: 'atlas',
    name: 'Atlas',
    role: 'Comisiones & Datos',
    emoji: '📑',
    // Ochre warm — pergamino, archivo, concordancia
    color: '#8B6E54',
    pod: 1,
    podName: 'Legislativo',
  },
  centinela: {
    id: 'centinela',
    name: 'Centinela',
    role: 'Alertas & Seguimiento',
    emoji: '📡',
    color: '#F43F5E',
    pod: 1,
    podName: 'Legislativo',
  },
};

export const FALLBACK_AGENT: AgentMeta = AGENT_REGISTRY.lexa;

export function getAgent(id?: string | null): AgentMeta {
  if (!id) return FALLBACK_AGENT;
  return AGENT_REGISTRY[id] ?? FALLBACK_AGENT;
}

export function resolveAgent(agentRef?: string | null): AgentMeta {
  if (!agentRef) return FALLBACK_AGENT;
  if (AGENT_REGISTRY[agentRef]) return AGENT_REGISTRY[agentRef];
  const lowerRef = agentRef.toLowerCase();
  for (const agent of Object.values(AGENT_REGISTRY)) {
    if (lowerRef.includes(agent.name.toLowerCase())) return agent;
  }
  return FALLBACK_AGENT;
}
