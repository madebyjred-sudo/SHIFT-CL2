/**
 * Auditoría — system + human action log.
 *
 * Source: /api/admin/audit (mock today). When the real audit_logs
 * table lands in Supabase, swap the source — UI doesn't need to change.
 */
import { Filter, Download } from 'lucide-react';
import {
  ActionButton,
  Avatar,
  Pill,
  type PillKind,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import { fetchAudit, useAdminFetch, type AuditEntry } from '@/services/adminApi';

export function AuditoriaSection(): React.ReactElement {
  const audit = useAdminFetch(fetchAudit);
  const items = audit.data?.items ?? [];

  return (
    <>
      <SectionHeader
        eyebrow="Sistema · Auditoría"
        actions={
          <>
            <ActionButton variant="ghost" icon={Filter}>
              Filtrar
            </ActionButton>
            <ActionButton variant="ghost" icon={Download}>
              Exportar CSV
            </ActionButton>
          </>
        }
      />

      {audit.isMock && (
        <div className="mb-3 inline-flex">
          <Pill kind="warn">Datos de demostración — el backend de auditoría aún no persiste.</Pill>
        </div>
      )}

      <AdminTable<AuditEntry>
        rowKey={(_, i) => String(i)}
        rows={items}
        empty={
          audit.loading
            ? <span className="text-[#0e1745]/55">Cargando…</span>
            : <span className="text-[#0e1745]/55">Sin entradas en el log.</span>
        }
        columns={[
          {
            header: 'Cuándo',
            cell: (e) => (
              <span className="font-mono text-[11.5px] tabular-nums text-[#0e1745]/55">
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
                <Avatar initials={e.actor} color="#7A3B47" size="sm" />
              ),
            width: '100px',
          },
          {
            header: 'Acción',
            cell: (e) => <span className="font-semibold">{e.verb}</span>,
            width: '120px',
          },
          {
            header: 'Recurso',
            cell: (e) => <span className="text-[#0e1745]/65">{e.resource}</span>,
          },
          {
            header: 'IP',
            cell: (e) => (
              <span className="font-mono text-[11px] text-[#0e1745]/55">{e.ip ?? '—'}</span>
            ),
            width: '120px',
          },
          {
            header: 'Resultado',
            cell: (e) => (
              <Pill kind={e.result === 'ok' ? 'success' : e.result === 'retry' ? 'warn' : 'danger'}>
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
