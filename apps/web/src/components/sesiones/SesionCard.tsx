/**
 * Plenaria card v2 — diseñada para feed editorial.
 *
 * Layout: columna de fecha NYT-style (DOM · día grande · mes) +
 * cuerpo con título + meta-row (duración, resumen, agentes que pueden
 * responder) + duration bar + status pill flotante esquina superior.
 *
 * Modo `selectable` agrega un checkbox a la izquierda para Compare.
 */
import type { SessionListItem } from '@/services/sessionsApi';
import { Calendar, Clock, FileText, MessageSquare, CheckCircle2 } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface Props {
  session: SessionListItem;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  onClick?: (id: number) => void;
}

const MONTHS_ES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DOWS_ES = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Heurística para la duration bar — saturamos a 4 horas, que es ~el tope
// observable de plenarias largas.
const DURATION_FULL_S = 4 * 3600;

export function SesionCard({ session, selectable, selected, onToggleSelect, onClick }: Props) {
  const d = (() => {
    const t = Date.parse(session.fecha);
    return Number.isFinite(t) ? new Date(t) : null;
  })();
  const dia = d ? d.getDate() : '?';
  const dom = d ? DOWS_ES[d.getDay()] : '';
  const mon = d ? MONTHS_ES_SHORT[d.getMonth()] : '';
  const finalizada = session.estado === 1;

  const durFill = Math.min(100, Math.round(((session.duration_s ?? 0) / DURATION_FULL_S) * 100));

  const handleClick = () => {
    if (selectable) onToggleSelect?.(session.id);
    else onClick?.(session.id);
  };

  return (
    <motion.article
      whileHover={{ y: -1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={cn(
        'group relative flex gap-4 cursor-pointer transition-shadow duration-200',
        'rounded-[10px] border bg-white dark:bg-white/[0.025] p-4 sm:p-[18px]',
        'shadow-[0_2px_10px_rgba(14,23,69,0.04)] dark:shadow-none',
        'hover:shadow-[0_6px_20px_rgba(14,23,69,0.06)]',
        selected
          ? 'border-cl2-accent ring-1 ring-cl2-accent shadow-[0_8px_25px_rgba(249,53,73,0.10)]'
          : 'border-[#0e1745]/[0.06] dark:border-white/[0.06] hover:border-[#0e1745]/[0.10] dark:hover:border-white/[0.10]',
      )}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={(e) => { e.stopPropagation(); onToggleSelect?.(session.id); }}
          onClick={(e) => e.stopPropagation()}
          className="mt-2 accent-cl2-accent shrink-0"
          aria-label={`Seleccionar plenaria ${session.titulo}`}
        />
      )}

      {/* Date column — NYT style */}
      <div className="flex flex-col items-center min-w-[56px] pt-0.5 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/40 dark:text-white/40">
          {dom}
        </span>
        <span className="font-display font-light text-[32px] leading-none tracking-[-0.02em] text-[#0e1745] dark:text-white mt-0.5">
          {dia}
        </span>
        <span className="text-[11px] text-[#0e1745]/50 dark:text-white/50 mt-0.5">{mon}</span>
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 pr-12">
        <h3 className="font-display font-medium text-[17px] leading-snug tracking-[-0.005em] text-[#0e1745] dark:text-white line-clamp-2 group-hover:text-cl2-accent transition-colors">
          {session.titulo}
        </h3>

        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} className="text-[#0e1745]/35 dark:text-white/35" />
            {fmtDuration(session.duration_s ?? 0)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar size={12} className="text-[#0e1745]/35 dark:text-white/35" />
            {d ? d.toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' }) : 's/f'}
          </span>
          {session.has_resumen && (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <FileText size={12} />
              Con resumen
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[#0e1745]/40 dark:text-white/40">
            <MessageSquare size={12} />
            Lexa puede responder
          </span>
        </div>

        {/* Duration bar */}
        <div className="mt-2.5 w-[90px] h-1 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.06] overflow-hidden">
          <div
            className="h-full bg-[#0e1745]/25 dark:bg-white/25"
            style={{ width: `${durFill}%` }}
          />
        </div>
      </div>

      {/* Status pill — top right */}
      <div className="absolute top-3.5 right-4 inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-[#0e1745]/55 dark:text-white/55">
        {finalizada ? (
          <>
            <CheckCircle2 size={11} className="text-emerald-500" />
            <span>Finalizada</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span>En proceso</span>
          </>
        )}
      </div>
    </motion.article>
  );
}
