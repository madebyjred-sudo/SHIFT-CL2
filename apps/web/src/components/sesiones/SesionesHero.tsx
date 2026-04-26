/**
 * Hero editorial de /sesiones — título Newsreader + lede + 3 KPIs +
 * densidad heatmap de 30 días.
 *
 * Se "colapsa" (height 0) cuando hay query activo, dejando que el feed
 * suba a la atención principal. La animación la maneja el container.
 */
import { motion } from 'motion/react';
import { Activity, FileCheck, CalendarRange } from 'lucide-react';
import type { DensityCell, SessionKpis } from '@/lib/sesiones-grouping';
import { cn } from '@/lib/utils';

interface Props {
  kpis: SessionKpis | null;
  density: DensityCell[];
  loading?: boolean;
}

export function SesionesHero({ kpis, density, loading }: Props) {
  return (
    <header className="px-4 sm:px-6 md:px-8 pt-8 pb-7 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-gradient-to-b from-cl2-accent/[0.025] to-transparent">
      <div className="max-w-[1320px] mx-auto">
        <p className="text-[10.5px] uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45 mb-2 font-semibold">
          Plenarias · Inteligencia Legislativa
        </p>
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="font-display font-light text-[34px] sm:text-[38px] leading-[1.05] tracking-[-0.015em] text-[#0e1745] dark:text-white max-w-[720px]"
        >
          Toda la actividad de la Asamblea —{' '}
          <em className="not-italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft italic">
            citable, fechada, buscable
          </em>
          .
        </motion.h1>
        <p className="mt-3 max-w-[560px] text-[13.5px] leading-[1.5] text-[#0e1745]/55 dark:text-white/55">
          Sesiones plenarias con transcripción y análisis automático.
          Filtrá por semana, comisión o duración. Toda respuesta lleva cita
          al video, al expediente o al artículo del Reglamento.
        </p>

        {/* KPIs + density heatmap */}
        <div className="mt-6 grid gap-3.5 md:grid-cols-[repeat(3,minmax(0,1fr))_minmax(220px,260px)]">
          <KpiTile
            icon={<CalendarRange size={14} />}
            label="Esta semana"
            value={loading ? '—' : String(kpis?.sesionesEstaSemana ?? 0)}
            delta={kpis ? `${kpis.total} total` : ''}
          />
          <KpiTile
            icon={<FileCheck size={14} />}
            label="Finalizadas este mes"
            value={loading ? '—' : String(kpis?.finalizadasMes ?? 0)}
            delta={kpis && kpis.finalizadasMes > 0 ? 'OK' : ''}
            deltaTone="up"
          />
          <KpiTile
            icon={<Activity size={14} />}
            label="Con resumen automático"
            value={loading ? '—' : String(kpis?.conResumen ?? 0)}
            delta={kpis?.total ? `${Math.round((kpis.conResumen / kpis.total) * 100)}%` : ''}
          />
          <DensityTile cells={density} loading={loading} />
        </div>
      </div>
    </header>
  );
}

function KpiTile({
  icon, label, value, delta, deltaTone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: string;
  deltaTone?: 'up' | 'down';
}) {
  return (
    <div className="rounded-[10px] border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] px-3.5 py-3 flex flex-col">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] font-semibold text-[#0e1745]/45 dark:text-white/45">
        <span className="text-[#0e1745]/35 dark:text-white/35">{icon}</span>
        {label}
      </div>
      <div className="font-display font-normal text-[26px] leading-none tracking-[-0.01em] text-[#0e1745] dark:text-white mt-2">
        {value}
      </div>
      {delta && (
        <div
          className={cn(
            'text-[11px] mt-1',
            deltaTone === 'up' && 'text-emerald-700 dark:text-emerald-400',
            deltaTone === 'down' && 'text-rose-700 dark:text-rose-400',
            !deltaTone && 'text-[#0e1745]/55 dark:text-white/55',
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}

function DensityTile({ cells, loading }: { cells: DensityCell[]; loading?: boolean }) {
  return (
    <div className="rounded-[10px] border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-[#0e1745]/45 dark:text-white/45">
          Densidad · 30 días
        </span>
      </div>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(15, 1fr)' }}>
        {cells.map((c, i) => (
          <motion.div
            key={c.date.toISOString()}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: loading ? 0.4 : 1, scale: 1 }}
            transition={{ duration: 0.18, delay: i * 0.012, ease: 'easeOut' }}
            className={cn(
              'aspect-square rounded-[3px]',
              c.level === 0 && 'bg-[#0e1745]/[0.05] dark:bg-white/[0.05]',
              c.level === 1 && 'bg-cl2-accent/20',
              c.level === 2 && 'bg-cl2-accent/45',
              c.level === 3 && 'bg-cl2-accent/75',
              c.level === 4 && 'bg-cl2-accent',
            )}
            title={`${c.date.toLocaleDateString('es-CR', { day: 'numeric', month: 'short' })} — ${c.count} sesion${c.count === 1 ? '' : 'es'}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-[#0e1745]/40 dark:text-white/40">
        <span>menos</span>
        <span className="w-2 h-2 rounded-[2px] bg-[#0e1745]/[0.05] dark:bg-white/[0.05]" />
        <span className="w-2 h-2 rounded-[2px] bg-cl2-accent/20" />
        <span className="w-2 h-2 rounded-[2px] bg-cl2-accent/45" />
        <span className="w-2 h-2 rounded-[2px] bg-cl2-accent/75" />
        <span className="w-2 h-2 rounded-[2px] bg-cl2-accent" />
        <span>más</span>
      </div>
    </div>
  );
}
