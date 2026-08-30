/**
 * The guided tour.
 *
 * ★ WHO THIS IS FOR ★
 * Someone who has just been handed the phone and has perhaps ninety seconds
 * of patience. Not a reader of documentation. So every step names one thing,
 * says why it is there, and gets out of the way — and Skip is on every step,
 * because a tour you cannot leave is worse than no tour.
 *
 * Steps are data, and the anchors are `data-tour` attributes on real elements.
 * That means a step pointing at something that no longer exists is a test
 * failure rather than a highlight ring floating over empty screen.
 */

export type TourAnchor =
  | 'hud'
  | 'map'
  | 'demo'
  | 'debug'
  | 'pitch'
  | 'offline'
  | 'benchmarks'
  | 'source';

export interface TourStep {
  id: string;
  /** `data-tour` value of the element to highlight, or null for centre screen. */
  anchor: TourAnchor | null;
  title: string;
  /** Two or three sentences. Read aloud in about ten seconds. */
  body: string;
  /** Optional line telling the viewer what to actually do. */
  action?: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'intro',
    anchor: null,
    title: 'What this is',
    body:
      'Your phone finds itself using satellites. In a tunnel or a basement there are none, so the blue dot freezes. PathPulse keeps navigating from the phone’s own motion sensors until the signal comes back.',
    action: 'Nine short steps. Skip whenever you like.',
  },
  {
    id: 'hud',
    anchor: 'hud',
    title: 'The numbers, top left',
    body:
      'Mode, speed, how far the estimate might be out, and how long since the last satellite fix. The update rate turns amber below 10 Hz, which is the rate the problem statement asks for.',
  },
  {
    id: 'mode',
    anchor: 'hud',
    title: 'The mode badge is the story',
    body:
      'Green is a satellite fix. Orange is dead reckoning — no signal, position inferred from motion. Blue is recovery, sliding back onto the truth. The trail on the map is coloured the same way.',
  },
  {
    id: 'ellipse',
    anchor: 'map',
    title: 'The shaded shape is doubt',
    body:
      'It is an ellipse, not a circle. The long axis is error along the road, which grows every second without GNSS. The short axis is error across the road, which the constraints hold down. Watch it stretch forward during an outage.',
  },
  {
    id: 'demo',
    anchor: 'demo',
    title: 'Start here',
    body:
      'One press runs the whole story: normal driving, the signal cut at fifteen seconds, a minute of dead reckoning, then recovery. The banner tells you what is happening and says plainly that the outage is scripted rather than a real tunnel.',
    action: 'Press Demo when the tour finishes.',
  },
  {
    id: 'debug',
    anchor: 'debug',
    title: 'Proof, not claims',
    body:
      'Raw sensor values updating every frame, an event log that timestamps and explains every mode change, and session statistics measured against real fixes. A recording cannot explain itself.',
  },
  {
    id: 'constraints',
    anchor: 'debug',
    title: 'Break it on purpose',
    body:
      'Debug → CONSTRAINTS switches the physics off mid-outage. Turn NHC or ZUPT off and the estimate visibly wanders; turn it back on and it recovers. A faked demo never breaks on request.',
    action: 'The most convincing thing here. Try it during an outage.',
  },
  {
    id: 'results',
    anchor: 'benchmarks',
    title: 'The measured table',
    body:
      'Every row differs from the one above by exactly one component, scored against ground truth the estimator never saw. One row is a negative result we shipped disabled and report anyway.',
  },
  {
    id: 'offline',
    anchor: 'offline',
    title: 'No network at all',
    body:
      'Download the map area, then switch on aeroplane mode. The map keeps drawing from storage and the vehicle keeps navigating from its sensors. Nothing here needs a signal of any kind.',
  },
  {
    id: 'pitch',
    anchor: 'pitch',
    title: 'The rest of the case',
    body:
      'Five slides: the problem, the approach, the measured results, the AI model, and an honest line-by-line reading of the problem statement — including the parts that are not finished.',
    action: 'That is everything. Enjoy.',
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
