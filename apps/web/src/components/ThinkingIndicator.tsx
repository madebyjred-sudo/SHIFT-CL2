/**
 * ThinkingIndicator — Animated pulse skeleton representing an agent processing.
 *
 * Appears while the LLM or graph is generating a response.
 * Uses agent colors and motion for a premium "alive" feel.
 *
 * Attribution: LobeChat ThinkingIndicator (MIT)
 * See THIRD_PARTY_NOTICES.md
 */
import React from 'react';
import { motion } from 'motion/react';
import { resolveAgent, type AgentMeta } from '@/config/agentRegistry';

interface ThinkingIndicatorProps {
  agentId?: string | null;
}

export function ThinkingIndicator({ agentId }: ThinkingIndicatorProps) {
  const agent: AgentMeta = resolveAgent(agentId);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="w-full flex justify-start mb-2"
    >
      <div
        className="inline-flex items-center gap-2.5 rounded-bubble px-4 py-2.5 text-body shadow-subtle border backdrop-blur-md"
        style={{
          backgroundColor: `${agent.color}0a`, // visually ~ /4 or /5 opacity hex
          borderColor: `${agent.color}20`,
        }}
      >
        <div 
          className="flex items-center justify-center w-6 h-6 rounded-pill shrink-0"
          style={{ backgroundColor: `${agent.color}20`, color: agent.color }}
        >
          <span className="text-body">{agent.emoji}</span>
        </div>
        
        <span className="font-medium tracking-tight text-gray-700 dark:text-gray-300 text-body">
          {agent.name} está pensando...
        </span>

        <div className="flex gap-1 items-center ml-1">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="w-1 h-1 rounded-pill"
              style={{ backgroundColor: agent.color, opacity: 0.8 }}
              animate={{ y: [0, -4, 0] }}
              transition={{
                duration: 0.6,
                repeat: Infinity,
                delay: i * 0.15,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
