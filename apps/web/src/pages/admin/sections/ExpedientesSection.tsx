/**
 * Expedientes SIL — admin index of SIL records under tracking.
 *
 * The data layer here is intentionally simple: hits Supabase's
 * `sil_expedientes` directly (read-only, public-readable per RLS) for
 * the listing. Full-text search + pagination are deferred — hard to
 * design without first knowing what the operator queries by.
 */
import { useEffect, useState } from 'react';
import { Link as LinkIcon, Plus, ExternalLink, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  ActionButton,
  KPI,
  Pill,
  type PillKind,
  SectionHeader,
  Toggle,
} from '../primitives';
import { AdminTable } from '../Table';
import {
  fetchAdminSummary,
  fetchWatchlist,
  toggleWatchlist,
  useAdminFetch,
} from '@/services/adminApi';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

interface ExpedienteRow {
  id: number;
  numero: string;
  titulo: string | null;
  comision: string | null;
  estado: string | null;
  fecha_presentacion: string | null;
  proponente: string | null;
}

export function ExpedientesSection(): React.ReactElement {
  const { notify } = useToast();
  const summary = useAdminFetch(fetchAdminSummary);
  const watchlist = useAdminFetch(fetchWatchlist);
  const [rows, setRows] = useState<ExpedienteRow[] | null>(null);
  const [alerts, setAlerts] = useState<Set<number>>(new Set());
  const [busyAlerts, setBusyAlerts] = useState<Set<number>>(new Set());

  // Mirror server-side watchlist into local state on first load + after refetch.
  useEffect(() => {
    if (watchlist.data?.ids) setAlerts(new Set(watchlist.data.ids));
  }, [watchlist.data]);

  const load = async () => {
    const { data, error } = await supabase
      .from('sil_expedientes')
      .select('id, numero, titulo, comision, estado, fecha_presentacion, proponente')
      .order('id', { ascending: false })
      .limit(60);
    if (error) {
      // eslint-disable-next-line no-console
      console.error('expedientes load failed', error);
      setRows([]);
      return;
    }
    setRows(data ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAlertToggle = async (id: number, next: boolean) => {
    setBusyAlerts((s) => new Set(s).add(id));
    // Optimistic flip.
    setAlerts((s) => {
      const out = new Set(s);
      if (next) out.add(id); else out.delete(id);
      return out;
    });
    try {
      await toggleWatchlist(id, next ? 'add' : 'remove');
      notify({ kind: 'success', text: next ? `Alerta activada para Exp. ${id}` : `Alerta quitada para Exp. ${id}` });
    } catch (err) {
      // Revert on error.
      setAlerts((s) => {
        const out = new Set(s);
        if (next) out.delete(id); else out.add(id);
        return out;
      });
      notify({ kind: 'error', text: 'No se pudo guardar la alerta', detail: (err as Error).message });
    } finally {
      setBusyAlerts((s) => {
        const out = new Set(s);
        out.delete(id);
        return out;
      });
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Contenido · Expedientes SIL"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
            <ActionButton
              variant="ghost"
              icon={LinkIcon}
              onClick={() => {
                const url = window.prompt('Pegá la URL del expediente en consultassil3.asamblea.go.cr:');
                if (!url) return;
                const m = url.match(/expediente=(\d+)/i);
                if (m) {
                  navigate(`/expediente/${m[1]}`);
                } else {
                  notify({ kind: 'error', text: 'No reconocí el número de expediente en la URL' });
                }
              }}
            >
              Pegar URL del SIL
            </ActionButton>
            <ActionButton
              variant="coral"
              icon={Plus}
              onClick={() => {
                const num = window.prompt('Número de expediente (ej. 24604):');
                if (!num || !/^\d+$/.test(num)) return;
                navigate(`/expediente/${num}`);
              }}
            >
              Agregar expediente
            </ActionButton>
          </>
        }
      />

      {/* KPIs limpios — solo los dos que vienen de queries reales.
          Los KPIs "Con texto base 2.4k+" y "Con dictamen 33k+" se removieron
          (post-audit 2026-05-10): estaban hardcoded y nunca se actualizaban. */}
      <div className="mb-4 grid grid-cols-2 gap-3.5">
        <KPI label="Total registrados" value={summary.data ? summary.data.expedientes.toLocaleString('es-CR') : '—'} delta="en vivo" deltaDir="flat" />
        <KPI label="Mostrando arriba" value={rows ? String(rows.length) : '—'} delta="60 más recientes" deltaDir="flat" />
      </div>

      <AdminTable<ExpedienteRow>
        rowKey={(r) => String(r.id)}
        rows={rows ?? []}
        empty={
          rows === null
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando…</span>
            : <span className="text-[#0e1745]/55 dark:text-white/55">No hay expedientes en la base aún.</span>
        }
        onRowClick={(r) => navigate(`/expediente/${r.id}`)}
        columns={[
          {
            header: 'Expediente',
            cell: (r) => (
              <span className="font-mono font-semibold text-cl2-burgundy dark:text-[#d8a4ad]">Exp. {r.numero}</span>
            ),
            width: '120px',
          },
          {
            header: 'Título',
            cell: (r) => (
              <span className="block max-w-[420px] truncate" title={r.titulo ?? ''}>
                {r.titulo ?? '(sin título)'}
              </span>
            ),
          },
          {
            header: 'Comisión',
            cell: (r) =>
              r.comision ? <Pill kind="lexa">{r.comision}</Pill> : <span className="text-[#0e1745]/55 dark:text-white/55">—</span>,
            width: '160px',
          },
          {
            header: 'Estado',
            cell: (r) =>
              r.estado ? <Pill kind={estadoKind(r.estado)}>{r.estado}</Pill> : <span className="text-[#0e1745]/55 dark:text-white/55">—</span>,
            width: '160px',
          },
          {
            header: 'Última act.',
            cell: (r) => (
              <span className="tabular-nums text-[#0e1745]/55 dark:text-white/55">
                {r.fecha_presentacion
                  ? new Date(r.fecha_presentacion).toLocaleDateString('es-CR', {
                      day: '2-digit', month: 'short', year: 'numeric',
                    })
                  : '—'}
              </span>
            ),
            width: '120px',
          },
          {
            header: 'Alerta',
            cell: (r) => (
              <span
                onClick={(e) => e.stopPropagation()}
                title={busyAlerts.has(r.id) ? 'Guardando…' : alerts.has(r.id) ? 'Quitar de mi lista' : 'Agregar a mi lista'}
              >
                <Toggle
                  on={alerts.has(r.id)}
                  onChange={(next) => void handleAlertToggle(r.id, next)}
                  coral
                />
              </span>
            ),
            width: '80px',
          },
          {
            header: '',
            cell: (r) => (
              <a
                href={`/expediente/${r.id}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
              >
                <ExternalLink size={12} />
              </a>
            ),
            width: '60px',
            align: 'right',
          },
        ]}
      />
    </>
  );
}

function estadoKind(estado: string): PillKind {
  const e = estado.toLowerCase();
  if (e.includes('plenario') || e.includes('aprobado')) return 'success';
  if (e.includes('archivo')) return 'neutral';
  if (e.includes('dictamen')) return 'info';
  if (e.includes('comisión') || e.includes('subcomisión')) return 'warn';
  return 'neutral';
}
