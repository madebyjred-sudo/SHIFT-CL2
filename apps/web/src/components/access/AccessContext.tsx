/**
 * AccessContext — expone status + role del user actual (de /api/me) a
 * cualquier descendiente del AccessGate. Usado por AdminApp para
 * bloquear el panel a non-admins, y por componentes que necesitan
 * conocer el role para condicionalmente mostrar acciones.
 */
import { createContext, useContext } from 'react';
import type { AccessRole, AccessStatus } from '@/services/accessApi';

export interface AccessInfo {
  status: AccessStatus | 'error';
  role: AccessRole;
  email: string | null;
}

const Ctx = createContext<AccessInfo>({ status: 'error', role: null, email: null });

export const AccessProvider = Ctx.Provider;

export function useAccess(): AccessInfo {
  return useContext(Ctx);
}

/** Helper: ¿el user tiene rol con acceso al admin panel? */
export function canAccessAdmin(role: AccessRole): boolean {
  return role === 'admin' || role === 'operador';
}
