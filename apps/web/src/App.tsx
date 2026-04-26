import { useEffect, useState } from 'react';
import { AnimatedAiInput } from './components/animated-ai-input';
import { TopDock } from './components/top-dock';
import { Sidebar } from './components/sidebar';
import { ChatProvider } from './lib/chat-context';
import { ThemeProvider } from './lib/theme-context';
import { ErrorBoundary } from './components/error-boundary';
import { SupabaseAuthView } from './components/SupabaseAuthView';
import { AuthCallback } from './components/AuthCallback';
import { useSupabaseStore } from './store/useSupabaseStore';
import { useRoute, matchSesionId, matchExpedienteNumero, matchAdminSection, isSilBrowse } from './lib/router';
import { SesionesListPage } from './pages/SesionesListPage';
import { SesionViewPage } from './pages/SesionViewPage';
import { SubirSesionPage } from './pages/SubirSesionPage';
import { ExpedienteViewPage } from './pages/ExpedienteViewPage';
import { AdminApp } from './pages/admin/AdminApp';
import { SilBrowsePage } from './pages/SilBrowsePage';
import { cn } from '@/lib/utils';

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

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ChatProvider>
          {path === '/sesiones/subir' ? (
            <SubirSesionPage />
          ) : path === '/sesiones' ? (
            <SesionesListPage />
          ) : sesionId ? (
            <SesionViewPage sesionId={sesionId} />
          ) : expedienteNumero ? (
            <ExpedienteViewPage numero={Number(expedienteNumero)} />
          ) : adminSection ? (
            <AdminApp section={adminSection} />
          ) : isSilBrowse(path) ? (
            <SilBrowsePage />
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
        </ChatProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
