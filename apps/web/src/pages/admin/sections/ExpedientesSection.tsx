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
import { fetchAdminSummary, useAdminFetch } from '@/services/adminApi';
import { navigate } from '@/lib/router';

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
  const summary = useAdminFetch(fetchAdminSummary);
  const [rows, setRows] = useState<ExpedienteRow[] | null>(null);
  const [alerts, setAlerts] = useState<Set<number>>(new Set([0]));

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

  return (
    <>
      <SectionHeader
        eyebrow="Contenido · Expedientes SIL"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
            <ActionButton variant="ghost" icon={LinkIcon}>
              Pegar URL del SIL
            </ActionButton>
            <ActionButton variant="coral" icon={Plus}>
              Agregar expediente
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KPI label="Total en DB" value={summary.data ? summary.data.expedientes.toLocaleString('es-CR') : '—'} delta="live · Supabase" deltaDir="flat" />
        <KPI label="Mostrando arriba" value={rows ? String(rows.length) : '—'} delta="60 más recientes" deltaDir="flat" />
        <KPI label="Con texto base" value="2.4k+" delta="post bulk DOCX" deltaDir="up" />
        <KPI label="Con dictamen" value="33k+" delta="chunks indexados" deltaDir="up" />
      </div>

      <AdminTable<ExpedienteRow>
        rowKey={(r) => String(r.id)}
        rows={rows ?? []}
        empty={
          rows === null
            ? <span className="text-[#0e1745]/55">Cargando…</span>
            : <span className="text-[#0e1745]/55">No hay expedientes en la base aún.</span>
        }
        onRowClick={(r) => navigate(`/expediente/${r.id}`)}
        columns={[
          {
            header: 'Expediente',
            cell: (r) => (
              <span className="font-mono font-semibold text-[#7A3B47]">Exp. {r.numero}</span>
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
              r.comision ? <Pill kind="lexa">{r.comision}</Pill> : <span className="text-[#0e1745]/55">—</span>,
            width: '160px',
          },
          {
            header: 'Estado',
            cell: (r) =>
              r.estado ? <Pill kind={estadoKind(r.estado)}>{r.estado}</Pill> : <span className="text-[#0e1745]/55">—</span>,
            width: '160px',
          },
          {
            header: 'Última act.',
            cell: (r) => (
              <span className="tabular-nums text-[#0e1745]/55">
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
              <span onClick={(e) => e.stopPropagation()}>
                <Toggle
                  on={alerts.has(r.id)}
                  onChange={(next) =>
                    setAlerts((s) => {
                      const out = new Set(s);
                      next ? out.add(r.id) : out.delete(r.id);
                      return out;
                    })
                  }
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
                className="inline-flex items-center gap-1 text-[#0e1745]/65 hover:text-[#0e1745]"
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
