/**
 * /sesiones v2 — diseño editorial + descubrimiento.
 *
 * Reemplaza la lista vertical plana del v1 por un sistema en tres capas:
 *
 *   1. Hero editorial con título Newsreader, KPIs y densidad heatmap
 *      de los últimos 30 días.
 *   2. Toolbar sticky con search + quick chips temporales + toggle de
 *      vista (lista/calendario).
 *   3. Layout de 3 columnas en desktop:
 *      - rail izquierdo de filtros (estado / duración / con resumen)
 *      - feed central agrupado por bucket temporal (Esta semana, Marzo…)
 *      - rail derecho con "Tema del momento" (fallback "Más recientes"
 *        hasta que el endpoint /api/sessions/topics exista).
 *
 * Estado de la query vive en URL search params para que los links sean
 * compartibles. Compare-mode prepara la selección; el modal de diff se
 * difiere a post-demo (ver CompareDock).
 *
 * Diseño base: shift-cl2-design-system/ui_kits/web/sesiones-v2/.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { fetchSessions, type SessionListItem } from '@/services/sessionsApi';
import { navigate, useRoute } from '@/lib/router';
import { TopDock } from '@/components/top-dock';
import { SesionesHero } from '@/components/sesiones/SesionesHero';
import { SesionesToolbar, type ViewMode } from '@/components/sesiones/SesionesToolbar';
import { FilterRail } from '@/components/sesiones/FilterRail';
import { SesionesFeed } from '@/components/sesiones/SesionesFeed';
import { CalendarView } from '@/components/sesiones/CalendarView';
import { TemaCard } from '@/components/sesiones/TemaCard';
import { CompareDock } from '@/components/sesiones/CompareDock';
import {
  applyDuracionFilter,
  applyEstadoFilter,
  applyQuery,
  applyQuickChip,
  type DuracionFilter,
  type EstadoFilter,
  type QuickChip,
} from '@/lib/sesiones-grouping';

interface FilterState {
  q: string;
  quickChip: QuickChip;
  estado: EstadoFilter;
  duracion: DuracionFilter;
  onlyResumen: boolean;
  view: ViewMode;
  /** ISO date YYYY-MM-DD when the user clicked a day in the calendar.
   *  Narrows the feed to that exact day. Null means "no day filter". */
  day: string | null;
}

const DEFAULTS: FilterState = {
  q: '',
  quickChip: 'todas',
  estado: 'todas',
  duracion: 'todas',
  onlyResumen: false,
  view: 'lista',
  day: null,
};

function readFiltersFromUrl(): FilterState {
  if (typeof window === 'undefined') return DEFAULTS;
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get('view');
  const dayRaw = sp.get('day');
  return {
    q: sp.get('q') ?? '',
    quickChip: (sp.get('chip') as QuickChip) ?? 'todas',
    estado: (sp.get('estado') as EstadoFilter) ?? 'todas',
    duracion: (sp.get('dur') as DuracionFilter) ?? 'todas',
    onlyResumen: sp.get('resumen') === '1',
    view: view === 'calendar' ? 'calendar' : 'lista',
    day: dayRaw && /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : null,
  };
}

