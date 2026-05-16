/**
 * AccessGate — wraps the app after Supabase auth and before any private
 * surface. Consults /api/me to decide if the current user can enter:
 *
 *   • status='active' → render children (the full app)
 *   • status='pending' → render PendingApprovalScreen
 *   • status='rejected' → render RejectedAccessScreen
 *   • status='suspended' → same RejectedAccessScreen w/ different copy
 *   • network failure → degrade to "active" (don't lock the user out for a
 *     transient API hiccup; the BFF middleware still gates writes)
 *
 * Refresh strategy: re-fetcheamos en (a) mount, (b) window focus, y (c) cada
 * 60 segundos en background. Esto cubre el caso del admin que aprueba a un
 * user en otra pestaña — el user no necesita hacer logout/login para tomar
 * el role nuevo, basta con volver a la pestaña.
 */
import { useEffect, useState, useCallback } from 'react';
import { useSupabaseStore } from '@/store/useSupabaseStore';
import { fetchMe, type AccessStatus, type AccessRole } from '@/services/accessApi';
import { PendingApprovalScreen } from './PendingApprovalScreen';
import { RejectedAccessScreen } from './RejectedAccessScreen';
import { AccessProvider } from './AccessContext';

interface AccessState {
  status: AccessStatus | 'loading' | 'error';
  role: AccessRole;
  email: string | null;
}

const REFRESH_INTERVAL_MS = 60_000;

export function AccessGate({ children }: { children: React.ReactNode }) {
  const { user, logout } = useSupabaseStore();
  const [access, setAccess] = useState<AccessState>({ status: 'loading', role: null, email: null });

  // Re-utilizable: refetch sin reiniciar al estado loading (refresh silencioso).
  const refresh = useCallback(async (isInitial: boolean) => {
    if (!user) return;
    try {
      const me = await fetchMe();
      if (!me) {
        // 401 — token expirado o inválido. NO degradar a 'lector' (eso oculta
        // permisos reales). Marcar error y dejar al user ver children con role
        // null — la app muestra fallback adecuado. Si pasa repetido, el user
        // hace logout manual.
        setAccess({ status: 'error', role: null, email: null });
        return;
      }
      setAccess({ status: me.status, role: me.role, email: me.email });
    } catch (err) {
      // Network/server error — solo degradamos en el INITIAL load para no
      // bloquear al user por un hiccup. En refresh silencioso ignoramos.
      if (isInitial) {
        // eslint-disable-next-line no-console
        console.error('AccessGate initial fetch error, degrading to active:', err);
        setAccess({ status: 'active', role: 'lector', email: user.email ?? null });
      }
      // En silent refresh ignoramos el error y mantenemos el estado anterior.
    }
  }, [user]);

  // Initial fetch
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await refresh(true);
    })();
    return () => { cancelled = true; };
  }, [user, refresh]);

  // Refresh on window focus (cubre admin-aprueba-en-otra-pestaña).
  useEffect(() => {
    if (!user) return;
    const onFocus = () => { void refresh(false); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user, refresh]);

  // Refresh periódico cada 60s (cubre cambio de role mientras la pestaña
  // está abierta sin perder foco).
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { void refresh(false); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user, refresh]);

  if (access.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 rounded-full border-2 border-white/20 border-t-white animate-spin" />
          <div className="text-[12.5px] text-white/60">Verificando acceso…</div>
        </div>
      </div>
    );
  }

  if (access.status === 'pending') {
    return <PendingApprovalScreen email={access.email} onLogout={() => void logout()} />;
  }

  if (access.status === 'rejected' || access.status === 'suspended') {
    return (
      <RejectedAccessScreen
        kind={access.status}
        email={access.email}
        onLogout={() => void logout()}
      />
    );
  }

  // active or error (degraded) → render the app + expose access info via context
  return (
    <AccessProvider value={{ status: access.status, role: access.role, email: access.email }}>
      {children}
    </AccessProvider>
  );
}
