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

/** Match `/sil` (the manual browse surface). Boolean since there's
 *  only one route — sub-views use ?query params. */
export function isSilBrowse(path: string): boolean {
  return /^\/sil\/?$/.test(path);
}

/**
 * Match `/landing` — the public marketing landing. Public route: it has
 * to render BEFORE the auth gate so prospects can visit without having
 * to log in. Eventually the apex `agentescl2.com` will serve / 302 to
 * this same content.
 */
export function isLandingPage(path: string): boolean {
  return /^\/landing\/?$/.test(path);
}

/** Match `/audios` — podcast history page. */
export function isAudiosPage(path: string): boolean {
  return /^\/audios\/?$/.test(path);
}

/**
 * Match `/p/:token` — public podcast share page. Token is a UUID v4
 * minted by POST /api/podcasts/:id/share. Returns the token (no
 * trailing slash) or null. PUBLIC route: rendered before the auth gate.
 */
export function matchPodcastShareToken(path: string): string | null {
  const m = path.match(/^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
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
  | 'curaduria'
  | 'sesiones'
  | 'expedientes'
  | 'podcasts'
  | 'usuarios'
  | 'auditoria'
  | 'config';

const ADMIN_SECTIONS: ReadonlyArray<AdminSection> = [
  'overview',
  'transcripciones',
  'agentes',
  'curaduria',
  'sesiones',
  'expedientes',
  'podcasts',
  'usuarios',
  'auditoria',
  'config',
];

/**
 * Legacy path aliases — redirected to their canonical section by the
 * router. We keep them mapping in here (not in App.tsx) so the
 * sidebar/topdock can always read a canonical section id via
 * matchAdminSection regardless of which URL the user typed.
 */
const ADMIN_ALIASES: Record<string, AdminSection> = {
  // Legacy "Punto Medio" branding still resolves — bookmarks survive.
  'punto-medio': 'curaduria',
};

export function matchAdminSection(path: string): AdminSection | null {
  if (/^\/admin\/?$/.test(path)) return 'overview';
  const m = path.match(/^\/admin\/([a-z-]+)\/?$/);
  if (!m) return null;
  const slug = m[1] as string;
  if (ADMIN_SECTIONS.includes(slug as AdminSection)) return slug as AdminSection;
  if (slug in ADMIN_ALIASES) return ADMIN_ALIASES[slug]!;
  return null;
}

/** Match `/hojas` — workspaces list. */
export function isWorkspacesList(path: string): boolean {
  return /^\/hojas\/?$/.test(path);
}

/** Match `/hojas/:uuid` — single canvas. Returns uuid or null. */
export function matchWorkspaceId(path: string): string | null {
  const m = path.match(/^\/hojas\/([0-9a-f-]{36})\/?$/i);
  return m ? m[1] : null;
}
