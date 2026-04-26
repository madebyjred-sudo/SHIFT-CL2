/**
 * Usuarios — equipo autorizado.
 *
 * Pulls from /api/admin/users which proxies Supabase Auth's listUsers
 * (server-side admin SDK). Falls back to a small mock when the SDK is
 * unavailable in the deploy. Invite + role-edit flows are stubbed —
 * surfaced in the UI so operator can ask for them, but not wired.
 */
import { Shield, UserPlus, MoreHorizontal } from 'lucide-react';
import {
  ActionButton,
  Avatar,
  KPI,
  Pill,
  type PillKind,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import { fetchAdminUsers, useAdminFetch, type AdminUser } from '@/services/adminApi';

export function UsuariosSection(): React.ReactElement {
  const users = useAdminFetch(fetchAdminUsers);
  const items = users.data?.items ?? [];
  const active = items.filter((u) => u.status === 'activo').length;
  const invited = items.filter((u) => u.status === 'invitado').length;
  const requests = items.filter((u) => u.status === 'solicitud').length;

  return (
    <>
      <SectionHeader
        eyebrow="Acceso · Equipo autorizado"
        actions={
          <>
            <ActionButton variant="ghost" icon={Shield}>
              Roles & permisos
            </ActionButton>
            <ActionButton variant="coral" icon={UserPlus}>
              Invitar
            </ActionButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <KPI label="Usuarios activos" value={String(active)} delta={`+${active - invited} este mes`} />
        <KPI label="Solicitudes pendientes" value={String(requests)} delta="hace > 48h" deltaDir="down" />
        <KPI label="Sesiones · 7 días" value="—" delta="métrica pendiente" deltaDir="flat" />
      </div>

      <AdminTable<AdminUser>
        rowKey={(u) => u.id}
        rows={items}
        empty={
          users.loading
            ? <span className="text-[#0e1745]/55">Cargando equipo…</span>
            : users.error
              ? <span className="text-[#b91c1c]">No se pudo cargar: {users.error}</span>
              : <span className="text-[#0e1745]/55">No hay usuarios registrados.</span>
        }
        columns={[
          {
            header: '',
            cell: (u) => <Avatar initials={initialsFor(u.email)} color={colorFor(u.email)} />,
            width: '36px',
          },
          {
            header: 'Usuario',
            cell: (u) => <span className="font-semibold">{u.email.split('@')[0]}</span>,
          },
          {
            header: 'Correo',
            cell: (u) => <span className="font-mono text-[11.5px] text-[#0e1745]/55">{u.email}</span>,
          },
          {
            header: 'Rol',
            cell: (u) =>
              u.role ? (
                <Pill kind={roleKind(u.role)}>{u.role}</Pill>
              ) : (
                <span className="text-[#0e1745]/55">—</span>
              ),
            width: '120px',
          },
          {
            header: 'Última actividad',
            cell: (u) => (
              <span className="text-[#0e1745]/55">
                {u.last_sign_in_at ? formatRelative(new Date(u.last_sign_in_at)) : '—'}
              </span>
            ),
            width: '160px',
          },
          {
            header: 'Estado',
            cell: (u) => <Pill kind={statusKind(u.status)}>{u.status}</Pill>,
            width: '140px',
          },
          {
            header: '',
            cell: (u) =>
              u.status === 'solicitud' ? (
                <span className="flex justify-end gap-1.5">
                  <ActionButton variant="approve" size="sm">
                    Aprobar
                  </ActionButton>
                  <ActionButton variant="reject" size="sm">
                    Rechazar
                  </ActionButton>
                </span>
              ) : (
                <ActionButton variant="quiet" icon={MoreHorizontal} />
              ),
            align: 'right',
            width: '180px',
          },
        ]}
      />
    </>
  );
}

const ROLE_KIND: Record<string, PillKind> = {
  admin: 'coral',
  operador: 'lexa',
  editor: 'atlas',
  lector: 'neutral',
};
function roleKind(role: string): PillKind {
  return ROLE_KIND[role] ?? 'neutral';
}

function statusKind(status: string): PillKind {
  if (status === 'activo') return 'success';
  if (status === 'invitado') return 'warn';
  if (status === 'solicitud') return 'danger';
  if (status === 'inactivo') return 'neutral';
  return 'neutral';
}

function initialsFor(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.replace(/[._-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function colorFor(seed: string): string {
  const palette = ['#7A3B47', '#8B6E54', '#F43F5E', '#1534dc', '#10b981', '#F93549'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hoy ${d.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' })}`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `hace ${days} día${days > 1 ? 's' : ''}`;
  return d.toLocaleDateString('es-CR', { day: '2-digit', month: 'short' });
}
