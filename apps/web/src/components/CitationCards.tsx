/**
 * CitationCards — Collapsible list of RAG chunk citations under a Lexa response.
 *
 * Receives ChunkCitation[] (from `citation` SSE event in chatStream).
 * Default collapsed; click header to expand. Each card: comisión + fecha pill,
 * source_ref, content excerpt, similarity %, optional video_url link.
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, FileText, ExternalLink } from 'lucide-react';
import type { ChunkCitation } from '@/lib/chat-context';

interface CitationCardsProps {
  citations: ChunkCitation[];
}

function formatFecha(iso: string): string {
  // ISO date "2026-03-04" parses as UTC midnight; in GMT-6 (CR) it shifts a day
  // back. Force local-time interpretation by appending T00:00:00.
  try {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
    return d.toLocaleDateString('es-CR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function CitationCards({ citations }: CitationCardsProps) {
  const [expanded, setExpanded] = useState(false);

  if (!citations.length) return null;

  return (
    <div className="w-full mt-3 rounded-2xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] backdrop-blur-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 text-[12px] font-medium text-[#0e1745]/70 dark:text-white/70">
          <FileText className="w-3.5 h-3.5" />
          <span>
            {citations.length} {citations.length === 1 ? 'fuente' : 'fuentes'} legislativa
            {citations.length === 1 ? '' : 's'}
          </span>
        </div>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-4 h-4 text-[#0e1745]/50 dark:text-white/50" />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 flex flex-col gap-2">
              {citations.map((c, i) => (
                <article
                  key={c.id}
                  className="rounded-xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] p-3 text-[12.5px]"
                >
                  <header className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10.5px] font-semibold text-[#0e1745]/40 dark:text-white/40">
                        [{i + 1}]
                      </span>
                      <span
                        className="px-2 py-0.5 rounded-full text-[10.5px] font-medium"
                        style={{
                          backgroundColor: 'var(--color-cl2-burgundy-soft)',
                          color: 'var(--color-cl2-burgundy)',
                          border: '1px solid color-mix(in srgb, var(--color-cl2-burgundy) 19%, transparent)',
                        }}
                      >
                        {c.comision}
                      </span>
                      <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                        {formatFecha(c.fecha)}
                      </span>
                      <span className="text-[10.5px] text-[#0e1745]/35 dark:text-white/35">
                        · {Math.round(c.similarity * 100)}% match
                      </span>
                    </div>
                    {c.video_url && (
                      <a
                        href={c.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10.5px] text-cl2-burgundy hover:underline shrink-0"
                      >
                        Video <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </header>
                  <p className="text-[#0e1745]/80 dark:text-white/80 leading-relaxed">
                    {c.content}
                  </p>
                  <footer className="mt-2 text-[10.5px] text-[#0e1745]/40 dark:text-white/40 font-mono truncate">
                    {c.source_ref}
                  </footer>
                </article>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
