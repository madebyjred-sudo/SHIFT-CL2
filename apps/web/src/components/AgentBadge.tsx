/**
 * AgentBadge — Pill component showing which agent produced a response.
 *
 * Design language follows HITLModal.tsx (motion + Tailwind + rounded-full pills).
 * Colors come from agentRegistry.ts.
 *
 * Attribution: Pattern inspired by LobeChat AgentInfo (MIT)
 * See THIRD_PARTY_NOTICES.md
 */
import React from 'react';
import { motion } from 'motion/react';
import { resolveAgent, type AgentMeta } from '@/config/agentRegistry';

interface AgentBadgeProps {
  agentId?: string | null;
  size?: 'sm' | 'md';
}

export function AgentBadge({ agentId, size = 'sm' }: AgentBadgeProps) {
  const agent: AgentMeta = resolveAgent(agentId);

  const isSm = size === 'sm';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`
        inline-flex items-center gap-1.5 rounded-pill font-semibold tracking-tight
        border select-none shrink-0
        ${isSm ? 'px-2.5 py-0.5 text-micro' : 'px-3 py-1 text-caption'}
      `}
      style={{
        backgroundColor: `${agent.color}12`,
        borderColor: `${agent.color}30`,
        color: agent.color,
      }}
    >
      <span className={isSm ? 'text-caption' : 'text-body'}>{agent.emoji}</span>
      <span>{agent.name}</span>
      <span
        className="opacity-50 font-medium"
        style={{ color: agent.color }}
      >
        ·
      </span>
      <span className="opacity-60 font-medium">{agent.role}</span>
    </motion.div>
  );
}
