/**
 * Right-rail card — "Tema del momento" (post-demo) o fallback "Más
 * recientes".
 *
 * Mientras no exista el endpoint /api/sessions/topics, usamos las 5
 * sesiones más recientes para llenar el rail. La estética dark-burgundy
 * se mantiene — la card es la nota editorial visual de la página.
 */
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';
import type { SessionListItem } from '@/services/sessionsApi';

interface Props {
  /** Top sessions to surface. Sorted newest-first by caller. */
  topSessions: SessionListItem[];
  onItemClick?: (id: number | string) => void;
}

const MONTHS_ES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtShortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS_ES_SHORT[d.getMonth()]}`;
}

export function TemaCard({ topSessions, onItemClick }: Props) {
  const items = topSessions.slice(0, 5);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1, ease: 'easeOut' }}
      className="relative overflow-hidden rounded-xl text-white p-5 shadow-[0_4px_18px_rgba(61,24,32,0.18)]"
      style={{
        background: 'linear-gradient(155deg, #4A1E26 0%, #3D1820 60%, #2E1218 100%)',
      }}
    >
      {/* dot pattern overlay */}
      <div
        className="absolute inset-0 opacity-60 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '5px 5px',
        }}
      />

      <div className="relative z-10">
        <div className="flex items-center gap-1.5 mb-2">
          <Sparkles size={11} className="text-cl2-accent-soft" />
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-white/55">
            Más recientes
          </span>
        </div>

        <h3 className="font-display font-normal text-[18px] tracking-[-0.01em] leading-[1.2] mb-1.5">
          Plenarias de la última semana
        </h3>
        <p className="text-[11px] text-white/55 mb-3.5 leading-snug">
          Las sesiones que llegaron a CL2 más recientemente. Al cierre del próximo sprint, esto
          mostrará automáticamente los expedientes más mencionados en el plenario.
        </p>

        {items.length === 0 ? (
          <p className="text-[12px] text-white/55">Aún sin sesiones en la ventana.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onItemClick?.(s.id)}
                  className="w-full text-left flex items-baseline gap-2 group"
                >
                  <span className="font-mono text-[10.5px] text-white/40 tabular-nums shrink-0 w-5">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[12px] leading-snug text-white/85 line-clamp-2 group-hover:text-white transition-colors flex-1">
                    {s.titulo}
                  </span>
                  <span className="font-mono text-[10px] text-white/40 shrink-0">
                    {fmtShortDate(s.fecha)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <a
          href="#"
          onClick={(e) => { e.preventDefault(); }}
          className="inline-flex items-center gap-1 mt-4 text-[11px] text-white/65 hover:text-white transition-colors group"
        >
          Próximo sprint: Tema del momento
          <ArrowUpRight size={11} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </a>
      </div>
    </motion.div>
  );
}
