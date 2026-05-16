/**
 * Sesiones plenarias — admin view of the sessions table.
 *
 * Pulls from /api/sessions (legacy CL2 MariaDB via the BFF) — same
 * endpoint the public listing uses, just shown without filtering by
 * visibility so the operator sees stuck rows.
 *
 * Actions:
 *   - Row click → /sesiones/:id (existing viewer).
 *   - Filters: from/to + status. Re-fetches.
 *   - Row "···" → kebab menu with: open, copy id, copy youtube link.
 *   - "Subir sesión" → /sesiones/subir (existing).
 */
import { useEffect, useState } from 'react';
import {
  Filter,
  Upload,
  RefreshCw,
  MoreHorizontal,
  Eye,
  EyeOff,
  ExternalLink,
  Copy,
  Youtube,
  X,
} from 'lucide-react';
import {
  ActionButton,
  Card,
  Pill,
  type PillKind,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import { fetchSessions, type SessionListItem } from '@/services/sessionsApi';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

interface Row extends SessionListItem {
  estadoLabel: string;
  estadoKind: PillKind;
  transcriptionLabel: string;
  transcriptionKind: PillKind;
  visibilityLabel: 'visible' | 'oculta';
}

const ESTADO_MAP: Record<number, { label: string; kind: PillKind }> = {
  0: { label: 'En cola', kind: 'neutral' },
  1: { label: 'Procesando', kind: 'warn' },
  2: { label: 'Indexada', kind: 'success' },
  3: { label: 'Archivada', kind: 'neutral' },
  4: { label: 'Sensible', kind: 'danger' },
};

interface Filters {
  from?: string;
  to?: string;
  status?: 'all' | 'indexed' | 'pending';
  /** 'plenario' (default) = solo sesiones plenarias/comisiones largas (≥30min).
   *  'all' = incluye también clips de prensa, entrevistas y shorts del canal. */
  scope?: 'plenario' | 'all';
}

function decorate(item: SessionListItem): Row {
  const estado = ESTADO_MAP[item.estado] ?? { label: `estado ${item.estado}`, kind: 'neutral' as PillKind };
  return {
    ...item,
    estadoLabel: estado.label,
    estadoKind: estado.kind,
    transcriptionLabel: item.has_resumen ? 'Aprobada' : 'Pendiente',
    transcriptionKind: item.has_resumen ? 'success' : 'warn',
    visibilityLabel: item.estado === 2 || item.estado === 3 ? 'visible' : 'oculta',
  };
}

export function SesionesSection(): React.ReactElement {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // scope default 'plenario' — la sección se llama "Sesiones plenarias",
  // no es lugar para news clips ni entrevistas cortas.
  const [filters, setFilters] = useState<Filters>({ status: 'all', scope: 'plenario' });
  const [showFilters, setShowFilters] = useState(false);
  const [openMenu, setOpenMenu] = useState<number | string | null>(null);
  const { notify } = useToast();

  const load = async () => {
    setError(null);
    try {
      const data = await fetchSessions({
        from: filters.from,
        to: filters.to,
        type: filters.scope ?? 'plenario',
        // Admin tab: ve también las pending_review para saber qué viene en cola.
        // El feed público (/sesiones) NO pasa este flag, así que solo ve indexed.
        includePending: true,
      });
      let decorated = data.map(decorate);
      if (filters.status === 'indexed') {
        decorated = decorated.filter((r) => r.estado === 2 || r.estado === 3);
      } else if (filters.status === 'pending') {
        decorated = decorated.filter((r) => r.estado === 0 || r.estado === 1);
      }
      setRows(decorated);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, filters.status, filters.scope]);

  // Close any open kebab when clicking outside
  useEffect(() => {
    if (openMenu === null) return;
    const onClick = () => setOpenMenu(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [openMenu]);

  const filterCount =
    (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.status && filters.status !== 'all' ? 1 : 0);

  return (
    <>
      <SectionHeader
        eyebrow="Contenido · Sesiones plenarias"
        actions={
          <>
            {/* Toggle scope: por default ocultamos clips/entrevistas para que
                esta sección honre su nombre. El operador puede expandir si
                quiere ver el canal completo (ej. para auditar el sync). */}
            <div className="inline-flex overflow-hidden rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10">
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, scope: 'plenario' }))}
                className={
                  'px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ' +
                  ((filters.scope ?? 'plenario') === 'plenario'
                    ? 'bg-[#0e1745] text-white dark:bg-white dark:text-[#0e1745]'
                    : 'bg-transparent text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]')
                }
              >
                Solo plenarias
              </button>
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, scope: 'all' }))}
                className={
                  'px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ' +
                  (filters.scope === 'all'
                    ? 'bg-[#0e1745] text-white dark:bg-white dark:text-[#0e1745]'
                    : 'bg-transparent text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]')
                }
              >
                Todo el canal
              </button>
            </div>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
            <ActionButton variant="ghost" icon={Filter} onClick={() => setShowFilters((v) => !v)}>
              Filtros{filterCount > 0 ? ` (${filterCount})` : ''}
            </ActionButton>
            <ActionButton variant="coral" icon={Upload} onClick={() => navigate('/sesiones/subir')}>
              Subir sesión
            </ActionButton>
          </>
        }
      />

      {showFilters && (
        <Card className="mb-3">
          <div className="grid grid-cols-1 gap-3 px-[18px] py-3.5 sm:grid-cols-3">
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Estado
              </label>
              <select
                value={filters.status ?? 'all'}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, status: e.target.value as Filters['status'] }))
                }
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              >
                <option value="all">Todos</option>
                <option value="indexed">Indexadas / archivadas</option>
                <option value="pending">En cola / procesando</option>
              </select>
            </div>
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Desde
              </label>
              <input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, from: e.target.value || undefined }))
                }
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Hasta
              </label>
              <input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, to: e.target.value || undefined }))
                }
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              />
            </div>
          </div>
          {filterCount > 0 && (
            <div className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] px-[18px] py-2.5">
              <button
                type="button"
                onClick={() => setFilters({ status: 'all' })}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
              >
                <X size={11} /> Limpiar filtros
              </button>
            </div>
          )}
        </Card>
      )}

      {error && (
        <Card className="mb-4">
          <div className="px-[18px] py-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            No se pudo cargar: {error}
          </div>
        </Card>
      )}

      <AdminTable<Row>
        rowKey={(r) => String(r.id)}
        rows={rows ?? []}
        empty={
          rows === null
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando…</span>
            : <span className="text-[#0e1745]/55 dark:text-white/55">No hay sesiones que cumplan los filtros.</span>
        }
        onRowClick={(r) => navigate(`/sesiones/${r.id}`)}
        columns={[
          { header: 'Sesión', cell: (r) => <div className="font-semibold">{r.titulo}</div> },
          {
            header: 'Fecha',
            cell: (r) => (
              <span className="text-[#0e1745]/55 dark:text-white/55">
                {new Date(r.fecha).toLocaleDateString('es-CR', { day: '2-digit', month: 'short', year: 'numeric' })}
              </span>
            ),
            width: '140px',
          },
          {
            header: 'Duración',
            cell: (r) => (
              <span className="tabular-nums text-[#0e1745]/55 dark:text-white/55">{formatDuration(r.duration_s)}</span>
            ),
            width: '110px',
            align: 'right',
          },
          { header: 'Estado', cell: (r) => <Pill kind={r.estadoKind}>{r.estadoLabel}</Pill>, width: '120px' },
          { header: 'Transcripción', cell: (r) => <Pill kind={r.transcriptionKind}>{r.transcriptionLabel}</Pill>, width: '140px' },
          {
            header: 'Visibilidad',
            cell: (r) =>
              r.visibilityLabel === 'visible' ? (
                <Pill kind="success" icon={Eye}>visible</Pill>
              ) : (
                <Pill kind="neutral" icon={EyeOff}>oculta</Pill>
              ),
            width: '130px',
          },
          {
            header: '',
            cell: (r) => (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu((cur) => (cur === r.id ? null : r.id));
                }}
                className="relative inline-block"
              >
                <ActionButton variant="quiet" icon={MoreHorizontal} />
                {openMenu === r.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_8px_28px_rgba(14,23,69,0.14)]"
                  >
                    <MenuRow
                      icon={ExternalLink}
                      label="Abrir sesión"
                      onClick={() => {
                        navigate(`/sesiones/${r.id}`);
                        setOpenMenu(null);
                      }}
                    />
                    <MenuRow
                      icon={Copy}
                      label={`Copiar ID (${r.id})`}
                      onClick={() => {
                        void navigator.clipboard.writeText(String(r.id));
                        notify({ kind: 'success', text: 'ID copiado' });
                        setOpenMenu(null);
                      }}
                    />
                    {r.youtube_url && (
                      <MenuRow
                        icon={Youtube}
                        label="Copiar link YouTube"
                        onClick={() => {
                          void navigator.clipboard.writeText(r.youtube_url);
                          notify({ kind: 'success', text: 'YouTube link copiado' });
                          setOpenMenu(null);
                        }}
                      />
                    )}
                  </div>
                )}
              </span>
            ),
            width: '60px',
            align: 'right',
          },
        ]}
      />
    </>
  );
}

function MenuRow(props: { icon: typeof MoreHorizontal; label: string; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[12.5px] text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06]"
    >
      <Icon size={13} className="shrink-0 text-[#0e1745]/55 dark:text-white/55" />
      {props.label}
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
