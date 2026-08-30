/**
 * The pitch deck's content, as data.
 *
 * ★ THE COMPLIANCE MATRIX IS THE RISKIEST SLIDE IN THE DECK ★
 * It is a line-by-line claim against the problem statement, made to the people
 * who wrote it. The build guide ships a filled-in version of this table with
 * every row marked Done — and several of those rows are not true of this
 * build. Copying it would put a false claim on a slide, in front of ISRO, with
 * our name on it.
 *
 * So each row here carries the status we can defend, and the ones that are
 * partial say partial. A `PARTIAL` next to an honest sentence is a better
 * position than a `DONE` a judge can disprove with one question — and they
 * will ask, because it is their problem statement.
 *
 * Kept as data rather than JSX so the claims can be reviewed in one place and
 * asserted in tests.
 */

export type ComplianceStatus = 'DONE' | 'PARTIAL' | 'PART_B';

export interface ComplianceRow {
  requirement: string;
  /** Where it is built, for anyone who wants to look. */
  phase: string;
  status: ComplianceStatus;
  /** The defensible sentence. Never a bare "done". */
  detail: string;
}

export const COMPLIANCE: readonly ComplianceRow[] = [
  {
    requirement: 'Seamless GNSS deficit handler (millisecond switchover)',
    phase: '4',
    status: 'DONE',
    detail:
      'Dead reckoning runs continuously in shadow mode, so the switch costs 0 ms — there is nothing to start.',
  },
  {
    requirement: 'Drift under 10% of distance travelled',
    phase: '6, 7',
    status: 'PARTIAL',
    detail:
      '10.0% mean and 6.4% median across 12 runs — on the line, not under it. The p90 is 22.6%. Simulated logs only; no real drive log exists yet.',
  },
  {
    requirement: '10 Hz update rate on a smartphone',
    phase: '4, 10',
    status: 'DONE',
    detail: 'Measured from real frames and shown on the HUD, which turns amber below 10 Hz.',
  },
  {
    requirement: 'Advanced map matching & kinematic constraints',
    phase: '6',
    status: 'PARTIAL',
    detail:
      'NHC, ZUPT, ZARU and road snapping against a real OSM graph. HMM map matching is Part B.',
  },
  {
    requirement: 'GNSS + INS fusion engine',
    phase: '4',
    status: 'PARTIAL',
    detail: 'Complementary fusion with bounded-rate recovery. The ESKF is Part B.',
  },
  {
    requirement: 'AI speed model trained on IO-VNBD',
    phase: '8',
    status: 'DONE',
    detail: '1D-CNN, INT8 ONNX, runs on the phone. No cloud call anywhere in the app.',
  },
  {
    requirement: 'IO-VNBD position plot (screening artefact)',
    phase: '8',
    status: 'DONE',
    detail: 'ml/results/position_plot.png — predicted trajectory against ground truth.',
  },
  {
    requirement: 'On-device inference, no cloud',
    phase: '8',
    status: 'DONE',
    detail: 'ONNX Runtime Web in the APK. The app makes no network call to navigate.',
  },
  {
    requirement: 'Real-time navigation interface',
    phase: '1, 5, 9',
    status: 'DONE',
    detail: 'Map, HUD, confidence ellipse, event log, and live constraint toggles.',
  },
  {
    requirement: 'Mobile application',
    phase: '3',
    status: 'DONE',
    detail: 'Android APK via Capacitor, built on day one and tested on a physical phone.',
  },
  {
    requirement: 'Offline map database',
    phase: '6, 9',
    status: 'PARTIAL',
    detail:
      'Road graphs ship inside the APK and tiles are cached on request. A packaged PMTiles basemap is not built.',
  },
  {
    requirement: 'In-vehicle alignment & calibration engine',
    phase: '4, 12',
    status: 'PARTIAL',
    detail:
      'Attitude is resolved against measured gravity, so the phone may sit at any angle. Automatic mount-yaw estimation is Part B.',
  },
  {
    requirement: 'Pothole / vibration rejection',
    phase: '4',
    status: 'PARTIAL',
    detail: 'Median despike and low-pass filters. The learned classifier is Part B.',
  },
  {
    requirement: '200 Hz edge engine with an external IMU',
    phase: '16',
    status: 'PART_B',
    detail:
      'Not built — Part B. nav-core is pure and runtime-free precisely so this needs porting, not rewriting.',
  },
  {
    requirement: 'Phone misalignment handling',
    phase: '12',
    status: 'PART_B',
    detail:
      'Not built — Part B. Attitude handles any mounting tilt today; estimating the remaining mount yaw automatically is the missing piece.',
  },
];

