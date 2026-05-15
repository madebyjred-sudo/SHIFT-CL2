/**
 * /sil — manual browse surface over the SIL catalog.
 *
 * Default mode is INDEXED-ONLY: the user only sees expedientes for
 * which CL2 has at least one document downloaded + parsed. Hotlinks
 * to the SIL oficial are gated behind an explicit "include metadata"
 * toggle, so the page never feels like a launchpad away from the
 * product.
 *
 * Layout mirrors /sesiones for muscle-memory continuity:
 *   max-w-1320 → TopDock → coverage hero → toolbar → 3-col panel
 *
 * Row identity:
 *   - `indexed` (status: 'indexed') → primary cards, navigate to
 *     /expediente/:numero (rich detail view, RAG-backed).
 *   - `metadata` (status: 'metadata') → only visible when toggle is
 *     ON. Visually dimmed, "Ver en SIL ↗" as the only action.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Search,
  Folder,
  ChevronDown,
  X,
  ExternalLink,
  FileText,
  Filter,
  Sparkles,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { Sidebar } from '@/components/sidebar';
import { navigate, useRoute } from '@/lib/router';
import {
  fetchSilCoverage,
  fetchSilExpedientes,
  fetchSilFacets,
  type SilCoverage,
  type SilExpedienteListItem,
  type SilFacets,
  type SilListQuery,
  type FechaCampo,
} from '@/services/silBrowseApi';
import { CalendarFilter } from '@/components/sil/CalendarFilter';
import { cn } from '@/lib/utils';

interface FilterState {
  q: string;
  comision: string | null;
  estado: string | null;
  tipo: string | null;
  year: number | null;
  includeMetadata: boolean;
  dateCampo: FechaCampo;
  dateDesde: string | null;
  dateHasta: string | null;
}

const DEFAULTS: FilterState = {
  q: '',
  comision: null,
  estado: null,
  tipo: null,
  year: null,
  includeMetadata: false,
  dateCampo: 'fecha_presentacion',
  dateDesde: null,
  dateHasta: null,
};

const PAGE_SIZE = 50;

const DATE_CAMPO_VALID = new Set<string>([
  'fecha_presentacion', 'fecha_dictamen_estimada', 'fecha_publicacion_gaceta',
  'fecha_vence_subcomision', 'fecha_cuatrienal', 'fecha_ultimo_cambio',
]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readFiltersFromUrl(): FilterState {
  if (typeof window === 'undefined') return DEFAULTS;
  const sp = new URLSearchParams(window.location.search);
  const yearRaw = sp.get('year');
  const rawCampo = sp.get('date_field') ?? '';
  const rawDesde = sp.get('date_from') ?? '';
  const rawHasta = sp.get('date_to') ?? '';
  return {
    q: sp.get('q') ?? '',
    comision: sp.get('comision') || null,
    estado: sp.get('estado') || null,
    tipo: sp.get('tipo') || null,
    year: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    includeMetadata: sp.get('all') === '1',
    dateCampo: DATE_CAMPO_VALID.has(rawCampo) ? (rawCampo as FechaCampo) : 'fecha_presentacion',
    dateDesde: ISO_DATE_RE.test(rawDesde) ? rawDesde : null,
    dateHasta: ISO_DATE_RE.test(rawHasta) ? rawHasta : null,
  };
}

function writeFiltersToUrl(f: FilterState) {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams();
  if (f.q) sp.set('q', f.q);
  if (f.comision) sp.set('comision', f.comision);
  if (f.estado) sp.set('estado', f.estado);
  if (f.tipo) sp.set('tipo', f.tipo);
  if (f.year) sp.set('year', String(f.year));
  if (f.includeMetadata) sp.set('all', '1');
  if (f.dateDesde || f.dateHasta) {
    sp.set('date_field', f.dateCampo);
    if (f.dateDesde) sp.set('date_from', f.dateDesde);
    if (f.dateHasta) sp.set('date_to', f.dateHasta);
  }
  const qs = sp.toString();
  const next = `/sil${qs ? `?${qs}` : ''}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState({}, '', next);
  }
}

export function SilBrowsePage() {
  const route = useRoute();
  const [filters, setFiltersState] = useState<FilterState>(readFiltersFromUrl);
  useEffect(() => { setFiltersState(readFiltersFromUrl()); }, [route]);
  const setFilters = (patch: Partial<FilterState>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      writeFiltersToUrl(next);
      return next;
    });
    setOffset(0); // any filter change resets pagination
  };

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

  const [coverage, setCoverage] = useState<SilCoverage | null>(null);
  const [facets, setFacets] = useState<SilFacets | null>(null);
  const [items, setItems] = useState<SilExpedienteListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search input to avoid hammering the BFF on every keystroke.
  const [debouncedQ, setDebouncedQ] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 250);
    return () => clearTimeout(t);
  }, [filters.q]);

  // First-paint: coverage + facets in parallel.
  useEffect(() => {
    let alive = true;
    Promise.all([fetchSilCoverage(), fetchSilFacets()])
      .then(([c, f]) => {
        if (!alive) return;
        setCoverage(c);
        setFacets(f);
      })
      .catch((err) => {
        if (!alive) return;
        setError((err as Error).message);
      });
    return () => { alive = false; };
  }, []);

  // List fetch — runs whenever filters or pagination change.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const query: SilListQuery = {
      q: debouncedQ || undefined,
      comision: filters.comision ?? undefined,
      estado: filters.estado ?? undefined,
      tipo: filters.tipo ?? undefined,
      year: filters.year ?? undefined,
      include_metadata: filters.includeMetadata || undefined,
      limit: PAGE_SIZE,
      offset,
      ...(filters.dateDesde || filters.dateHasta
        ? {
            date_field: filters.dateCampo,
            date_from: filters.dateDesde ?? undefined,
            date_to: filters.dateHasta ?? undefined,
          }
        : {}),
    };
    fetchSilExpedientes(query)
      .then((r) => {
        if (!alive) return;
        // When offset === 0 we replace; otherwise we append (Cargar más).
        setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
        setTotal(r.total);
      })
      .catch((err) => {
        if (!alive) return;
        setError((err as Error).message);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [
    debouncedQ,
    filters.comision,
    filters.estado,
    filters.tipo,
    filters.year,
    filters.includeMetadata,
    filters.dateCampo,
    filters.dateDesde,
    filters.dateHasta,
    offset,
  ]);

  const activeFilterCount =
    (filters.comision ? 1 : 0) +
    (filters.estado ? 1 : 0) +
    (filters.tipo ? 1 : 0) +
    (filters.year ? 1 : 0) +
    (filters.dateDesde || filters.dateHasta ? 1 : 0);

  const canLoadMore = items.length < total;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <div className="relative z-10 w-full max-w-[1320px] mx-auto flex flex-col flex-1">
        <TopDock
          onOpenHistory={() => setIsMobileDrawerOpen(true)}
          onToggleHistory={() => setIsHistoryOpen((v) => !v)}
          isHistoryOpen={isHistoryOpen}
        />

        {/* Hero — coverage stats. The honest numbers up top. */}
        <header className="px-4 sm:px-5 md:px-6 pt-6 md:pt-7 pb-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45 mb-1.5">
            Sistema de Información Legislativa
          </div>
          <h1 className="font-display font-light text-[28px] sm:text-[34px] leading-[1.05] tracking-tight text-[#0e1745] dark:text-white">
            Catálogo de expedientes —{' '}
            <em className="not-italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft italic">
              navegable, citable
            </em>
            .
          </h1>
          {coverage && (
            <CoverageStrip coverage={coverage} includeMetadata={filters.includeMetadata} />
          )}
        </header>

        {/* Toolbar card */}
        <div className="px-4 sm:px-5 md:px-6 pt-1">
          <div
            className={cn(
              'w-full rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06]',
              'bg-white/80 dark:bg-[#231f1f]/85 backdrop-blur-md',
              'shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)]',
            )}
          >
            <div className="flex flex-wrap items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3">
              <div className="relative flex-1 min-w-[240px] max-w-[520px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#0e1745]/40 dark:text-white/40" />
                <input
                  type="text"
                  value={filters.q}
                  onChange={(e) => setFilters({ q: e.target.value })}
                  placeholder="Número (24.604) o palabra del título…"
                  aria-label="Buscar expediente"
                  className={cn(
                    'w-full pl-9 pr-3 py-2 rounded-md text-[13px]',
                    'bg-white dark:bg-white/[0.05] border border-[#0e1745]/[0.10] dark:border-white/[0.10]',
                    'placeholder:text-[#0e1745]/40 dark:placeholder:text-white/40',
                    'transition focus:outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15',
                  )}
                />
              </div>
              <span className="text-[11.5px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
                {loading && items.length === 0
                  ? 'Cargando…'
                  : `${total.toLocaleString('es-CR')} resultado${total === 1 ? '' : 's'}`}
              </span>
              <span className="flex-1" />
              {/* Include-metadata toggle. Default OFF: only stuff we have body for.
                  Flipping it ON adds the broader DB browse path (hotlink-only). */}
              <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#0e1745]/[0.04] dark:bg-white/[0.05] border border-[#0e1745]/[0.06] dark:border-white/[0.08] cursor-pointer text-[12px] text-[#0e1745]/75 dark:text-white/75 hover:bg-[#0e1745]/[0.06] dark:hover:bg-white/[0.08] transition-colors">
                <input
                  type="checkbox"
                  checked={filters.includeMetadata}
                  onChange={(e) => setFilters({ includeMetadata: e.target.checked })}
                  className="accent-cl2-accent"
                />
                <span>Incluir solo-metadata</span>
              </label>
            </div>
          </div>
        </div>

        {/* Main panel */}
        <main className="relative z-10 flex-1 px-4 sm:px-5 md:px-6 pt-3 md:pt-4">
          <motion.div
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="w-full border border-b-0 border-[#0e1745]/[0.06] dark:border-white/[0.04] rounded-t-2xl shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)] bg-white/50 dark:bg-white/[0.015] backdrop-blur-sm overflow-hidden"
          >
            <div className="grid gap-5 lg:gap-6 lg:grid-cols-[220px_minmax(0,1fr)] p-5 md:p-6">
              {/* Filter rail */}
              <aside className="hidden lg:block sticky top-[68px] self-start space-y-4">
                {facets && (
                  <>
                    <FilterDropdown
                      label="Comisión"
                      value={filters.comision}
                      options={facets.comisiones}
                      onChange={(v) => setFilters({ comision: v })}
                    />
                    <FilterDropdown
                      label="Estado"
                      value={filters.estado}
                      options={facets.estados}
                      onChange={(v) => setFilters({ estado: v })}
                    />
                    <FilterDropdown
                      label="Tipo"
                      value={filters.tipo}
                      options={facets.tipos}
                      onChange={(v) => setFilters({ tipo: v })}
                    />
                    <FilterDropdown
                      label="Año de presentación"
                      value={filters.year != null ? String(filters.year) : null}
                      options={facets.years.map(String)}
                      onChange={(v) => setFilters({ year: v ? Number(v) : null })}
                    />
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
                        Por calendario
                      </label>
                      <CalendarFilter
                        campo={filters.dateCampo}
                        desde={filters.dateDesde}
                        hasta={filters.dateHasta}
                        onChange={(campo, desde, hasta) =>
                          setFilters({ dateCampo: campo, dateDesde: desde, dateHasta: hasta })
                        }
                      />
                    </div>
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setFilters({
                            comision: null,
                            estado: null,
                            tipo: null,
                            year: null,
                            dateDesde: null,
                            dateHasta: null,
                          })
                        }
                        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-cl2-accent transition-colors"
                      >
                        <X size={11} /> Limpiar {activeFilterCount} filtro
                        {activeFilterCount > 1 ? 's' : ''}
                      </button>
                    )}
                  </>
                )}
              </aside>

              {/* Feed */}
              <section className="min-w-0">
                {/* Mobile filter chip row */}
                <div className="flex items-center gap-2 mb-3 lg:hidden text-[11px] text-[#0e1745]/55 dark:text-white/55">
                  <Filter size={12} />
                  <span>Filtros disponibles en pantalla más grande</span>
                </div>

                {error && (
                  <div className="rounded-xl border border-rose-300/40 bg-rose-50/60 dark:bg-rose-500/10 dark:border-rose-500/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300 mb-4">
                    No se pudo cargar: {error}
                  </div>
                )}

                {loading && items.length === 0 ? (
                  <div className="grid gap-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-[88px] rounded-[10px] animate-pulse bg-[#0e1745]/[0.04] dark:bg-white/[0.04]"
                      />
                    ))}
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState filters={filters} setFilters={setFilters} coverage={coverage} />
                ) : (
                  <>
                    <ul className="grid gap-2.5">
                      {items.map((it) => (
                        <ExpedienteCard key={it.id} item={it} />
                      ))}
                    </ul>
                    {canLoadMore && (
                      <div className="mt-5 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setOffset(items.length)}
                          disabled={loading}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-white dark:bg-white/[0.05] border border-[#0e1745]/[0.10] dark:border-white/[0.10] text-[12.5px] font-medium text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10] transition-colors disabled:opacity-50"
                        >
                          {loading ? 'Cargando…' : `Cargar ${Math.min(PAGE_SIZE, total - items.length)} más`}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          </motion.div>
        </main>
      </div>

      <Sidebar
        open={isMobileDrawerOpen}
        onClose={() => setIsMobileDrawerOpen(false)}
        variant="drawer"
        side="left"
        className="lg:hidden"
      />
    </div>
  );
}

// ─── Coverage strip ──────────────────────────────────────────────────

function CoverageStrip({
  coverage,
  includeMetadata,
}: {
  coverage: SilCoverage;
  includeMetadata: boolean;
}) {
  // Two metrics matter: total documents indexed (the searchable corpus
  // size — what RAG actually ranks over) AND the distinct expedientes
  // those docs come from. The big number is `indexed_doc_count`
  // (~22k doc rows post bulk-DOCX ingest); the secondary line shows
  // expedientes covered (~6.3k) so the hero strip is still honest.
  const indexedDocs = coverage.indexed_doc_count;
  const indexedExpedientes = coverage.indexed_count;
  const pending = coverage.buckets.pending_in_active;
  const legacy = coverage.buckets.legacy_1997_2022;
  const historical = coverage.buckets.historical_pre_1997;

  return (
    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      <Tile
        label="Documentos indexados"
        value={indexedDocs.toLocaleString('es-CR')}
        sub={`en ${indexedExpedientes.toLocaleString('es-CR')} expedientes`}
        emphasis
      />
      <Tile
        label="Pendientes"
        value={pending.toLocaleString('es-CR')}
        sub="legislatura 2022-2026"
      />
      <Tile
        label="Solo metadata"
        value={legacy.toLocaleString('es-CR')}
        sub="1997 – 2022"
        muted={!includeMetadata}
      />
      <Tile
        label="Histórico"
        value={historical.toLocaleString('es-CR')}
        sub="pre-1997, sin texto"
        muted
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-2.5 transition-opacity',
        emphasis
          ? 'border-cl2-accent/30 bg-cl2-accent/[0.06] dark:bg-cl2-accent/[0.10]'
          : 'border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.02] dark:bg-white/[0.02]',
        muted && 'opacity-60',
      )}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 font-display text-[22px] font-normal leading-[1.05] tabular-nums',
          emphasis
            ? 'text-cl2-accent-hover dark:text-cl2-accent-soft'
            : 'text-[#0e1745] dark:text-white',
        )}
      >
        {value}
      </div>
      <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Filter dropdown ─────────────────────────────────────────────────

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50 mb-1.5">
        {label}
      </label>
      <div className="relative">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full appearance-none rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] px-3 py-1.5 pr-7 text-[12.5px] text-[#0e1745] dark:text-white outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
        >
          <option value="">Todas</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <ChevronDown
          size={13}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#0e1745]/45 dark:text-white/45"
        />
      </div>
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────

function ExpedienteCard({ item }: { item: SilExpedienteListItem }) {
  const isIndexed = item.status === 'indexed';
  const handleClick = () => {
    if (isIndexed) {
      // Prefer the dot-format numero ("23.511") to deep-link to the new
      // ExpedienteDashboardPage. Fall back to the integer id for legacy items
      // that don't have a formatted numero yet.
      const dest = item.numero ? `/expediente/${item.numero}` : `/expediente/${item.id}`;
      navigate(dest);
    } else if (item.url_detalle) {
      window.open(item.url_detalle, '_blank', 'noopener');
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'group/card w-full text-left rounded-[10px] border px-4 py-3 transition-all',
          'flex flex-col gap-2',
          isIndexed
            ? 'border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] hover:border-cl2-accent/30 hover:shadow-[0_4px_20px_rgba(14,23,69,0.06)] dark:hover:shadow-[0_4px_20px_rgba(0,0,0,0.20)]'
            : 'border-dashed border-[#0e1745]/15 dark:border-white/15 bg-[#0e1745]/[0.015] dark:bg-white/[0.015] opacity-75 hover:opacity-100',
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'shrink-0 mt-0.5 font-mono text-[12.5px] font-semibold tabular-nums',
              isIndexed
                ? 'text-cl2-burgundy dark:text-[#d8a4ad]'
                : 'text-[#0e1745]/55 dark:text-white/55',
            )}
          >
            Exp. {item.numero}
          </span>
          <span className="flex-1 text-[13px] leading-snug font-semibold text-[#0e1745] dark:text-white line-clamp-2">
            {item.titulo ?? '(sin título)'}
          </span>
          {isIndexed ? (
            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
              <FileText size={10} />
              {item.documentos_count}
              {item.documentos_count === 1 ? ' doc' : ' docs'}
            </span>
          ) : (
            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/65 dark:text-white/65 border border-[#0e1745]/[0.08] dark:border-white/[0.10] text-[10px] font-medium">
              <ExternalLink size={10} />
              SIL oficial
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#0e1745]/55 dark:text-white/55">
          {item.comision && <span>{item.comision}</span>}
          {item.estado && (
            <>
              <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
              <span>{item.estado}</span>
            </>
          )}
          {item.fecha_presentacion && (
            <>
              <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
              <span>
                {new Date(item.fecha_presentacion).toLocaleDateString('es-CR', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </>
          )}
          {item.proponente && (
            <>
              <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
              <span className="truncate max-w-[200px]" title={item.proponente}>
                Prop. {item.proponente}
              </span>
            </>
          )}
        </div>
      </button>
    </li>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────

function EmptyState({
  filters,
  setFilters,
  coverage,
}: {
  filters: FilterState;
  setFilters: (p: Partial<FilterState>) => void;
  coverage: SilCoverage | null;
}) {
  const hasFilters =
    filters.q.length > 0 || filters.comision || filters.estado || filters.tipo || filters.year
    || filters.dateDesde || filters.dateHasta;

  // Special case: zero indexed expedientes match AND user hasn't toggled
  // include_metadata. Recommend toggling to see the broader catalog.
  if (!filters.includeMetadata && !hasFilters && coverage && coverage.indexed_count === 0) {
    return (
      <div className="text-center py-12 px-4">
        <Folder size={28} className="mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/65 dark:text-white/65 max-w-md mx-auto">
          Aún no hay expedientes indexados localmente. El bulk de descarga corre
          al margen — mientras tanto, podés explorar el catálogo completo del SIL.
        </p>
        <button
          type="button"
          onClick={() => setFilters({ includeMetadata: true })}
          className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cl2-accent text-white text-[12.5px] font-semibold hover:bg-cl2-accent-hover transition-colors"
        >
          <Sparkles size={12} /> Incluir solo-metadata
        </button>
      </div>
    );
  }

  return (
    <div className="text-center py-12 text-[#0e1745]/55 dark:text-white/55">
      <p className="text-sm">
        {hasFilters
          ? 'No hay expedientes que cumplan los filtros actuales.'
          : 'No hay expedientes en este modo.'}
      </p>
      {hasFilters && (
        <button
          type="button"
          onClick={() =>
            setFilters({ q: '', comision: null, estado: null, tipo: null, year: null, dateDesde: null, dateHasta: null })
          }
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-cl2-accent border border-cl2-accent/30 hover:bg-cl2-accent/[0.06] transition-colors"
        >
          Limpiar filtros
        </button>
      )}
    </div>
  );
}
