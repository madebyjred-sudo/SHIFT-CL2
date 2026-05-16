/**
 * Editorial feed — agrupa las sesiones por bucket temporal y rendea
 * cada grupo con su section header (Newsreader display) y count.
 *
 * Loading/empty/error states se manejan afuera (page-level). Esto solo
 * espera una lista y la pinta agrupada.
 */
import type { SessionListItem } from '@/services/sessionsApi';
import { groupSessionsByTime } from '@/lib/sesiones-grouping';
import { SesionCard } from './SesionCard';
import { motion } from 'motion/react';

interface Props {
  sessions: SessionListItem[];
  selectable?: boolean;
  selected?: Array<number | string>;
  onToggleSelect?: (id: number | string) => void;
  onClick?: (id: number | string) => void;
}

export function SesionesFeed({
  sessions, selectable, selected, onToggleSelect, onClick,
}: Props) {
  const groups = groupSessionsByTime(sessions);

  return (
    <div className="flex flex-col">
      {groups.map((group, gi) => (
        <motion.section
          key={`${group.key}-${gi}-${group.label}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: gi * 0.04, ease: 'easeOut' }}
          className="first:mt-0 mt-7"
        >
          <header className="flex items-baseline gap-3 pb-2 mb-3 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
            <h2 className="font-display font-normal text-[22px] tracking-[-0.01em] text-[#0e1745] dark:text-white">
              {group.label}
            </h2>
            <span className="font-mono text-[11px] text-[#0e1745]/45 dark:text-white/45">
              {group.items.length} {group.items.length === 1 ? 'sesión' : 'sesiones'}
            </span>
          </header>
          <div className="flex flex-col gap-3">
            {group.items.map((s) => (
              <SesionCard
                key={s.id}
                session={s}
                selectable={selectable}
                selected={selected?.includes(s.id) ?? false}
                onToggleSelect={onToggleSelect}
                onClick={onClick}
              />
            ))}
          </div>
        </motion.section>
      ))}
    </div>
  );
}
