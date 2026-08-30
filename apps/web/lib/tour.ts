/**
 * The guided tour.
 *
 * ★ ONE CONTROL, ONE LINE ★
 * The first version of this was ten steps of prose that read like a story and
 * restated the problem statement. Nobody holding a borrowed phone reads that;
 * they press Skip, and then they have learned nothing at all.
 *
 * So: spotlight a single control, name it, and say in one line what it does.
 * Four steps, about twenty seconds, and Skip on every one of them. The body of
 * each step is capped by a test — if it will not fit in one line it is not a
 * tour step, it is documentation, and it belongs in the README.
 *
 * Anchors are `data-tour` attributes on real elements, so a step pointing at
 * something that no longer exists is a test failure rather than a highlight
 * ring floating over empty screen.
 */

export type TourAnchor = 'hud' | 'map' | 'demo' | 'menu';

export interface TourStep {
  id: string;
  /** `data-tour` value of the element to highlight, or null for centre screen. */
  anchor: TourAnchor | null;
  title: string;
  /** ONE line. Capped by a test — see the note at the top of this file. */
  body: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'demo',
    anchor: 'demo',
    title: 'Run the demo',
    body: 'Plays the whole GPS-loss story on its own. Start here.',
  },
  {
    id: 'hud',
    anchor: 'hud',
    title: 'Live readings',
    body: 'Mode, speed, and how far the estimate might be out.',
  },
  {
    id: 'map',
    anchor: 'map',
    title: 'The shaded ellipse',
    body: 'How wrong the position could be. It stretches when GPS is lost.',
  },
  {
    id: 'menu',
    anchor: 'menu',
    title: 'Everything else',
    body: 'Sensors, offline maps, results and the pitch live in here.',
  },
];

export const TOUR_STORAGE_KEY = 'pathpulse.tour.seen.v1';

/** Clamp an index into the tour. */
export function clampStep(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(TOUR_STEPS.length - 1, Math.floor(index)));
}

export function stepAt(index: number): TourStep {
  return TOUR_STEPS[clampStep(index)]!;
}

/**
 * Whether the tour has already been seen.
 *
 * Wrapped because Safari private mode throws on `localStorage` access rather
 * than returning null, and a first-run helper that crashes the app on a
 * borrowed phone is a poor first run.
 */
export function hasSeenTour(): boolean {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, '1');
  } catch {
    // Not being able to remember is survivable; crashing is not.
  }
}

export function forgetTour(): void {
  try {
    window.localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    /* see above */
  }
}
