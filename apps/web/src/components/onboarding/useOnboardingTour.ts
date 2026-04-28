/**
 * Thin wrapper around driver.js — gives us a stable React API and centralizes
 * the storage / autoplay logic so consumers (the "?" button, the autoplay
 * effect) don't have to know about driver internals.
 */

import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useCallback, useEffect, useRef } from 'react';
import {
  MAIN_TOUR_STEPS,
  TOUR_STORAGE_KEY,
  TOUR_DISMISSED_KEY,
  type TourStep,
} from './tour-steps';

type StartOptions = {
  /** If true, marks the tour as completed when the user finishes (or skips
   *  past the last step). If false, only finishing-via-final-button counts. */
  markCompletedOnAnyExit?: boolean;
};

export function useOnboardingTour() {
  const driverRef = useRef<Driver | null>(null);

  /** Lazily build the driver instance. We rebuild on each `start()` call so
   *  steps reflect the current DOM (elements may not exist on mount). */
  const buildDriver = useCallback(
    (steps: TourStep[], opts: StartOptions = {}) => {
      const d = driver({
        showProgress: true,
        progressText: 'Paso {{current}} de {{total}}',
        nextBtnText: 'Continuar',
        prevBtnText: 'Atrás',
        doneBtnText: 'Empezar',
        allowClose: true,
        // Lower opacity — the CSS adds a soft blur on top, so a too-dark
        // overlay would make the page look "off" rather than focused.
        overlayOpacity: 0.35,
        // Padding around the spotlit element. Bigger = more breathing room.
        stagePadding: 6,
        stageRadius: 14,
        // Disable driver's smooth scrolling — our app's main areas are
        // scrollable containers and the auto-scroll fights with our layout.
        smoothScroll: false,
        animate: true,
        steps: steps.map((step) => ({
          element: step.element,
          popover: {
            title: step.popover.title,
            description: step.popover.description,
            side: step.popover.side,
            align: step.popover.align,
          },
        })),
        onDestroyed: () => {
          // User exited (close button, ESC, or finished).
          const reachedEnd = d.isLastStep();
          if (reachedEnd || opts.markCompletedOnAnyExit) {
            try {
              localStorage.setItem(TOUR_STORAGE_KEY, 'true');
            } catch {
              /* ignore — storage may be unavailable */
            }
          } else {
            // Soft-dismiss — they can resume on next visit if they didn't finish.
            try {
              localStorage.setItem(TOUR_DISMISSED_KEY, new Date().toISOString());
            } catch {
              /* ignore */
            }
          }
        },
      });
      driverRef.current = d;
      return d;
    },
    [],
  );

  /** Start the main onboarding tour. */
  const start = useCallback(
    (opts: StartOptions = {}) => {
      // If a tour is already running, destroy it first.
      if (driverRef.current?.isActive()) {
        driverRef.current.destroy();
      }
      const d = buildDriver(MAIN_TOUR_STEPS, opts);
      // Slight delay lets element transitions finish (e.g. modals closing).
      requestAnimationFrame(() => d.drive());
    },
    [buildDriver],
  );

  /** Force-stop any running tour. */
  const stop = useCallback(() => {
    driverRef.current?.destroy();
    driverRef.current = null;
  }, []);

  /** Has the user already completed the tour? */
  const hasCompleted = useCallback((): boolean => {
    try {
      return localStorage.getItem(TOUR_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }, []);

  /** Reset completion state (useful from a debug menu / tests). */
  const reset = useCallback(() => {
    try {
      localStorage.removeItem(TOUR_STORAGE_KEY);
      localStorage.removeItem(TOUR_DISMISSED_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      driverRef.current?.destroy();
    };
  }, []);

  return { start, stop, hasCompleted, reset };
}
