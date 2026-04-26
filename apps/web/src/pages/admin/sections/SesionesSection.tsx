/**
 * Sesiones plenarias — admin view of the sessions table.
 *
 * Shows all sessions (regardless of visibility/status) so the operator
 * can spot ones stuck in "procesando" or with no transcription. Real
 * data via /api/sessions.
 */
import { useEffect, useState } from 'react';
import { Filter, Upload, RefreshCw, MoreHorizontal, Eye, EyeOff } from 'lucide-react';
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

  const load = async () => {
    setError(null);
    try {
      const data = await fetchSessions();
      setRows(data.map(decorate));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <SectionHeader
        eyebrow="Contenido · Sesiones plenarias"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
            <ActionButton variant="ghost" icon={Filter}>
              Filtros
            </ActionButton>
            <ActionButton variant="coral" icon={Upload} onClick={() => navigate('/sesiones/subir')}>
              Subir sesión
            </ActionButton>
          </>
        }
      />

      {error && (
        <Card className="mb-4">
          <div className="px-[18px] py-3 text-[12.5px] text-[#b91c1c]">No se pudo cargar: {error}</div>
        </Card>
      )}

      <AdminTable<Row>
        rowKey={(r) => String(r.id)}
        rows={rows ?? []}
        empty={
          rows === null
            ? <span className="text-[#0e1745]/55">Cargando…</span>
            : <span className="text-[#0e1745]/55">No hay sesiones registradas todavía.</span>
        }
        onRowClick={(r) => navigate(`/sesiones/${r.id}`)}
        columns={[
          {
            header: 'Sesión',
            cell: (r) => <div className="font-semibold">{r.titulo}</div>,
          },
          {
            header: 'Fecha',
            cell: (r) => (
              <span className="text-[#0e1745]/55">
                {new Date(r.fecha).toLocaleDateString('es-CR', {
                  day: '2-digit', month: 'short', year: 'numeric',
                })}
              </span>
            ),
            width: '140px',
          },
          {
            header: 'Duración',
            cell: (r) => (
              <span className="tabular-nums text-[#0e1745]/55">
                {formatDuration(r.duration_s)}
              </span>
            ),
            width: '110px',
            align: 'right',
          },
          {
            header: 'Estado',
            cell: (r) => <Pill kind={r.estadoKind}>{r.estadoLabel}</Pill>,
            width: '120px',
          },
          {
            header: 'Transcripción',
            cell: (r) => <Pill kind={r.transcriptionKind}>{r.transcriptionLabel}</Pill>,
            width: '140px',
          },
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
            cell: () => (
              <span onClick={(e) => e.stopPropagation()}>
                <ActionButton variant="quiet" icon={MoreHorizontal} />
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

function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
