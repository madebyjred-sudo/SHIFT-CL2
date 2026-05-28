/**
 * Admin entry point — picks the section from the path and renders it
 * inside the AdminShell. Exposed at /admin/* in App.tsx.
 *
 * Why a flat switch instead of a Map<id, Component>: the section
 * components have asymmetric data dependencies (some fetch, some don't,
 * one has its own router-style state), so a switch with a `<Component />`
 * per branch is the most readable and avoids prop-drilling. Each branch
 * is one line; the verbosity is in the imports.
 */
import { useEffect, useState } from 'react';
import { matchAdminSection, matchTranscriptDetailId, navigate, useRoute, type AdminSection } from '@/lib/router';
import { AdminShell } from './AdminShell';
import { useAccess, canAccessAdmin } from '@/components/access/AccessContext';
import { AdminDeniedScreen } from './AdminDeniedScreen';
import { useSupabaseStore } from '@/store/useSupabaseStore';
import { ToastProvider } from './Toast';
import { OverviewSection } from './sections/OverviewSection';
import { TranscriptsSection } from './sections/TranscriptsSection';
import { TranscriptDetailSection } from './sections/TranscriptDetailSection';
import { AgentesSection } from './sections/AgentesSection';
import { SesionesSection } from './sections/SesionesSection';
import { ExpedientesSection } from './sections/ExpedientesSection';
import { PodcastsSection } from './sections/PodcastsSection';
import { UsuariosSection } from './sections/UsuariosSection';
import { AuditoriaSection } from './sections/AuditoriaSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { TokensSection } from './sections/TokensSection';
import { ClientesSection } from './sections/ClientesSection';
import { WhatsappAlertsSection } from './sections/WhatsappAlertsSection';
// Eliminados (post-audit 2026-05-10): TranscripcionesSection (duplica),
// PuntoMedioSection (Cerebro 404), ConfigSection (decoración).
// Si llega un usuario a /admin/transcripciones, /admin/curaduria, /admin/config,
// los redirigimos a /admin/overview en lugar de mostrar 404.
import { listTranscriptSessions } from '@/services/transcriptsAdminApi';

interface AdminAppProps {
  section: AdminSection;
}

// Secciones eliminadas del rail tras audit 2026-05-10. Si alguien llega
// por URL directa, los redirigimos a /admin/overview.
const REMOVED_SECTIONS: ReadonlyArray<AdminSection> = ['transcripciones', 'curaduria', 'config'];

export function AdminApp({ section }: AdminAppProps): React.ReactElement {
  const [badges, setBadges] = useState<Partial<Record<AdminSection, number>>>({});
  const path = useRoute();
  const access = useAccess();
  const supaUser = useSupabaseStore((s) => s.user);

  // ── Role gate ──────────────────────────────────────────────────────
  // Solo admin + operador acceden al panel. Lectores y editores aprobados
  // entran a la app principal pero NO ven el admin. Esto evita que el
  // equipo del cliente (aprobados como 'lector') puedan aprobar a otros,
  // ver auditoría o tocar configuración. El gate real vive en el backend
  // (admin.ts middleware); esto es la capa de UX para que no aparezca un
  // menú que igual les iba a tirar 403.
  //
  // Doble fuente: access.role (de /api/me, fuente canónica) O
  // supaUser.user_metadata.role (del JWT, sobrevive a /api/me 401 transient).
  // Si CUALQUIERA de las dos dice admin, dejamos pasar — el backend rebota
  // si está mal.
  const jwtRole = (supaUser?.user_metadata?.role as string | undefined) ?? null;
  const effectiveRole = canAccessAdmin(access.role) ? access.role : (jwtRole === 'admin' || jwtRole === 'operador' ? (jwtRole as typeof access.role) : access.role);
  if (!canAccessAdmin(effectiveRole)) {
    // eslint-disable-next-line no-console
    console.warn('[AdminApp] gate rejected', {
      access_role: access.role,
      access_status: access.status,
      jwt_role: jwtRole,
      supa_user_id: supaUser?.id,
      supa_email: supaUser?.email,
    });
    return <AdminDeniedScreen role={access.role} />;
  }

  // Redirect away from removed sections — la migración suave evita 404
  // para usuarios con bookmarks o URLs pegados de antes de la limpieza.
  useEffect(() => {
    if (REMOVED_SECTIONS.includes(section)) {
      navigate('/admin/overview', { replace: true });
    }
  }, [section]);

  // Determine if we're drilling into a specific transcript session
  const transcriptDetailId = section === 'transcripts' ? matchTranscriptDetailId(path) : null;

  // Badge loader — solo para la sección que sí existe (transcripts).
  // Antes había badges para `transcripciones` y `curaduria` también, pero
  // esas secciones quedaron eliminadas del rail.
  useEffect(() => {
    let alive = true;
    listTranscriptSessions({ limit: 200 })
      .then((transcripts) => {
        if (!alive) return;
        const pendingSessions = transcripts.sessions.filter(
          (s) => s.corrections_pending > 0,
        ).length;
        setBadges(pendingSessions > 0 ? { transcripts: pendingSessions } : {});
      })
      .catch(() => {
        if (alive) setBadges({});
      });
    return () => {
      alive = false;
    };
  }, [section]);

  return (
    <ToastProvider>
      <AdminShell active={section} badges={badges}>
        {section === 'overview' && <OverviewSection />}
        {section === 'transcripts' && !transcriptDetailId && <TranscriptsSection />}
        {section === 'transcripts' && transcriptDetailId && (
          <TranscriptDetailSection sessionId={transcriptDetailId} />
        )}
        {section === 'agentes' && <AgentesSection />}
        {section === 'sesiones' && <SesionesSection />}
        {section === 'expedientes' && <ExpedientesSection />}
        {section === 'podcasts' && <PodcastsSection />}
        {section === 'usuarios' && <UsuariosSection />}
        {section === 'auditoria' && <AuditoriaSection />}
        {section === 'feedback' && <FeedbackSection />}
        {section === 'tokens' && <TokensSection />}
        {section === 'clientes' && <ClientesSection />}
        {section === 'whatsapp-alerts' && <WhatsappAlertsSection />}
      </AdminShell>
    </ToastProvider>
  );
}

/** Helper used by App.tsx — returns the section to render or null
 *  for non-admin paths. Centralizes the redirect-to-overview logic so
 *  the App component stays declarative. */
export function resolveAdminSection(path: string): AdminSection | null {
  return matchAdminSection(path);
}

/** Side-effect: redirect /admin/punto-medio to keep the legacy URL alive
 *  while routing through the new shell. Safe to call from App's effect
 *  because navigate() bails out if the target equals the current path. */
export function maybeMigrateLegacyAdminPath(path: string): void {
  if (/^\/admin\/punto-medio\/?$/.test(path)) {
    // Same path; nothing to migrate. The new shell handles it natively.
    return;
  }
  if (/^\/admin\/?$/.test(path)) {
    navigate('/admin/overview', { replace: true });
  }
}
