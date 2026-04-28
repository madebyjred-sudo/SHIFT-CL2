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
import { ToastProvider } from './Toast';
import { OverviewSection } from './sections/OverviewSection';
import { TranscripcionesSection } from './sections/TranscripcionesSection';
import { TranscriptsSection } from './sections/TranscriptsSection';
import { TranscriptDetailSection } from './sections/TranscriptDetailSection';
import { AgentesSection } from './sections/AgentesSection';
import { PuntoMedioSection } from './sections/PuntoMedioSection';
import { SesionesSection } from './sections/SesionesSection';
import { ExpedientesSection } from './sections/ExpedientesSection';
import { PodcastsSection } from './sections/PodcastsSection';
import { UsuariosSection } from './sections/UsuariosSection';
import { AuditoriaSection } from './sections/AuditoriaSection';
import { ConfigSection } from './sections/ConfigSection';
import { fetchTranscripciones } from '@/services/adminApi';
import { fetchPending } from '@/services/puntoMedioApi';
import { listTranscriptSessions } from '@/services/transcriptsAdminApi';

interface AdminAppProps {
  section: AdminSection;
}

export function AdminApp({ section }: AdminAppProps): React.ReactElement {
  const [badges, setBadges] = useState<Partial<Record<AdminSection, number>>>({});
  const path = useRoute();

  // Determine if we're drilling into a specific transcript session
  const transcriptDetailId = section === 'transcripts' ? matchTranscriptDetailId(path) : null;

  // Lightweight badge loader so the sidebar shows fresh counts on every
  // section change. These calls are dirt cheap (json fetch, ~150ms each)
  // and the data is the same the OverviewSection would have fetched
  // anyway — duplicate but worth the redundancy for the always-visible
  // sidebar signal.
  useEffect(() => {
    let alive = true;
    Promise.allSettled([fetchTranscripciones(), fetchPending(), listTranscriptSessions({ limit: 200 })])
      .then(([trans, punto, transcripts]) => {
        if (!alive) return;
        const next: Partial<Record<AdminSection, number>> = {};
        if (trans.status === 'fulfilled') {
          next.transcripciones = trans.value.data.counts.pending;
        }
        if (punto.status === 'fulfilled') {
          next['curaduria'] =
            punto.value.pending_consolidations_count + punto.value.pending_patterns_count;
        }
        if (transcripts.status === 'fulfilled') {
          // Badge = sessions with at least one pending correction
          const pendingSessions = transcripts.value.sessions.filter(
            (s) => s.corrections_pending > 0,
          ).length;
          if (pendingSessions > 0) next['transcripts'] = pendingSessions;
        }
        setBadges(next);
      });
    return () => {
      alive = false;
    };
  }, [section]);

  return (
    <ToastProvider>
      <AdminShell active={section} badges={badges}>
        {section === 'overview' && <OverviewSection />}
        {section === 'transcripciones' && <TranscripcionesSection />}
        {section === 'transcripts' && !transcriptDetailId && <TranscriptsSection />}
        {section === 'transcripts' && transcriptDetailId && (
          <TranscriptDetailSection sessionId={transcriptDetailId} />
        )}
        {section === 'agentes' && <AgentesSection />}
        {section === 'curaduria' && <PuntoMedioSection />}
        {section === 'sesiones' && <SesionesSection />}
        {section === 'expedientes' && <ExpedientesSection />}
        {section === 'podcasts' && <PodcastsSection />}
        {section === 'usuarios' && <UsuariosSection />}
        {section === 'auditoria' && <AuditoriaSection />}
        {section === 'config' && <ConfigSection />}
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
