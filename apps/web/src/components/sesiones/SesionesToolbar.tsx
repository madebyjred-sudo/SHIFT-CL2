/**
 * Toolbar sticky — search + quick chips + view toggle.
 *
 * Replicates the TopDock card style (border, rounded, shadow, blur)
 * so visually it reads as a second card stacked under the topbar
 * instead of an edge-to-edge banner. The outer header carries the
 * sticky positioning + responsive horizontal padding; the inner div
 * is the actual card surface.
 *
 * Width: the page wrapper in SesionesListPage applies max-w to the
 * whole stack, so this component just goes `w-full` of its parent
 * and inherits the constraint. Don't add a max-w here — duplicating
 * it leads to drift when we tune the grid breakpoint.
 */
import { Search, List, CalendarDays, Plus } from 'lucide-react';
import type { QuickChip } from '@/lib/sesiones-grouping';
import { cn } from '@/lib/utils';

export type ViewMode = 'lista' | 'calendar';

interface Props {
  q: string;
  onQ: (q: string) => void;
  quickChip: QuickChip;
  onQuickChip: (chip: QuickChip) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  onUpload?: () => void;
}

const CHIP_OPTIONS: Array<{ key: QuickChip; label: string }> = [
  { key: 'esta',    label: 'Esta semana' },
  { key: 'mes',     label: 'Este mes' },
  { key: 'resumen', label: 'Con resumen' },
  { key: 'live',    label: 'En vivo' },
];

export function SesionesToolbar({
  q, onQ, quickChip, onQuickChip, view, onView, onUpload,
}: Props) {
  return (
    <header className="sticky top-0 z-[80] px-4 sm:px-5 md:px-6 pt-3">
      <div
        className={cn(
          'w-full rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06]',
          // Solid-ish surface with backdrop blur so the feed scrolling
          // behind reads soft. Same alpha + dark hex as TopDock so
          // both cards visually match.
          'bg-white/80 dark:bg-[#231f1f]/85 backdrop-blur-md',
          'shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)]',
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[220px] max-w-[480px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#0e1745]/40 dark:text-white/40" />
            <input
              type="text"
              value={q}
              onChange={(e) => onQ(e.target.value)}
              placeholder="Buscar plenaria por título…"
              aria-label="Buscar plenaria"
              className={cn(
                'w-full pl-9 pr-12 py-2 rounded-md text-[13px]',
                'bg-white dark:bg-white/[0.05] border border-[#0e1745]/[0.10] dark:border-white/[0.10]',
                'placeholder:text-[#0e1745]/40 dark:placeholder:text-white/40',
                'transition focus:outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15',
              )}
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/50 dark:text-white/50">
              ⌘K
            </kbd>
          </div>

          {/* Quick chips — scrollable on mobile */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide flex-wrap">
            {CHIP_OPTIONS.map((opt) => {
              const active = quickChip === opt.key;
              const isCoral = opt.key === 'resumen' || opt.key === 'live';
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => onQuickChip(active ? 'todas' : opt.key)}
                  className={cn(
                    'inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all',
                    'whitespace-nowrap',
                    active && !isCoral && 'bg-[#3D1820] text-white border-[#3D1820] hover:bg-[#2E1218]',
                    active && isCoral && 'bg-cl2-accent/[0.10] text-cl2-accent-hover border-cl2-accent/[0.20] dark:bg-cl2-accent/[0.18] dark:text-cl2-accent-soft dark:border-cl2-accent/[0.40]',
                    !active && 'bg-white dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/75 border-[#0e1745]/[0.10] dark:border-white/[0.12] hover:border-[#0e1745]/[0.20] dark:hover:border-white/[0.25] dark:hover:bg-white/[0.10]',
                  )}
                >
                  {opt.label}
                  {active && (
                    <span className="opacity-60 ml-0.5">×</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right cluster: view toggle + subir */}
          <div className="flex items-center gap-2 ml-auto">
            <div className="inline-flex p-0.5 rounded-lg bg-[#0e1745]/[0.06] dark:bg-white/[0.08] border border-[#0e1745]/[0.05] dark:border-white/[0.05]">
              <button
                onClick={() => onView('lista')}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs font-medium transition-colors',
                  view === 'lista'
                    ? 'bg-white dark:bg-white/[0.10] text-[#0e1745] dark:text-white shadow-sm'
                    : 'text-[#0e1745]/60 dark:text-white/60 hover:text-[#0e1745] dark:hover:text-white',
                )}
                aria-pressed={view === 'lista'}
                aria-label="Vista lista"
              >
                <List size={12} />
                Lista
              </button>
              <button
                onClick={() => onView('calendar')}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs font-medium transition-colors',
                  view === 'calendar'
                    ? 'bg-white dark:bg-white/[0.10] text-[#0e1745] dark:text-white shadow-sm'
                    : 'text-[#0e1745]/60 dark:text-white/60 hover:text-[#0e1745] dark:hover:text-white',
                )}
                aria-pressed={view === 'calendar'}
                aria-label="Vista calendario"
              >
                <CalendarDays size={12} />
                Calendario
              </button>
            </div>

            {onUpload && (
              <button
                type="button"
                onClick={onUpload}
                aria-label="Subir nueva sesión"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-cl2-accent text-white text-xs font-semibold hover:bg-cl2-accent-hover shadow-[0_4px_15px_rgba(249,53,73,0.25)] transition-all focus:outline-none focus:ring-2 focus:ring-cl2-accent/40"
              >
                <Plus size={12} strokeWidth={2.5} />
                <span className="hidden sm:inline">Subir sesión</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
