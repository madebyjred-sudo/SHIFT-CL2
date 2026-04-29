import { BookOpen, Clock, HelpCircle, PanelLeftClose, PanelLeftOpen, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { UserNavMenu } from './UserNavMenu';
import { useRoute, navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useOnboarding } from './onboarding/OnboardingProvider';

interface TopDockProps {
  onOpenHistory?: () => void;
  onToggleHistory?: () => void;
  isHistoryOpen?: boolean;
}

export function TopDock({ onOpenHistory, onToggleHistory, isHistoryOpen }: TopDockProps) {
  const { theme, toggleTheme } = useTheme();
  const path = useRoute();
  const { replay: replayTour, hasCompleted: tourCompleted } = useOnboarding();
  const currentView: 'chat' | 'live' | 'sil' | 'audios' | 'admin' | 'hojas' | 'centinela' =
    path.startsWith('/admin') ? 'admin'
    : path.startsWith('/sil') ? 'sil'
    : path.startsWith('/audios') ? 'audios'
    : path.startsWith('/hojas') ? 'hojas'
    : path.startsWith('/centinela') ? 'centinela'
    : path.startsWith('/sesiones') || path.startsWith('/expediente') ? 'live'
    : 'chat';
  const handleNavigate = (view: 'chat' | 'live' | 'sil' | 'audios' | 'admin' | 'hojas' | 'centinela') => {
    if (view === 'admin') navigate('/admin/overview');
    else if (view === 'sil') navigate('/sil');
    else if (view === 'audios') navigate('/audios');
    else if (view === 'hojas') navigate('/hojas');
    else if (view === 'centinela') navigate('/centinela');
    else navigate(view === 'live' ? '/sesiones' : '/');
  };

  return (
    <header className="sticky top-0 z-[90] px-4 sm:px-5 md:px-6 pt-1.5 sm:pt-2">
      <div className="w-full border border-t-0 border-[#0e1745]/[0.06] dark:border-white/[0.04] rounded-b-2xl shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.12)] px-3 py-2 md:px-4 md:py-2.5 flex items-center justify-between gap-2 md:gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 min-w-0" data-tour="brand">
          <div
            className="relative h-9 w-9 rounded-xl overflow-hidden shrink-0"
            aria-label="CL2 Logo"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-cl2-accent to-cl2-accent-soft" />
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  'radial-gradient(circle, rgba(255,255,255,0.4) 1px, transparent 1px)',
                backgroundSize: '5px 5px',
              }}
            />
            <div className="relative h-full w-full flex items-center justify-center text-white font-heading font-extrabold text-xs tracking-tight">
              CL2
            </div>
          </div>
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/35 dark:text-white/35">
              Inteligencia Legislativa
            </span>
            <span className="text-[11px] font-medium text-[#0e1745]/70 dark:text-white/70">
              Asamblea de Costa Rica
            </span>
          </div>
        </div>

        {/* Utilities */}
        <div className="flex items-center gap-1.5">
          {onToggleHistory && (
            <button
              data-tour="history-toggle"
              onClick={onToggleHistory}
              className="hidden lg:flex h-9 w-9 items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 text-[#0e1745]/60 dark:text-white/60 transition-all"
              aria-label={isHistoryOpen ? 'Cerrar historial' : 'Abrir historial'}
              title={isHistoryOpen ? 'Cerrar historial' : 'Abrir historial'}
            >
              {isHistoryOpen ? (
                <PanelLeftClose className="w-4 h-4" />
              ) : (
                <PanelLeftOpen className="w-4 h-4" />
              )}
            </button>
          )}

          {onOpenHistory && (
            <button
              data-tour="history-toggle"
              onClick={onOpenHistory}
              className="lg:hidden h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 text-[#0e1745]/60 dark:text-white/60 transition-all"
              aria-label="Abrir historial"
            >
              <Clock className="w-4 h-4" />
            </button>
          )}

          <button
            data-tour="theme-toggle"
            onClick={toggleTheme}
            className="h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 shadow-sm text-[#0e1745]/60 dark:text-white/60 hover:text-[#0e1745] dark:hover:text-white transition-all"
            title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Help / replay tutorial button. Visible on every surface EXCEPT
              admin (admin is a power-user view; its own onboarding pattern
              would be different and the chat-rooted tour anchors aren't
              relevant there). Pulses softly until the user completes the
              tour at least once, then settles. */}
          {currentView !== 'admin' && (
            <button
              data-tour="help-replay"
              data-attention={!tourCompleted ? 'true' : 'false'}
              onClick={replayTour}
              className="cl2-help-button h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 shadow-sm text-cl2-burgundy dark:text-cl2-burgundy/80 hover:text-cl2-burgundy dark:hover:text-white transition-all"
              aria-label="Ver tutorial de la aplicación"
              title="Ver tutorial"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          )}

          <div data-tour="user-nav">
            <UserNavMenu currentView={currentView} onNavigate={handleNavigate} />
          </div>
        </div>
      </div>
    </header>
  );
}
