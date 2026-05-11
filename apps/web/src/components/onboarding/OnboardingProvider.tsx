/**
 * OnboardingProvider — auto-plays the tour on first authenticated visit and
 * exposes an imperative `replay()` via context for the "?" button.
 *
 * Mount this INSIDE the auth gate (after `isAuthenticated`) and INSIDE
 * ChatProvider, so it only ever runs for logged-in users on the chat surface.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useOnboardingTour } from './useOnboardingTour';
import { useRoute, navigate } from '@/lib/router';
import { getProfile } from '@/services/onboardingApi';

type OnboardingContextValue = {
  /** Manually start (or restart) the tour. */
  replay: () => void;
  /** Reset state — exposed for dev / debug. */
  reset: () => void;
  /** Whether the user already completed the tour. */
  hasCompleted: boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    // Soft fallback — components shouldn't rely on the provider being mounted
    // for non-critical UI (e.g. landing pages). Return a noop.
    return {
      replay: () => {
        /* noop — provider not mounted */
      },
      reset: () => {
        /* noop */
      },
      hasCompleted: false,
    };
  }
  return ctx;
}

interface OnboardingProviderProps {
  children: ReactNode;
}

export function OnboardingProvider({ children }: OnboardingProviderProps) {
  const tour = useOnboardingTour();
  const path = useRoute();
  const triggeredRef = useRef(false);

  // Auto-play the tour on first authenticated visit to the chat surface.
  // PRECEDENCE: el wizard (OnboardingGate → OnboardingWizard) tiene
  // prioridad sobre el tour. Si el user todavía no completó el wizard
  // (`onboarded_at == null`), no iniciamos el tour — quedan apilados
  // sino y rompe la sensación premium. El tour arranca recién cuando
  // el wizard cierre (sea por "Empezar" o por skip).
  //
  // Implementación: chequeamos el profile antes de programar el timer.
  // Si onboarded_at sigue null al chequear, polleamos cada 2s hasta que
  // se complete o el componente desmonte. Polling es barato (cacheado
  // server-side + caller es 1 user).
  useEffect(() => {
    if (triggeredRef.current) return;
    if (tour.hasCompleted()) return;

    // Only auto-play on the main chat surface — not on /sesiones, /hojas, etc.
    if (path !== '/' && path !== '') return;

    let cancelled = false;
    let pollTimer: number | null = null;
    let startTimer: number | null = null;

    const tryStartIfReady = async () => {
      if (cancelled || triggeredRef.current) return;
      try {
        const profile = await getProfile();
        if (cancelled) return;
        if (!profile.onboarded_at) {
          // Wizard sigue abierto → reintentar en 2s
          pollTimer = window.setTimeout(tryStartIfReady, 2000);
          return;
        }
      } catch {
        // Si el endpoint falla, asumimos que el wizard no aplica y
        // arrancamos el tour de todos modos (mejor mostrar el tour que
        // dejar al user sin onboarding).
      }
      if (cancelled || triggeredRef.current) return;
      triggeredRef.current = true;
      startTimer = window.setTimeout(() => {
        tour.start();
      }, 600);
    };

    void tryStartIfReady();

    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
      if (startTimer) window.clearTimeout(startTimer);
    };
  }, [path, tour]);

  const replay = useCallback(() => {
    // The tour anchors live on the chat surface (Lexa input, etc.). If the
    // user triggers replay from a sub-page like /sesiones or /hojas, we
    // navigate them home first and start the tour after a short delay so
    // the new page mounts before driver.js measures elements.
    if (path !== '/' && path !== '') {
      navigate('/');
      window.setTimeout(() => {
        tour.start({ markCompletedOnAnyExit: false });
      }, 350);
      return;
    }
    tour.start({ markCompletedOnAnyExit: false });
  }, [tour, path]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      replay,
      reset: tour.reset,
      hasCompleted: tour.hasCompleted(),
    }),
    [replay, tour],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}
