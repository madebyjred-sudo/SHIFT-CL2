/**
 * Usuarios — equipo autorizado.
 *
 * Pulls from /api/admin/users (Supabase Auth admin.listUsers, with mock
 * fallback). Real actions:
 *   - "Invitar" opens an email + role modal that calls
 *     POST /api/admin/users/invite (server invokes Supabase
 *     auth.admin.inviteUserByEmail).
 *   - Per-row role pill becomes a popover where the operator picks
 *     the new role. PATCHes /api/admin/users/:id with the new value.
 *   - "Aprobar/Rechazar" on a `solicitud` row sets the role and the
 *     status implicitly (approve → lector, reject → audit only).
 */
import { useState } from 'react';
import { Shield, UserPlus, MoreHorizontal, X, Mail } from 'lucide-react';
import {
  ActionButton,
  Avatar,
  KPI,
  Pill,
  type PillKind,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import {
  fetchAdminUsers,
  inviteUser,
  patchUserRole,
  useAdminFetch,
  type AdminUser,
} from '@/services/adminApi';
import { useToast } from '../Toast';

const ROLES = ['admin', 'operador', 'editor', 'lector'] as const;
type Role = typeof ROLES[number];

export function UsuariosSection(): React.ReactElement {
  const users = useAdminFetch(fetchAdminUsers);
  const { notify, confirm } = useToast();
  const [showInvite, setShowInvite] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const items = users.data?.items ?? [];
  const active = items.filter((u) => u.status === 'activo').length;
  const invited = items.filter((u) => u.status === 'invitado').length;
  const requests = items.filter((u) => u.status === 'solicitud').length;

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((s) => {
      const out = new Set(s);
      if (on) out.add(id); else out.delete(id);
      return out;
    });

  const onApprove = async (u: AdminUser) => {
    setBusyFor(u.id, true);
    try {
      await patchUserRole(u.id, 'lector');
      notify({ kind: 'success', text: `${u.email} aprobado como lector` });
      void users.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo aprobar', detail: (err as Error).message });
    } finally {
      setBusyFor(u.id, false);
    }
  };

  const onReject = async (u: AdminUser) => {
    const ok = await confirm({
      title: `Rechazar a ${u.email}?`,
      description: 'El usuario no recibe acceso. La acción queda en el log de auditoría.',
      confirmLabel: 'Rechazar',
      destructive: true,
    });
    if (!ok) return;
    setBusyFor(u.id, true);
    try {
      // No real "reject" call; we use the audit endpoint via patchUserRole
      // with role='rejected' so the row gets an explicit decision.
      await patchUserRole(u.id, 'rejected');
      notify({ kind: 'success', text: `${u.email} rechazado` });
      void users.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo rechazar', detail: (err as Error).message });
    } finally {
      setBusyFor(u.id, false);
    }
  };

  const onSaveRole = async (id: string, role: Role) => {
    setBusyFor(id, true);
    try {
      await patchUserRole(id, role);
      notify({ kind: 'success', text: `Rol cambiado a ${role}` });
      setEditingUser(null);
      void users.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo cambiar rol', detail: (err as Error).message });
    } finally {
      setBusyFor(id, false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Acceso · Equipo autorizado"
        actions={
          <>
            <ActionButton
              variant="ghost"
              icon={Shield}
              onClick={() =>
                notify({
                  kind: 'info',
                  text: 'Roles actuales: admin, operador, editor, lector.',
                  detail: 'La gestión avanzada (permisos por sección) llega después del demo.',
                })
              }
            >
              Roles & permisos
            </ActionButton>
            <ActionButton variant="coral" icon={UserPlus} onClick={() => setShowInvite(true)}>
              Invitar
            </ActionButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <KPI label="Usuarios activos" value={String(active)} delta={`${active} vs ${invited} invitados`} deltaDir="flat" />
        <KPI label="Solicitudes pendientes" value={String(requests)} delta={requests > 0 ? 'requieren acción' : 'cola al día'} deltaDir={requests > 0 ? 'down' : 'flat'} />
        <KPI label="Sesiones · 7 días" value="—" delta="métrica pendiente" deltaDir="flat" />
      </div>

      <AdminTable<AdminUser>
        rowKey={(u) => u.id}
        rows={items}
        empty={
          users.loading
            ? <span className="text-[#0e1745]/55 dark:text-white/55">Cargando equipo…</span>
            : users.error
              ? <span className="text-rose-700 dark:text-rose-300">No se pudo cargar: {users.error}</span>
              : <span className="text-[#0e1745]/55 dark:text-white/55">No hay usuarios registrados.</span>
        }
        columns={[
          { header: '', cell: (u) => <Avatar initials={initialsFor(u.email)} color={colorFor(u.email)} />, width: '36px' },
          { header: 'Usuario', cell: (u) => <span className="font-semibold">{u.email.split('@')[0]}</span> },
          { header: 'Correo', cell: (u) => <span className="font-mono text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{u.email}</span> },
          {
            header: 'Rol',
            cell: (u) => (
              <button
                type="button"
                onClick={() => setEditingUser(u)}
                className="inline-flex items-center gap-1 hover:opacity-90"
                title="Cambiar rol"
              >
                {u.role ? (
                  <Pill kind={roleKind(u.role)}>{u.role}</Pill>
                ) : (
                  <Pill kind="neutral">sin rol</Pill>
                )}
              </button>
            ),
            width: '140px',
          },
          {
            header: 'Última actividad',
            cell: (u) => (
              <span className="text-[#0e1745]/55 dark:text-white/55">
                {u.last_sign_in_at ? formatRelative(new Date(u.last_sign_in_at)) : '—'}
              </span>
            ),
            width: '160px',
          },
          { header: 'Estado', cell: (u) => <Pill kind={statusKind(u.status)}>{u.status}</Pill>, width: '140px' },
          {
            header: '',
            cell: (u) =>
              u.status === 'solicitud' ? (
                <span className="flex justify-end gap-1.5">
                  <ActionButton variant="approve" size="sm" onClick={() => void onApprove(u)} disabled={busy.has(u.id)}>
                    Aprobar
                  </ActionButton>
                  <ActionButton variant="reject" size="sm" onClick={() => void onReject(u)} disabled={busy.has(u.id)}>
                    Rechazar
                  </ActionButton>
                </span>
              ) : (
                <ActionButton variant="quiet" icon={MoreHorizontal} onClick={() => setEditingUser(u)} />
              ),
            align: 'right',
            width: '180px',
          },
        ]}
      />

      {showInvite && (
        <InviteDialog
          onCancel={() => setShowInvite(false)}
          onSent={(email) => {
            notify({ kind: 'success', text: `Invitación enviada a ${email}` });
            setShowInvite(false);
            void users.refetch();
          }}
          onError={(err) => notify({ kind: 'error', text: 'No se pudo invitar', detail: err })}
        />
      )}

      {editingUser && (
        <RoleDialog
          user={editingUser}
          onCancel={() => setEditingUser(null)}
          onSave={(role) => void onSaveRole(editingUser.id, role)}
          busy={busy.has(editingUser.id)}
        />
      )}
    </>
  );
}

function InviteDialog(props: {
  onCancel: () => void;
  onSent: (email: string) => void;
  onError: (err: string) => void;
}): React.ReactElement {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('lector');
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    if (!email.includes('@')) {
      props.onError('Email inválido');
      return;
    }
    setBusy(true);
    try {
      await inviteUser(email, role);
      props.onSent(email);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[201] flex items-center justify-center bg-[#0e1745]/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={props.onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] p-5 shadow-[0_24px_60px_rgba(14,23,69,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
              Invitar usuario
            </div>
            <div className="font-display text-[20px] font-medium tracking-tight text-[#0e1745] dark:text-white">
              Nuevo acceso
            </div>
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded p-1 text-[#0e1745]/55 dark:text-white/55 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06]"
          >
            <X size={14} />
          </button>
        </div>

        <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
          Correo
        </label>
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3 py-2 focus-within:border-cl2-accent/40 focus-within:ring-2 focus-within:ring-cl2-accent/15">
          <Mail size={14} className="shrink-0 text-[#0e1745]/45 dark:text-white/45" />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nombre@asamblea.go.cr"
            className="flex-1 bg-transparent text-[13px] text-[#0e1745] dark:text-white outline-none"
            autoFocus
          />
        </div>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
          Rol
        </label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`rounded-full border px-3 py-1.5 text-[12px] capitalize transition-colors ${
                role === r
                  ? 'border-cl2-accent bg-cl2-accent/10 text-cl2-accent-hover dark:text-cl2-accent-soft font-semibold'
                  : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3.5 py-2 text-[12.5px] font-semibold text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={busy || !email}
            className="rounded-lg bg-cl2-accent px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(249,53,73,0.22)] hover:bg-cl2-accent-hover disabled:opacity-50"
          >
            {busy ? 'Enviando…' : 'Enviar invitación'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleDialog(props: {
  user: AdminUser;
  onCancel: () => void;
  onSave: (role: Role) => void;
  busy: boolean;
}): React.ReactElement {
  const [role, setRole] = useState<Role>((props.user.role as Role) ?? 'lector');

  return (
    <div
      className="fixed inset-0 z-[201] flex items-center justify-center bg-[#0e1745]/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={props.onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] p-5 shadow-[0_24px_60px_rgba(14,23,69,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <Avatar initials={initialsFor(props.user.email)} color={colorFor(props.user.email)} />
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
              Editar rol
            </div>
            <div className="truncate font-display text-[18px] font-medium tracking-tight text-[#0e1745] dark:text-white">
              {props.user.email}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`rounded-full border px-3 py-1.5 text-[12px] capitalize transition-colors ${
                role === r
                  ? 'border-cl2-accent bg-cl2-accent/10 text-cl2-accent-hover dark:text-cl2-accent-soft font-semibold'
                  : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3.5 py-2 text-[12.5px] font-semibold text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => props.onSave(role)}
            disabled={props.busy || role === props.user.role}
            className="rounded-lg bg-cl2-accent px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(249,53,73,0.22)] hover:bg-cl2-accent-hover disabled:opacity-50"
          >
            {props.busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

const ROLE_KIND: Record<string, PillKind> = {
  admin: 'coral',
  operador: 'lexa',
  editor: 'atlas',
  lector: 'neutral',
  rejected: 'danger',
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
