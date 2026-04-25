import React from 'react';

interface AgentPillProps {
  agentId: 'lexa' | 'atlas' | 'centinela';
  isActive?: boolean;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
}

const agentConfig = {
  lexa: {
    name: 'Lexa',
    tagline: 'Consultas Legislativas',
    color: '#2563EB',
    colorLight: '#DBEAFE',
  },
  atlas: {
    name: 'Atlas',
    tagline: 'Documental',
    color: '#059669',
    colorLight: '#D1FAE5',
  },
  centinela: {
    name: 'Centinela',
    tagline: 'Monitor',
    color: '#F43F5E',
    colorLight: '#FFE4E6',
  },
};

const sizeClasses = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

export function AgentPill({ agentId, isActive = false, onClick, size = 'md' }: AgentPillProps) {
  const agent = agentConfig[agentId];

  return (
    <button
      onClick={onClick}
      className={`
        relative inline-flex items-center gap-2 rounded-full border transition-all duration-200
        font-ui font-medium tracking-wide
        ${sizeClasses[size]}
        ${isActive
          ? 'border-transparent text-white shadow-lg'
          : 'border-cl2-border text-cl2-muted hover:text-cl2-fg hover:border-cl2-border-strong'
        }
      `}
      style={{
        backgroundColor: isActive ? agent.color : 'transparent',
        boxShadow: isActive ? `0 0 20px ${agent.color}40` : undefined,
      }}
    >
      {/* Agent Icon / Dot */}
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: isActive ? '#fff' : agent.color }}
      />

      {/* Agent Name — Figtree Bold */}
      <span className="font-display font-semibold">{agent.name}</span>

      {/* Tagline (only on lg) — Fira Sans Light */}
      {size === 'lg' && (
        <span className="font-subtitle font-light text-white/70 text-xs tracking-wide">
          {agent.tagline}
        </span>
      )}

      {/* Active indicator */}
      {isActive && (
        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-white border-2 border-cl2-bg" />
      )}
    </button>
  );
}

// Agent Selector Group
interface AgentPillGroupProps {
  activeAgent?: string;
  onAgentChange?: (agentId: string) => void;
}

export function AgentPillGroup({ activeAgent, onAgentChange }: AgentPillGroupProps) {
  return (
    <div className="flex items-center gap-2 p-1.5 rounded-xl bg-cl2-bg-elevated border border-cl2-border-subtle">
      {(Object.keys(agentConfig) as Array<keyof typeof agentConfig>).map((id) => (
        <AgentPill
          key={id}
          agentId={id}
          isActive={activeAgent === id}
          onClick={() => onAgentChange?.(id)}
          size="sm"
        />
      ))}
    </div>
  );
}
