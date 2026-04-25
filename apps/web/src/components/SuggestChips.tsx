/**
 * SuggestChips — Post-response follow-up questions
 *
 * Attribution: LobeChat SuggestQuestions (MIT)
 * See THIRD_PARTY_NOTICES.md
 */
import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles } from 'lucide-react';

interface SuggestChipsProps {
  onSelect: (question: string) => void;
  visible: boolean;
}

const SUGGESTIONS = [
  '¿Qué diputados intervinieron?',
  'Cita las fuentes exactas',
  'Resume la votación',
  '¿Qué mociones quedaron pendientes?',
  'Dame el siguiente paso',
  'Compara con sesiones anteriores',
  '¿Qué comisiones revisaron esto?',
  'Lista los puntos del orden del día',
];

export function SuggestChips({ onSelect, visible }: SuggestChipsProps) {
  // Randomly select 3 suggestions when component renders
  const chips = useMemo(() => {
    return [...SUGGESTIONS].sort(() => 0.5 - Math.random()).slice(0, 3);
  }, [visible]); // Re-roll when visibility changes for freshness

  return (
    <AnimatePresence>
      {visible && (
        <motion.div 
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="flex flex-wrap gap-2 mt-3 overflow-hidden"
        >
          {chips.map((chip, i) => (
            <motion.button
              key={chip}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: i * 0.05, duration: 0.2 }}
              onClick={() => onSelect(chip)}
              className="
                flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-caption font-medium
                border border-slate-200 dark:border-white/10 text-slate-600 dark:text-white/70
                bg-white/50 dark:bg-black/20 hover:bg-slate-50 dark:hover:bg-white/10
                transition-colors shadow-subtle select-none
              "
            >
              <Sparkles className="w-[10px] h-[10px] text-shift-primary opacity-80" />
              {chip}
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
