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
 * Cache: result lives in component state. On mount → fetch. The user's
 * session shouldn't change status mid-session frequently; if a manual
 * refresh is needed they can hit ⌘R.
 */
import { useEffect, useState } from 'react';
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

export function AccessGate({ children }: { children: React.ReactNode }) {
  const { user, logout } = useSupabaseStore();
  const [access, setAccess] = useState<AccessState>({ status: 'loading', role: null, email: null });

  useEffect(() => {
    let cancelled = false;
    if (!user) return;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me) {
          // 401 — token expirado o inválido. Forzar logout para que vuelva
          // al flow de Google sign-in (no a una pantalla rota).
          setAccess({ status: 'error', role: null, email: null });
          return;
        }
        setAccess({ status: me.status, role: me.role, email: me.email });
      } catch (err) {
        // Network/server error — degradamos a 'active' para no bloquear al
        // user por un hiccup. El BFF sigue siendo el gate real para escritura.
        // eslint-disable-next-line no-console
        console.error('AccessGate error, degrading to active:', err);
        if (!cancelled) setAccess({ status: 'active', role: 'lector', email: user.email ?? null });
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

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
