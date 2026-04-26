/**
 * Auditoría — system + human action log.
 *
 * Live source: /api/admin/audit (Supabase audit_log). Filters server-
 * side via querystring. CSV export hits /api/admin/audit.csv which
 * streams a properly-escaped file.
 */
import { useEffect, useState } from 'react';
import { Filter, Download, RefreshCw, X } from 'lucide-react';
import {
  ActionButton,
  Avatar,
  Card,
  Pill,
  type PillKind,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import { fetchAudit, auditCsvUrl, type AuditEntry } from '@/services/adminApi';
import { useToast } from '../Toast';

interface Filters {
  actor_kind?: 'human' | 'system';
  verb?: string;
  from?: string;
  to?: string;
}

export function AuditoriaSection(): React.ReactElement {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [showFilters, setShowFilters] = useState(false);
  const { notify } = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const env = await fetchAudit(filters);
      setItems(env.data.items);
    } catch (err) {
      setError((err as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.actor_kind, filters.verb, filters.from, filters.to]);

  const exportCsv = () => {
    // The endpoint sets Content-Disposition; opening it in a new tab
    // triggers the browser download. No need to fetch the body
    // ourselves — keeps memory low for big exports.
    window.open(auditCsvUrl(), '_blank');
    notify({ kind: 'success', text: 'CSV descargando…' });
  };

  const filterCount = Object.values(filters).filter((v) => v != null && v !== '').length;

  return (
    <>
      <SectionHeader
        eyebrow="Sistema · Auditoría"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
            <ActionButton variant="ghost" icon={Filter} onClick={() => setShowFilters((v) => !v)}>
              Filtros{filterCount > 0 ? ` (${filterCount})` : ''}
            </ActionButton>
            <ActionButton variant="ghost" icon={Download} onClick={exportCsv}>
              Exportar CSV
            </ActionButton>
          </>
        }
      />

      {showFilters && (
        <Card className="mb-3">
          <div className="grid grid-cols-1 gap-3 px-[18px] py-3.5 sm:grid-cols-4">
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Actor
              </label>
              <select
                value={filters.actor_kind ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    actor_kind: e.target.value === '' ? undefined : (e.target.value as 'human' | 'system'),
                  }))
                }
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              >
                <option value="">cualquiera</option>
                <option value="human">humano</option>
                <option value="system">sistema</option>
              </select>
            </div>
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Acción contiene
              </label>
              <input
                value={filters.verb ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, verb: e.target.value === '' ? undefined : e.target.value }))
                }
                placeholder="aprobó, falló, …"
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
                Desde
              </label>
              <input
                type="date"
                value={filters.from?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                  }))
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
                value={filters.to?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    to: e.target.value ? new Date(e.target.value + 'T23:59:59Z').toISOString() : undefined,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 py-1.5 text-[12.5px] text-[#0e1745] dark:text-white outline-none"
              />
            </div>
          </div>
          {filterCount > 0 && (
            <div className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] px-[18px] py-2.5">
              <button
                type="button"
                onClick={() => setFilters({})}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
              >
                <X size={11} /> Limpiar filtros
              </button>
            </div>
          )}
        </Card>
      )}

      {error && (
        <Card className="mb-3">
          <div className="px-[18px] py-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            No se pudo cargar el log: {error}
          </div>
        </Card>
      )}

      <AdminTable<AuditEntry>
        rowKey={(_, i) => String(i)}
        rows={items ?? []}
        empty={
          loading
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando…</span>
            : <span className="text-[#0e1745]/55 dark:text-white/55">Sin entradas en el log para los filtros aplicados.</span>
        }
        columns={[
          {
            header: 'Cuándo',
            cell: (e) => (
              <span className="font-mono text-[11.5px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
                {formatTs(e.ts)}
              </span>
            ),
            width: '170px',
          },
          {
            header: 'Actor',
            cell: (e) =>
              e.actor_kind === 'system' ? (
                <Pill kind="info">sistema</Pill>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Avatar initials={e.actor} color="#7A3B47" size="sm" />
                  <span className="text-[11.5px] text-[#0e1745]/65 dark:text-white/65">
                    {e.actor_email?.split('@')[0] ?? '—'}
                  </span>
                </span>
              ),
            width: '180px',
          },
          { header: 'Acción', cell: (e) => <span className="font-semibold">{e.verb}</span>, width: '160px' },
          { header: 'Recurso', cell: (e) => <span className="text-[#0e1745]/65 dark:text-white/65">{e.resource}</span> },
          {
            header: 'IP',
            cell: (e) => (
              <span className="font-mono text-[11px] text-[#0e1745]/55 dark:text-white/55">{e.ip ?? '—'}</span>
            ),
            width: '130px',
          },
          {
            header: 'Resultado',
            cell: (e) => (
              <Pill kind={(e.result === 'ok' ? 'success' : e.result === 'retry' ? 'warn' : 'danger') as PillKind}>
                {e.result}
              </Pill>
            ),
            width: '100px',
          },
        ]}
      />
    </>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('es-CR', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}
