'use client';

import { useCallback, useEffect, useState } from 'react';
import { TOUR_STEPS, clampStep, hasSeenTour, markTourSeen } from '@/lib/tour';

export type OnboardingPhase = 'loading' | 'welcome' | 'tour' | 'done';

export interface Tour {
  phase: OnboardingPhase;
  index: number;
  next: () => void;
  back: () => void;
  skip: () => void;
  /** From the welcome screen's "Show me around". */
  begin: () => void;
  /** Start the tour again from the Help button, any time. */
  restart: () => void;
}

/**
 * First-run onboarding: the welcome screen, then the tour.
 *
 * Starts in `loading` rather than `welcome`, and only decides once mounted.
 * The app is a static export, so the first paint happens before any storage
 * can be read — showing the welcome screen optimistically would flash it at
 * every returning visitor for one frame, which is exactly the sort of thing
 * that reads as a bug on a phone.
 */
export function useTour(): Tour {
  const [phase, setPhase] = useState<OnboardingPhase>('loading');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setPhase(hasSeenTour() ? 'done' : 'welcome');
  }, []);

  const finish = useCallback(() => {
    markTourSeen();
    setPhase('done');
    setIndex(0);
  }, []);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i >= TOUR_STEPS.length - 1) {
        finish();
        return i;
      }
      return clampStep(i + 1);
    });
  }, [finish]);

  const back = useCallback(() => setIndex((i) => clampStep(i - 1)), []);

  const begin = useCallback(() => {
    setIndex(0);
    setPhase('tour');
  }, []);

  return {
    phase,
    index,
    next,
    back,
    skip: finish,
    begin,
    restart: begin,
  };
}
