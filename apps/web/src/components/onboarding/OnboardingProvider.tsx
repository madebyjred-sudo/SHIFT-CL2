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
  // We wait a bit after mount so all the DOM elements (Lexa input, top dock)
  // are present and laid out correctly before driver.js measures them.
  useEffect(() => {
    if (triggeredRef.current) return;
    if (tour.hasCompleted()) return;

    // Only auto-play on the main chat surface — not on /sesiones, /hojas, etc.
    // The other pages have their own elements, but the welcome tour is rooted
    // in the chat experience.
    if (path !== '/' && path !== '') return;

    triggeredRef.current = true;
    const timer = window.setTimeout(() => {
      tour.start();
    }, 900);

    return () => {
      window.clearTimeout(timer);
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
