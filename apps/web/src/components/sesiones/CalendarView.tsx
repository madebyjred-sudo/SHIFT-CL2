/**
 * Calendar view — grid 7×N (semanas del mes) con dots por estado.
 *
 * Cell click → emite la fecha al parent (que la convierte en filtro
 * `from`/`to` del mismo día y vuelve a vista lista).
 *
 * Deliberadamente sin libs externas — Date helpers básicos.
 */
import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import type { SessionListItem } from '@/services/sessionsApi';
import { cn } from '@/lib/utils';

interface Props {
  sessions: SessionListItem[];
  initialMonth?: Date;
  onDayClick?: (date: Date) => void;
}

const DOW_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function CalendarView({ sessions, initialMonth, onDayClick }: Props) {
  const [cursor, setCursor] = useState<Date>(() => {
    const base = initialMonth ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const today = startOfDay(new Date());

  // Map iso-day → sessions on that day
  const byDay = useMemo(() => {
    const m = new Map<string, SessionListItem[]>();
    for (const s of sessions) {
      const t = Date.parse(s.fecha);
      if (!Number.isFinite(t)) continue;
      const k = isoDay(startOfDay(new Date(t)));
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [sessions]);

  // Build grid: weeks of the month, monday-anchored
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const firstDow = (first.getDay() + 6) % 7; // 0 = Mon
    const start = new Date(first);
    start.setDate(first.getDate() - firstDow);
    const end = new Date(last);
    const trailing = (7 - ((last.getDay() + 6) % 7) - 1) % 7;
    end.setDate(last.getDate() + trailing);
    const out: Array<{ date: Date; inMonth: boolean }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      out.push({
        date: new Date(cur),
        inMonth: cur.getMonth() === cursor.getMonth(),
      });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [cursor]);

  const goPrev = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1));
  const goNext = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1));

  return (
    <div className="rounded-xl border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] p-5 sm:p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-display font-normal text-[22px] tracking-[-0.01em] text-[#0e1745] dark:text-white">
          {MONTHS_ES[cursor.getMonth()]} <span className="text-[#0e1745]/45 dark:text-white/45 ml-1">{cursor.getFullYear()}</span>
        </h2>
        <div className="inline-flex gap-1">
          <button
            onClick={goPrev}
            aria-label="Mes anterior"
            className="w-7 h-7 rounded-md border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] text-[#0e1745]/70 dark:text-white/70 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10] inline-flex items-center justify-center transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={goNext}
            aria-label="Mes siguiente"
            className="w-7 h-7 rounded-md border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] text-[#0e1745]/70 dark:text-white/70 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10] inline-flex items-center justify-center transition-colors"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {DOW_LABELS.map((dl) => (
          <div
            key={dl}
            className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#0e1745]/40 dark:text-white/40 p-1"
          >
            {dl}
          </div>
        ))}
        {cells.map(({ date, inMonth }) => {
          const dayKey = isoDay(date);
          const items = byDay.get(dayKey) ?? [];
          const isToday = isoDay(today) === dayKey;
          return (
            <motion.button
              key={dayKey}
              type="button"
              whileHover={inMonth ? { scale: 1.02 } : {}}
              transition={{ duration: 0.12 }}
              onClick={() => inMonth && onDayClick?.(date)}
              disabled={!inMonth}
              className={cn(
                'aspect-[1.05] rounded-lg p-1.5 sm:p-2 flex flex-col gap-1 text-left transition-colors',
                inMonth
                  ? 'border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.02] hover:border-cl2-accent/30 hover:bg-cl2-accent/[0.02] cursor-pointer'
                  : 'border border-transparent bg-transparent cursor-default',
                isToday && 'ring-1 ring-[#0e1745] dark:ring-white/40 bg-[#0e1745]/[0.025] dark:bg-white/[0.06]',
              )}
            >
              <span
                className={cn(
                  'text-xs font-medium tabular-nums',
                  inMonth ? 'text-[#0e1745]/70 dark:text-white/70' : 'text-[#0e1745]/20 dark:text-white/20',
                )}
              >
                {date.getDate()}
              </span>
              {items.length > 0 && (
                <div className="flex flex-wrap gap-0.5 mt-auto">
                  {items.slice(0, 6).map((it) => (
                    <span
                      key={it.id}
                      className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        it.estado === 1 ? 'bg-emerald-500' : 'bg-amber-500',
                      )}
                      title={it.titulo}
                    />
                  ))}
                  {items.length > 6 && (
                    <span className="text-[9px] text-[#0e1745]/40 dark:text-white/40 ml-0.5">+{items.length - 6}</span>
                  )}
                </div>
              )}
              {items.length > 0 && (
                <span className="text-[9.5px] text-[#0e1745]/45 dark:text-white/45 truncate hidden sm:block">
                  {items[0].titulo}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
