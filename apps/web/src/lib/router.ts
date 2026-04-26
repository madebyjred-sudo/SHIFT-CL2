/**
 * Tiny path-based router. No react-router-dom dependency.
 *
 * Why: only 3 routes (/ chat, /sesiones, /sesiones/:id). A full router lib
 * is overkill for the demo and adds bundle weight. Upgrade if/when nested
 * layouts or loaders are needed.
 *
 * Use: useRoute() returns the current pathname; navigate(path) pushes state
 * and notifies listeners. Back/forward buttons work via popstate.
 */
import { useEffect, useState } from 'react';

const NAV_EVENT = 'app:navigate';

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname + window.location.search === path) return;
  if (opts.replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useRoute(): string {
  const [path, setPath] = useState<string>(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );

  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);

  return path;
}

/** Match `/sesiones/:id` → returns id or null. */
export function matchSesionId(path: string): string | null {
  const m = path.match(/^\/sesiones\/(\d+)\/?$/);
  return m ? m[1] : null;
}

/** Match `/expediente/:numero` → returns numero (string) or null. */
export function matchExpedienteNumero(path: string): string | null {
  const m = path.match(/^\/expediente\/(\d+)\/?$/);
  return m ? m[1] : null;
}

/** Match `/admin/punto-medio` (exact) — single page, no params. */
export function isAdminPuntoMedio(path: string): boolean {
  return /^\/admin\/punto-medio\/?$/.test(path);
}

/**
 * The admin console lives under /admin (with a sidebar nav) and exposes
 * one route per section. `matchAdminSection` returns the section id when
 * the path is /admin/<section>, or null if not an admin path. Exact path
 * /admin (no section) defaults to 'overview' downstream.
 */
export type AdminSection =
  | 'overview'
  | 'transcripciones'
  | 'agentes'
  | 'punto-medio'
  | 'sesiones'
  | 'expedientes'
  | 'usuarios'
  | 'auditoria'
  | 'config';

const ADMIN_SECTIONS: ReadonlyArray<AdminSection> = [
  'overview',
  'transcripciones',
  'agentes',
  'punto-medio',
  'sesiones',
  'expedientes',
  'usuarios',
  'auditoria',
  'config',
];

export function matchAdminSection(path: string): AdminSection | null {
  if (/^\/admin\/?$/.test(path)) return 'overview';
  const m = path.match(/^\/admin\/([a-z-]+)\/?$/);
  if (!m) return null;
  return ADMIN_SECTIONS.includes(m[1] as AdminSection) ? (m[1] as AdminSection) : null;
}
