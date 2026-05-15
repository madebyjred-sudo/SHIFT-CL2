/**
 * EstadoPlenarioPage — /plenario/estado
 *
 * Dashboard "Estado del Plenario": muestra en tiempo real cuáles expedientes
 * están convocados (pueden discutirse HOY en Plenario) y cuáles fueron retirados,
 * según los decretos ejecutivos de la Presidenta de la República.
 *
 * CONTEXTO (Carlos Villalobos, reunión 2026-05-14):
 *   Durante sesiones extraordinarias (mayo-jul + nov-ene), el Ejecutivo controla
 *   la agenda del Plenario vía decretos. La lista puede cambiar varias veces por
 *   día hábil. Este dashboard refleja el estado tras el último decreto procesado.
 *
 * ESTRUCTURA:
 *   1. Hero: contador de expedientes vivos + badge de sesiones extraordinarias
 *   2. Cards de métricas: convocados / retirados / último decreto / fecha
 *   3. Últimos 5 decretos (chips color-coded: verde=ampliación, rojo=retiro)
 *   4. Tabla de expedientes vivos paginada
 *
 * Source: Track D, Sprint 1. Jred 2026-05-14.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle, XCircle, AlertCircle, Calendar, RefreshCw,
  ExternalLink, FileText, ChevronLeft, ChevronRight, Loader2,
  Radio,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';
import {
  getEstadoPlenario, listDecretos, triggerIngestNow,
  type EstadoPlenario, type DecretoRow, type TopRecienteItem,
} from '@/services/decretosApi';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `hace ${days}d`;
  return new Date(iso).toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
}

function formatFecha(iso: string): string {
  // "2026-05-14" → "14 may 2026"
  return new Date(iso + 'T12:00:00').toLocaleDateString('es-CR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ─── Tipo chip (ampliacion / retiro / mixto) ──────────────────────────────────

type DecretoTipo = 'ampliacion' | 'retiro' | 'mixto';

const TIPO_LABEL: Record<DecretoTipo, string> = {
  ampliacion: 'Ampliación',
  retiro: 'Retiro',
  mixto: 'Mixto',
};

const TIPO_STYLES: Record<DecretoTipo, string> = {
  ampliacion: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700/40',
  retiro:     'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700/40',
  mixto:      'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700/40',
};

function TipoChip({ tipo }: { tipo: DecretoTipo }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
      TIPO_STYLES[tipo],
    )}>
      {TIPO_LABEL[tipo]}
    </span>
  );
}

// ─── Metric card ──────────────────────────────────────────────────────────────

function MetricCard({
  icon: Icon,
  label,
  value,
  sublabel,
  color = 'default',
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sublabel?: string;
  color?: 'default' | 'green' | 'red' | 'amber';
}) {
  const iconStyles: Record<string, string> = {
    default: 'text-[#0e1745]/40 dark:text-white/40',
    green:   'text-emerald-600 dark:text-emerald-400',
    red:     'text-red-600 dark:text-red-400',
    amber:   'text-amber-600 dark:text-amber-400',
  };
  const valueStyles: Record<string, string> = {
    default: 'text-[#0e1745] dark:text-white',
    green:   'text-emerald-700 dark:text-emerald-300',
    red:     'text-red-700 dark:text-red-300',
    amber:   'text-amber-700 dark:text-amber-300',
  };

  return (
    <div className="bg-white dark:bg-white/[0.03] border border-black/8 dark:border-white/8 rounded-2xl p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={cn('w-4 h-4', iconStyles[color])} />
        <span className="text-xs text-[#0e1745]/55 dark:text-white/55 font-medium">{label}</span>
      </div>
      <div className={cn('text-3xl font-bold tabular-nums', valueStyles[color])}>
        {value}
      </div>
      {sublabel && (
        <div className="text-xs text-[#0e1745]/45 dark:text-white/45">{sublabel}</div>
      )}
    </div>
  );
}

// ─── Fila de expediente vivo ──────────────────────────────────────────────────

function ExpedienteVivo({ item }: { item: TopRecienteItem }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-black/5 dark:border-white/5 bg-white dark:bg-white/[0.02] hover:bg-black/[0.02] dark:hover:bg-white/[0.05] transition-colors cursor-pointer group"
      onClick={() => navigate(`/expediente/${item.expediente_id.replace('.', '')}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/expediente/${item.expediente_id.replace('.', '')}`); }}
    >
      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
      <span className="font-mono text-sm font-semibold text-[#0e1745] dark:text-white">
        {item.expediente_id}
      </span>
      <span className="text-xs text-[#0e1745]/45 dark:text-white/45 ml-auto shrink-0">
        desde {formatFecha(item.fecha_decreto)}
      </span>
      <ExternalLink className="w-3 h-3 text-[#0e1745]/30 dark:text-white/30 group-hover:text-[#0e1745]/60 dark:group-hover:text-white/60 transition-colors shrink-0" />
    </div>
  );
}

// ─── Fila de decreto reciente ─────────────────────────────────────────────────

function DecretoRow({ decreto }: { decreto: DecretoRow }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-black/8 dark:border-white/8 bg-white dark:bg-white/[0.03] hover:bg-black/[0.02] dark:hover:bg-white/[0.05] transition-colors">
      <FileText className="w-4 h-4 text-[#0e1745]/40 dark:text-white/40 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[#0e1745] dark:text-white truncate">
            {decreto.numero_decreto ?? 'Decreto sin número'}
          </span>
          <TipoChip tipo={decreto.tipo} />
        </div>
        {decreto.periodo_legislativo && (
          <div className="text-[11px] text-[#0e1745]/45 dark:text-white/45 mt-0.5 truncate">
            {decreto.periodo_legislativo}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className="text-xs font-medium text-[#0e1745]/60 dark:text-white/60">
          {formatFecha(decreto.fecha)}
        </span>
        {decreto.documento_url && (
          <a
            href={decreto.documento_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            PDF <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Tabla paginada de expedientes convocados ─────────────────────────────────

function TablaConvocados({
  items,
  page,
  per_page,
  total,
  onPage,
}: {
  items: TopRecienteItem[];
  page: number;
  per_page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const total_pages = Math.ceil(total / per_page);

  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-[#0e1745]/45 dark:text-white/45">
        <CheckCircle className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No hay expedientes convocados en este momento.</p>
        <p className="text-xs mt-1">La lista se actualiza con cada decreto ejecutivo procesado.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <ExpedienteVivo key={item.expediente_id} item={item} />
        ))}
      </div>

      {total_pages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-black/8 dark:border-white/8">
          <span className="text-xs text-[#0e1745]/45 dark:text-white/45">
            {total} expedientes convocados · página {page} de {total_pages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPage(page - 1)}
              disabled={page <= 1}
              className="p-1.5 rounded-lg disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              aria-label="Página anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPage(page + 1)}
              disabled={page >= total_pages}
              className="p-1.5 rounded-lg disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              aria-label="Página siguiente"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page principal ───────────────────────────────────────────────────────────

export function EstadoPlenarioPage() {
  const [estado, setEstado] = useState<EstadoPlenario | null>(null);
  const [decretos, setDecretos] = useState<DecretoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paginación local de los top expedientes convocados
  const [expPage, setExpPage] = useState(1);
  const EXP_PER_PAGE = 10;

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const [estadoData, decretosData] = await Promise.all([
        getEstadoPlenario(),
        listDecretos({ page: 1, per_page: 5 }),
      ]);
      setEstado(estadoData);
      setDecretos(decretosData.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleIngest = async () => {
    setIngestLoading(true);
    try {
      const result = await triggerIngestNow();
      // Recargar estado después de ingestar
      await load({ silent: true });
      // Mostrar resultado en console para debug (y futuro toast)
      console.info('[EstadoPlenario] ingest result', result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIngestLoading(false);
    }
  };

  // ── Paginación local del top de expedientes ────────────────────────────────
  const allExpedientes = estado?.top_recientes ?? [];
  // Usamos el total real del backend para el contador
  const totalConvocados = estado?.total_convocados ?? 0;
  const startIdx = (expPage - 1) * EXP_PER_PAGE;
  const pageExpedientes = allExpedientes.slice(startIdx, startIdx + EXP_PER_PAGE);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white flex flex-col">
        <TopDock onOpenHistory={() => {}} onToggleHistory={() => {}} isHistoryOpen={false} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-[#0e1745]/40 dark:text-white/40">
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="text-sm">Cargando estado del Plenario...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white flex flex-col">
      <TopDock onOpenHistory={() => {}} onToggleHistory={() => {}} isHistoryOpen={false} />

      <main className="flex-1 px-4 sm:px-6 md:px-8 pt-6 pb-16 max-w-5xl mx-auto w-full">

        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold uppercase tracking-widest text-[#0e1745]/40 dark:text-white/40">
                  Agenda legislativa
                </span>
                {estado?.en_sesiones_extraordinarias && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700/40">
                    <Radio className="w-2.5 h-2.5" />
                    Sesiones extraordinarias
                  </span>
                )}
              </div>
              <h1 className="text-3xl font-bold tracking-tight">
                Estado del Plenario
              </h1>
              <p className="mt-1.5 text-sm text-[#0e1745]/55 dark:text-white/55 max-w-xl">
                Expedientes que <strong>pueden discutirse hoy</strong> en el Plenario
                según los decretos ejecutivos vigentes de la Presidenta de la República.
                Actualizado cada 30 minutos.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void load({ silent: true })}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#0e1745]/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors border border-black/8 dark:border-white/8 disabled:opacity-50"
                aria-label="Actualizar"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                Actualizar
              </button>

              <button
                onClick={() => void handleIngest()}
                disabled={ingestLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0e1745] dark:bg-white text-white dark:text-[#0e1745] hover:opacity-90 transition-opacity border border-[#0e1745] dark:border-white disabled:opacity-50"
                title="Forzar ingesta de nuevos decretos del SharePoint ahora"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', ingestLoading && 'animate-spin')} />
                {ingestLoading ? 'Ingiriendo...' : 'Ingerir ahora'}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {estado?.calculado_at && (
            <div className="mt-2 text-xs text-[#0e1745]/35 dark:text-white/35">
              Calculado {relativeTime(estado.calculado_at)}
            </div>
          )}
        </div>

        {/* ── Metric cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <MetricCard
            icon={CheckCircle}
            label="Expedientes convocados"
            value={estado?.total_convocados ?? 0}
            sublabel="En agenda viva del Plenario"
            color="green"
          />
          <MetricCard
            icon={XCircle}
            label="Expedientes retirados"
            value={estado?.total_retirados ?? 0}
            sublabel="Última acción: retiro"
            color="red"
          />
          <MetricCard
            icon={Calendar}
            label="Último decreto"
            value={estado?.ultimo_decreto ? formatFecha(estado.ultimo_decreto.fecha) : '—'}
            sublabel={estado?.ultimo_decreto?.numero_decreto ?? undefined}
            color="default"
          />
          <MetricCard
            icon={FileText}
            label="Tipo último decreto"
            value={estado?.ultimo_decreto ? TIPO_LABEL[estado.ultimo_decreto.tipo] : '—'}
            sublabel="ampliación / retiro / mixto"
            color={estado?.ultimo_decreto?.tipo === 'ampliacion' ? 'green' : estado?.ultimo_decreto?.tipo === 'retiro' ? 'red' : 'amber'}
          />
        </div>

        {/* ── Contenido principal ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

          {/* ─ Expedientes convocados (col 3) ──────────────────────────── */}
          <section className="lg:col-span-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">
                Expedientes en agenda viva
              </h2>
              <span className="text-xs text-[#0e1745]/45 dark:text-white/45">
                {totalConvocados} total
              </span>
            </div>

            <div className="bg-white dark:bg-white/[0.03] border border-black/8 dark:border-white/8 rounded-2xl p-4">
              <TablaConvocados
                items={pageExpedientes}
                page={expPage}
                per_page={EXP_PER_PAGE}
                total={totalConvocados}
                onPage={setExpPage}
              />
            </div>
          </section>

          {/* ─ Últimos decretos (col 2) ───────────────────────────────── */}
          <section className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">
                Decretos recientes
              </h2>
              <button
                onClick={() => navigate('/plenario/decretos')}
                className="text-xs text-[#0e1745]/45 dark:text-white/45 hover:text-[#0e1745] dark:hover:text-white transition-colors"
              >
                Ver todos
              </button>
            </div>

            {decretos.length === 0 ? (
              <div className="bg-white dark:bg-white/[0.03] border border-black/8 dark:border-white/8 rounded-2xl p-8 text-center text-sm text-[#0e1745]/45 dark:text-white/45">
                <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Sin decretos procesados aún.</p>
                <p className="text-xs mt-1">Usa "Ingerir ahora" para procesar decretos del SharePoint.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {decretos.map((d) => (
                  <DecretoRow key={d.id} decreto={d} />
                ))}
              </div>
            )}

            {/* Info contextual */}
            <div className="mt-4 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/30">
              <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">
                Fuente: SharePoint GLCP
              </p>
              <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
                Lista <code className="font-mono">Decretos_Ejecutivos_Ampliacion</code> de la Asamblea
                Legislativa. 201 decretos históricos. Crawler cada 30 min.
              </p>
            </div>
          </section>
        </div>

      </main>
    </div>
  );
}
