/**
 * Filter rail — panel lateral colapsable con facets de filtrado.
 *
 * Las facets que aplican al payload actual: estado, duración,
 * has_resumen. La de comisión queda como stub disabled hasta que el BFF
 * exponga esa metadata por sesión (post-demo).
 *
 * Mobile: el container parent decide si se renderea o no — este file
 * exporta la versión panel; la versión bottom-sheet se compone afuera.
 */
import type { EstadoFilter, DuracionFilter } from '@/lib/sesiones-grouping';
import type { SessionListItem } from '@/services/sessionsApi';
import { cn } from '@/lib/utils';

interface Props {
  sessions: SessionListItem[];
  estado: EstadoFilter;
  onEstado: (e: EstadoFilter) => void;
  duracion: DuracionFilter;
  onDuracion: (d: DuracionFilter) => void;
  onlyResumen: boolean;
  onOnlyResumen: (v: boolean) => void;
}

export function FilterRail({
  sessions, estado, onEstado, duracion, onDuracion, onlyResumen, onOnlyResumen,
}: Props) {
  const counts = {
    todas: sessions.length,
    finalizadas: sessions.filter((s) => s.estado === 1).length,
    enProceso: sessions.filter((s) => s.estado !== 1).length,
    corta: sessions.filter((s) => s.duration_s > 0 && s.duration_s < 90 * 60).length,
    media: sessions.filter((s) => s.duration_s >= 90 * 60 && s.duration_s <= 180 * 60).length,
    larga: sessions.filter((s) => s.duration_s > 180 * 60).length,
    resumen: sessions.filter((s) => s.has_resumen).length,
  };

  return (
    <aside className="text-[#0e1745] dark:text-white">
      <Section title="Estado">
        <RailItem
          label="Todas"
          count={counts.todas}
          checked={estado === 'todas'}
          onChange={() => onEstado('todas')}
        />
        <RailItem
          label="Finalizadas"
          count={counts.finalizadas}
          checked={estado === 'finalizadas'}
          onChange={() => onEstado('finalizadas')}
        />
        <RailItem
          label="En proceso"
          count={counts.enProceso}
          checked={estado === 'en-proceso'}
          onChange={() => onEstado('en-proceso')}
        />
      </Section>

      <Section title="Duración">
        <RailItem
          label="Todas"
          count={counts.todas}
          checked={duracion === 'todas'}
          onChange={() => onDuracion('todas')}
        />
        <RailItem
          label="< 1h 30m"
          count={counts.corta}
          checked={duracion === 'corta'}
          onChange={() => onDuracion('corta')}
        />
        <RailItem
          label="1h 30m – 3h"
          count={counts.media}
          checked={duracion === 'media'}
          onChange={() => onDuracion('media')}
        />
        <RailItem
          label="> 3h"
          count={counts.larga}
          checked={duracion === 'larga'}
          onChange={() => onDuracion('larga')}
        />
      </Section>

      <Section title="Análisis">
        <RailItem
          label="Solo con resumen"
          count={counts.resumen}
          checked={onlyResumen}
          onChange={() => onOnlyResumen(!onlyResumen)}
          asToggle
        />
      </Section>

      <Section title="Comisión">
        <p className="text-[11px] text-[#0e1745]/40 dark:text-white/40 leading-relaxed">
          Filtros por comisión disponibles en el próximo sprint, cuando
          el BFF exponga la asignación de cada plenaria a sus comisiones.
        </p>
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h4 className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50 mb-2.5">
        {title}
      </h4>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function RailItem({
  label, count, checked, onChange, asToggle,
}: {
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
  asToggle?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 py-1.5 px-1 cursor-pointer rounded select-none',
        'text-[12.5px] text-[#0e1745]/75 dark:text-white/75',
        'hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.02] dark:hover:bg-white/[0.03]',
      )}
    >
      <input
        type={asToggle ? 'checkbox' : 'radio'}
        checked={checked}
        onChange={onChange}
        className="accent-cl2-accent"
        aria-label={label}
      />
      <span className="flex-1">{label}</span>
      <span className="text-[11px] text-[#0e1745]/40 dark:text-white/40 tabular-nums">
        {count}
      </span>
    </label>
  );
}
