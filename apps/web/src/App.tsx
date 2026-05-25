import { useEffect, useState } from 'react';
import { AnimatedAiInput } from './components/animated-ai-input';
import { TopDock } from './components/top-dock';
import { Sidebar } from './components/sidebar';
import { ChatProvider } from './lib/chat-context';
import { ThemeProvider } from './lib/theme-context';
import { ErrorBoundary } from './components/error-boundary';
import { OnboardingProvider } from './components/onboarding/OnboardingProvider';
import { OnboardingGate } from './components/onboarding/OnboardingGate';
import { FeedbackWidget } from './components/FeedbackWidget';
import { SupabaseAuthView } from './components/SupabaseAuthView';
import { AuthCallback } from './components/AuthCallback';
import { AccessGate } from './components/access/AccessGate';
import { useSupabaseStore } from './store/useSupabaseStore';
import { useRoute, matchSesionId, matchExpedienteNumero, matchAdminSection, isSilBrowse, isLandingPage, isWorkspacesList, matchWorkspaceId, isAudiosPage, matchPodcastShareToken, isCentinela, isMiMemoria, isAlertasPage, isEstadoPlenario, isMatrizCliente, isInformesSemanales } from './lib/router';
import { SesionesListPage } from './pages/SesionesListPage';
import { SesionViewPage } from './pages/SesionViewPage';
import { SubirSesionPage } from './pages/SubirSesionPage';
import { ExpedienteViewPage } from './pages/ExpedienteViewPage';
import { ExpedienteDashboardPage } from './pages/ExpedienteDashboardPage';
import { AdminApp } from './pages/admin/AdminApp';
import { SilBrowsePage } from './pages/SilBrowsePage';
import { WorkspacesListPage } from './pages/WorkspacesListPage';
import { CentinelaPage } from './pages/CentinelaPage';
import { MiMemoriaPage } from './pages/MiMemoriaPage';
import { AlertasPage } from './pages/AlertasPage';
import { EstadoPlenarioPage } from './pages/EstadoPlenarioPage';
import { MatrizClientePage } from './pages/MatrizClientePage';
import { InformesSemanalesPage } from './pages/InformesSemanalesPage';
import { WorkspaceCanvasPage } from './pages/WorkspaceCanvasPage';
import { LandingPage } from './pages/LandingPage';
import { AudiosPage } from './pages/AudiosPage';
import { PodcastSharePage } from './pages/PodcastSharePage';
import { cn } from '@/lib/utils';
import { isCentinelaLocked } from '@/lib/centinelaCountdown';
import { CentinelaLockedRoute } from '@/components/centinela/CentinelaLockOverlay';

export default function App() {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const toggleHistory = () => setIsHistoryOpen((v) => !v);
  const openMobileDrawer = () => setIsMobileDrawerOpen(true);
  const closeMobileDrawer = () => setIsMobileDrawerOpen(false);

  const { user, isAuthLoading, init } = useSupabaseStore();
  const isAuthenticated = user !== null;
  const path = useRoute();

  useEffect(() => {
    init();
  }, [init]);

  if (path === '/auth/callback') return <AuthCallback />;

  // /p/:token — public podcast share page. Must render before the auth
  // gate; the token is the auth.
  const shareToken = matchPodcastShareToken(path);
  if (shareToken) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <PodcastSharePage token={shareToken} />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  // /landing is the public marketing page — must render before the auth
  // gate so prospects can visit without logging in. We still wrap it in
  // ThemeProvider + ErrorBoundary so the theme toggle and dark mode work.
  if (isLandingPage(path)) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <LandingPage />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  if (isAuthLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh text-white">
        <div className="h-10 w-10 rounded-full border-2 border-white/20 border-t-white animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <SupabaseAuthView />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  const sesionId = matchSesionId(path);
  const expedienteNumero = matchExpedienteNumero(path);
  const adminSection = matchAdminSection(path);
  const workspaceId = matchWorkspaceId(path);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AccessGate>
        <ChatProvider>
          <OnboardingProvider>
          <OnboardingGate />
          <FeedbackWidget />
          {path === '/sesiones/subir' ? (
            <SubirSesionPage />
          ) : path === '/sesiones' ? (
            <SesionesListPage />
          ) : sesionId ? (
            <SesionViewPage sesionId={sesionId} />
          ) : expedienteNumero ? (
            // Route to the new unified dashboard when the numero contains a dot
            // (canonical SIL format: "23.511"). Pure-integer links go to the
            // legacy ExpedienteViewPage for backward compatibility.
            expedienteNumero.includes('.')
              ? <ExpedienteDashboardPage numero={expedienteNumero} />
              : <ExpedienteViewPage numero={Number(expedienteNumero)} />
          ) : adminSection ? (
            <AdminApp section={adminSection} />
          ) : isSilBrowse(path) ? (
            <SilBrowsePage />
          ) : isAudiosPage(path) ? (
            <AudiosPage />
          ) : isWorkspacesList(path) ? (
            <WorkspacesListPage />
          ) : workspaceId ? (
            <WorkspaceCanvasPage id={workspaceId} />
          ) : isCentinela(path) ? (
            isCentinelaLocked() ? <CentinelaLockedRoute /> : <CentinelaPage />
          ) : isAlertasPage(path) ? (
            isCentinelaLocked() ? <CentinelaLockedRoute /> : <AlertasPage />
          ) : isEstadoPlenario(path) ? (
            <EstadoPlenarioPage />
          ) : isMatrizCliente(path) ? (
            isCentinelaLocked() ? <CentinelaLockedRoute /> : <MatrizClientePage />
          ) : isInformesSemanales(path) ? (
            <InformesSemanalesPage />
          ) : isMiMemoria(path) ? (
            <MiMemoriaPage />
          ) : (
          <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
            {/* Pixel dotted overlay — barely visible */}
            <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
            <TopDock
              onOpenHistory={openMobileDrawer}
              onToggleHistory={toggleHistory}
              isHistoryOpen={isHistoryOpen}
            />

            <main className="relative z-20 flex-1 min-h-0 flex gap-0 px-4 sm:px-5 md:px-6 pt-3 md:pt-4">
              <div
                className={cn(
                  'hidden lg:flex flex-col min-h-0 transition-all duration-500 ease-out overflow-hidden shrink-0',
                  isHistoryOpen ? 'w-[280px] opacity-100 mr-6' : 'w-0 opacity-0 mr-0',
                )}
              >
                <Sidebar variant="panel" side="left" />
              </div>

              <section className="flex-1 min-h-0 min-w-0 border border-b-0 border-[#0e1745]/[0.06] dark:border-white/[0.04] rounded-t-2xl shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.12)] overflow-hidden">
                <AnimatedAiInput onOpenHistory={openMobileDrawer} />
              </section>
            </main>

            <Sidebar
              open={isMobileDrawerOpen}
              onClose={closeMobileDrawer}
              variant="drawer"
              side="left"
              className="lg:hidden"
            />
          </div>
          )}
          </OnboardingProvider>
        </ChatProvider>
        </AccessGate>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