export interface PitchSlide {
  id: string;
  title: string;
  /** One line under the title. */
  subtitle: string;
  /** Bullets. Kept short — these are read aloud, not studied. */
  points: readonly string[];
  /** Which special block, if any, the slide renders. */
  visual?: 'ablation' | 'compliance' | 'architecture' | 'ml';
}

export const PITCH_SLIDES: readonly PitchSlide[] = [
  {
    id: 'problem',
    title: 'The blue dot freezes',
    subtitle: 'Tunnels, basement parking, urban canyons — GNSS goes, navigation stops.',
    points: [
      'A satellite fix needs sky. Under an overpass or three floors down, there is none.',
      'The dot freezes or scatters, exactly when a driver is least able to look away.',
      'Tower and Wi-Fi positioning are 500 m to 2 km out — useless at a junction.',
    ],
  },
  {
    id: 'solution',
    title: 'Keep navigating from physics',
    subtitle: 'The phone already carries the sensors. We integrate them, and constrain the result.',
    points: [
      'Dead reckoning runs continuously in shadow mode, so losing GNSS costs 0 ms.',
      'Constraints bound the error: a vehicle does not slide sideways, a stopped one has zero speed, and it is on a road.',
      'An IO-VNBD-trained speed model replaces the accelerometer integration that drifts worst.',
      'No internet. No cloud API. Everything runs on the handset.',
    ],
    visual: 'architecture',
  },
  {
    id: 'results',
    title: 'Measured, one constraint at a time',
    subtitle: 'Every row differs from the one above by exactly one component.',
    points: [
      'Ground truth is each log’s own recorded GNSS, withheld from the estimator over the outage.',
      'The last row is a negative result: forward-bias made drift worse, so it ships disabled.',
      'Quote the mean and someone will find the tail — so the p90 is on the slide too.',
    ],
    visual: 'ablation',
  },
  {
    id: 'ml',
    title: 'The speed model',
    subtitle: '1D-CNN trained on IO-VNBD, quantised, running on the phone.',
    points: [
      'Unaided accelerometer integration cannot tell a parked car from one at a steady 50 km/h.',
      'The model predicts speed from raw IMU windows — the one quantity physics alone cannot recover.',
      'INT8 ONNX, on-device inference, no network call.',
      'The HUD tags the speed [ML] when the model is the source, so the claim is checkable live.',
    ],
    visual: 'ml',
  },
  {
    id: 'compliance',
    title: 'Against the problem statement',
    subtitle: 'Line by line, including the lines we have not finished.',
    points: [
      'Partial means partial. The rows marked Part B are scoped, not hand-waved.',
      'nav-core is pure math with no runtime dependencies, which is why the 200 Hz edge engine needs no rewrite.',
    ],
    visual: 'compliance',
  },
];

export const STATUS_LABEL: Record<ComplianceStatus, string> = {
  DONE: 'DONE',
  PARTIAL: 'PARTIAL',
  PART_B: 'PART B',
};

/** Counts for the slide's summary line. */
export function complianceTally(): Record<ComplianceStatus, number> {
  const tally: Record<ComplianceStatus, number> = { DONE: 0, PARTIAL: 0, PART_B: 0 };
  for (const row of COMPLIANCE) tally[row.status]++;
  return tally;
}
