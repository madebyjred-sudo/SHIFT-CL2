/**
 * CalendarFilter — filtro por rango de fechas en el catálogo de expedientes.
 *
 * Permite seleccionar QUÉ campo de fecha filtrar (fecha_presentacion,
 * fecha_dictamen_estimada, etc.) y un rango DESDE / HASTA, con presets
 * útiles para el workflow legislativo de CL2 Consultoría.
 *
 * Se cablea en SilBrowsePage → FilterState + writeFiltersToUrl.
 * El backend (sil.ts /api/sil/expedientes) acepta:
 *   ?date_field=fecha_presentacion&date_from=2025-01-01&date_to=2025-12-31
 *
 * Implementado con <input type="date"> nativo (Tailwind styled) porque el
 * repo no tiene shadcn Calendar instalado.
 */
import { useState } from 'react';
import { Calendar, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FechaCampo =
  | 'fecha_presentacion'
  | 'fecha_dictamen_estimada'
  | 'fecha_publicacion_gaceta'
  | 'fecha_vence_subcomision'
  | 'fecha_cuatrienal'
  | 'fecha_ultimo_cambio';

const CAMPO_LABELS: Record<FechaCampo, string> = {
  fecha_presentacion: 'Fecha de presentación',
  fecha_dictamen_estimada: 'Dictamen estimado',
  fecha_publicacion_gaceta: 'Publicación en Gaceta',
  fecha_vence_subcomision: 'Vence en subcomisión',
  fecha_cuatrienal: 'Vencimiento cuatrienal',
  fecha_ultimo_cambio: 'Último cambio de estado',
};

const CAMPOS = Object.entries(CAMPO_LABELS) as [FechaCampo, string][];

export interface CalendarFilterProps {
  campo: FechaCampo;
  desde: string | null;
  hasta: string | null;
  onChange: (campo: FechaCampo, desde: string | null, hasta: string | null) => void;
}

// ─── Presets útiles para el workflow legislativo ────────────────────────────

interface Preset {
  label: string;
  resolve: () => { desde: string | null; hasta: string | null };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const PRESETS: Preset[] = [
  {
    label: 'Esta semana',
    resolve: () => {
      const now = new Date();
      const dow = now.getDay(); // 0=dom
      const monday = addDays(now, -(dow === 0 ? 6 : dow - 1));
      const sunday = addDays(monday, 6);
      return { desde: isoDate(monday), hasta: isoDate(sunday) };
    },
  },
  {
    label: 'Este mes',
    resolve: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { desde: isoDate(first), hasta: isoDate(last) };
    },
  },
  {
    label: 'Últimos 30 días',
    resolve: () => {
      const now = new Date();
      return { desde: isoDate(addDays(now, -30)), hasta: isoDate(now) };
    },
  },
  {
    label: 'Próximos a dictaminar (30 días)',
    resolve: () => {
      const now = new Date();
      return { desde: isoDate(now), hasta: isoDate(addDays(now, 30)) };
    },
  },
  {
    label: 'Próximos a vencer cuatrienal (60 días)',
    resolve: () => {
      const now = new Date();
      return { desde: isoDate(now), hasta: isoDate(addDays(now, 60)) };
    },
  },
];

// ─── Componente ─────────────────────────────────────────────────────────────

export function CalendarFilter({ campo, desde, hasta, onChange }: CalendarFilterProps) {
  const [open, setOpen] = useState(false);

  const hasFilter = desde !== null || hasta !== null;

  const handleClear = () => {
    onChange(campo, null, null);
    setOpen(false);
  };

  const handlePreset = (preset: Preset) => {
    const { desde: d, hasta: h } = preset.resolve();
    onChange(campo, d, h);
    setOpen(false);
  };

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
          'border border-[#0e1745]/[0.10] dark:border-white/[0.10]',
          'bg-white dark:bg-white/[0.05]',
          'text-[#0e1745] dark:text-white',
          'hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.08]',
          hasFilter && 'border-cl2-accent/40 bg-cl2-accent/[0.05] dark:bg-cl2-accent/[0.10]',
        )}
        aria-expanded={open}
        aria-label="Filtro por fecha"
      >
        <Calendar
          size={13}
          className={cn(
            'shrink-0',
            hasFilter ? 'text-cl2-accent' : 'text-[#0e1745]/50 dark:text-white/50',
          )}
        />
        <span>
          {hasFilter
            ? [desde && `Desde ${desde}`, hasta && `Hasta ${hasta}`]
                .filter(Boolean)
                .join(' · ')
            : 'Filtrar por fecha'}
        </span>
        {hasFilter ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClear(); }}
            className="ml-0.5 rounded-full p-0.5 hover:bg-[#0e1745]/10 dark:hover:bg-white/10"
            aria-label="Limpiar filtro de fecha"
          >
            <X size={11} />
          </button>
        ) : (
          <ChevronDown size={11} className="text-[#0e1745]/40 dark:text-white/40" />
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-20"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />

          <div
            className={cn(
              'absolute z-30 top-full mt-1.5 left-0',
              'w-[320px] rounded-xl border border-[#0e1745]/[0.08] dark:border-white/[0.10]',
              'bg-white dark:bg-[#1a1a2e] shadow-xl shadow-black/10',
              'p-4 flex flex-col gap-4',
            )}
          >
            {/* Campo selector */}
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
                Campo de fecha
              </label>
              <div className="relative">
                <select
                  value={campo}
                  onChange={(e) => onChange(e.target.value as FechaCampo, desde, hasta)}
                  className="w-full appearance-none rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] px-3 py-1.5 pr-7 text-[12.5px] text-[#0e1745] dark:text-white outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
                >
                  {CAMPOS.map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#0e1745]/45 dark:text-white/45"
                />
              </div>
            </div>

            {/* Rango de fechas */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
                  Desde
                </label>
                <input
                  type="date"
                  value={desde ?? ''}
                  onChange={(e) => onChange(campo, e.target.value || null, hasta)}
                  max={hasta ?? undefined}
                  className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
                  Hasta
                </label>
                <input
                  type="date"
                  value={hasta ?? ''}
                  onChange={(e) => onChange(campo, desde, e.target.value || null)}
                  min={desde ?? undefined}
                  className="w-full rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
                />
              </div>
            </div>

            {/* Presets */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
                Atajos
              </div>
              <div className="flex flex-col gap-1">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handlePreset(preset)}
                    className="text-left px-2.5 py-1.5 rounded-md text-[12px] text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Limpiar */}
            {hasFilter && (
              <button
                type="button"
                onClick={handleClear}
                className="inline-flex items-center justify-center gap-1 text-[11.5px] font-medium text-[#0e1745]/60 dark:text-white/60 hover:text-cl2-accent transition-colors pt-1 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]"
              >
                <X size={11} /> Limpiar filtro de fecha
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