function writeFiltersToUrl(f: FilterState) {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams();
  if (f.q) sp.set('q', f.q);
  if (f.quickChip !== 'todas') sp.set('chip', f.quickChip);
  if (f.estado !== 'todas') sp.set('estado', f.estado);
  if (f.duracion !== 'todas') sp.set('dur', f.duracion);
  if (f.onlyResumen) sp.set('resumen', '1');
  if (f.view !== 'lista') sp.set('view', f.view);
  if (f.day) sp.set('day', f.day);
  const qs = sp.toString();
  const next = `/sesiones${qs ? `?${qs}` : ''}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState({}, '', next);
  }
}

export function SesionesListPage() {
  // Re-read filters when the route changes (back/forward).
  const route = useRoute();
  const [filters, setFiltersState] = useState<FilterState>(readFiltersFromUrl);
  useEffect(() => {
    setFiltersState(readFiltersFromUrl());
  }, [route]);
  const setFilters = useCallback((patch: Partial<FilterState>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      writeFiltersToUrl(next);
      return next;
    });
  }, []);

  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  // Derived data — pure transforms over the loaded list.
  const today = useMemo(() => new Date(), []);
  const all = items ?? [];

  const filtered = useMemo(() => {
    if (!items) return [];
    let xs = items;
    xs = applyQuery(xs, filters.q);
    xs = applyQuickChip(xs, filters.quickChip, today);
    xs = applyEstadoFilter(xs, filters.estado);
    xs = applyDuracionFilter(xs, filters.duracion);
    if (filters.onlyResumen) xs = xs.filter((s) => s.has_resumen);
    if (filters.day) {
      // Narrow to the picked day. Sessions store fecha as ISO with
      // timezone — we compare the date portion (first 10 chars) so
      // "2026-03-25T20:48:40Z" matches "2026-03-25" regardless of TZ.
      xs = xs.filter((s) => s.fecha.slice(0, 10) === filters.day);
    }
    return xs;
  }, [items, filters, today]);

  const recentForTema = useMemo(() => {
    return [...all]
      .sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha))
      .slice(0, 5);
  }, [all]);

  const heroCollapsed = filters.q.length > 0;

  const onCardClick = (id: number) => navigate(`/sesiones/${id}`);
  const onToggleSelect = (id: number) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const onCalendarDayClick = (date: Date) => {
    // Use local date components (not toISOString) — the calendar
    // renders days in local TZ, but toISOString shifts to UTC and can
    // bump the date by ±1 across timezones. Building the YYYY-MM-DD
    // from local fields keeps the click→filter mapping intuitive.
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    const matches = all.filter((s) => s.fecha.slice(0, 10) === iso);

    // Empty day → no-op. The calendar already shows day density via
    // dots, so an empty click means the user explored a day they can
    // see has nothing. Better to ignore than to navigate to an empty
    // list view with the user wondering what just happened.
    if (matches.length === 0) return;

    // Single session → take them straight there. Saves a click.
    if (matches.length === 1) {
      navigate(`/sesiones/${matches[0]!.id}`);
      return;
    }

    // Multiple sessions → narrow the feed to that day and switch to
    // list view so the user picks visually. The active day chip
    // (rendered above the feed) makes the filter discoverable + a
    // one-click clear path back to the full month.
    setFilters({ view: 'lista', day: iso });
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      {/*
        Page-wide max-width container. Caps the readable column at
        1320px so the topbar, hero, toolbar and main panel never
        stretch across an ultrawide monitor edge-to-edge. Centered
        with mx-auto. Keeps `flex-col flex-1` so the inner stack
        still grows to fill vertical space; bg-mesh / pixel-dots stay
        on the outer div so the side margins paint the brand color
        (instead of going white) on huge screens.
      */}
      <div className="relative z-10 w-full max-w-[1320px] mx-auto flex flex-col flex-1">
      <TopDock />

      <AnimatePresence initial={false}>
        {!heroCollapsed && (
          <motion.div
            key="hero"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="relative z-10 overflow-hidden"
          >
            <SesionesHero />
          </motion.div>
        )}
      </AnimatePresence>

      <SesionesToolbar
        q={filters.q}
        onQ={(q) => setFilters({ q })}
        quickChip={filters.quickChip}
        onQuickChip={(quickChip) => setFilters({ quickChip })}
        view={filters.view}
        onView={(view) => setFilters({ view })}
        onUpload={() => navigate('/sesiones/subir')}
      />

      {/* Dashboard panel — same horizontal padding as TopDock so both edges
          line up; rounded-t-2xl + border-b-0 + soft shadow mirrors the
          TopDock's rounded-b-2xl + border-t-0 (the panel "rises from
          below"). Motion offset on mount reinforces the rising feel. */}
      <main className="relative z-10 flex-1 px-4 sm:px-5 md:px-6 pt-3 md:pt-4">
        <motion.div
          initial={{ y: 28, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="w-full border border-b-0 border-[#0e1745]/[0.06] dark:border-white/[0.04] rounded-t-2xl shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)] bg-white/50 dark:bg-white/[0.015] backdrop-blur-sm overflow-hidden"
        >
          <div className="grid gap-6 lg:gap-7 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_280px] p-5 md:p-6 lg:p-7">
            {/* LEFT — filters rail (collapses to nothing on small screens) */}
            <div className="hidden lg:block sticky top-[68px] self-start">
              <FilterRail
                sessions={all}
                estado={filters.estado}
                onEstado={(estado) => setFilters({ estado })}
                duracion={filters.duracion}
                onDuracion={(duracion) => setFilters({ duracion })}
                onlyResumen={filters.onlyResumen}
                onOnlyResumen={(onlyResumen) => setFilters({ onlyResumen })}
              />
            </div>

            {/* CENTER — feed or calendar */}
            <section className="min-w-0">
              {error && (
                <div className="rounded-xl border border-red-300/50 bg-red-50/60 dark:bg-red-500/10 dark:border-red-500/20 px-4 py-3 text-sm text-red-700 dark:text-red-300 mb-4">
                  No se pudo cargar el listado. {error}
                </div>
              )}

              {!items && !error && (
                <div className="grid gap-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-[96px] rounded-[10px] animate-pulse bg-[#0e1745]/[0.04] dark:bg-white/[0.04]"
                    />
                  ))}
                </div>
              )}

              {items && filters.view === 'lista' && (
                <>
                  {filters.day && (
                    <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cl2-accent/30 dark:border-cl2-accent/40 bg-cl2-accent/[0.06] dark:bg-cl2-accent/[0.10] pl-3 pr-1.5 py-1 text-[12px] text-cl2-accent-hover dark:text-cl2-accent-soft">
                      <span className="font-semibold">
                        Sesiones del {fmtFriendlyDay(filters.day)}
                      </span>
                      <span className="text-[#0e1745]/55 dark:text-white/55 tabular-nums">
                        ({filtered.length})
                      </span>
                      <button
                        type="button"
                        onClick={() => setFilters({ day: null })}
                        aria-label="Quitar filtro de fecha"
                        className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full hover:bg-cl2-accent/[0.18] dark:hover:bg-cl2-accent/[0.25] transition-colors"
                      >
                        <span className="text-[14px] leading-none">×</span>
                      </button>
                    </div>
                  )}
                  {filtered.length === 0 ? (
                    <FeedEmpty filters={filters} onClear={() => setFilters(DEFAULTS)} />
                  ) : (
                    <SesionesFeed
                      sessions={filtered}
                      selectable={selected.length > 0}
                      selected={selected}
                      onToggleSelect={onToggleSelect}
                      onClick={onCardClick}
                    />
                  )}
                </>
              )}

              {items && filters.view === 'calendar' && (
                <CalendarView
                  sessions={filtered}
                  onDayClick={onCalendarDayClick}
                />
              )}

              {/* Long-press / right-click affordance hint to enable compare. */}
              {items && selected.length === 0 && filtered.length > 1 && filters.view === 'lista' && (
                <p className="mt-6 text-[11px] text-[#0e1745]/40 dark:text-white/40 text-center">
                  Tip: shift+click en una card activa modo comparación entre plenarias.
                </p>
              )}
            </section>

            {/* RIGHT — tema rail (xl only) */}
            <aside className="hidden xl:block sticky top-[68px] self-start">
              <TemaCard topSessions={recentForTema} onItemClick={onCardClick} />
            </aside>
          </div>
        </motion.div>
      </main>
      </div>

      <CompareDock
        ids={selected}
        onClear={() => setSelected([])}
        onCompare={(ids) => {
          // post-demo: open a real diff modal. For now: surface a toast-like
          // hint and navigate to the first selected — at least gives the
          // user immediate value.
          console.warn('[compare] modal pendiente — ids seleccionados:', ids);
          alert('La vista de comparación llega en el próximo sprint. Por ahora podés abrir cada plenaria desde su card.');
        }}
      />
    </div>
  );
}

function fmtFriendlyDay(iso: string): string {
  // iso is YYYY-MM-DD. Build a Date in local TZ at noon to avoid
  // off-by-one rendering when the device is in a TZ behind UTC.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0);
  return dt.toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function FeedEmpty({ filters, onClear }: { filters: FilterState; onClear: () => void }) {
  const hasAny =
    filters.q.length > 0 ||
    filters.quickChip !== 'todas' ||
    filters.estado !== 'todas' ||
    filters.duracion !== 'todas' ||
    filters.onlyResumen ||
    filters.day !== null;
  return (
    <div className="text-center py-16 text-[#0e1745]/55 dark:text-white/55">
      <p className="text-sm">
        {hasAny
          ? 'No hay sesiones que cumplan los filtros actuales.'
          : 'Aún no hay sesiones cargadas.'}
      </p>
      {hasAny && (
        <button
          type="button"
          onClick={onClear}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-cl2-accent border border-cl2-accent/30 hover:bg-cl2-accent/[0.06] transition-colors"
        >
          Limpiar filtros
        </button>
      )}
    </div>
  );
}
