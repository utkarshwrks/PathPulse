import { haversineDistance, type LatLon, type NavigationState } from '@pathpulse/nav-core';

/** One ground-truth position, from the log's own recorded GNSS. */
export interface TruthPoint {
  t: number;
  lat: number;
  lon: number;
}

/** One estimate compared against truth at the same instant. */
export interface ErrorSample {
  t: number;
  errorM: number;
  /** Along the direction of travel. Positive means ahead of truth. */
  alongM: number;
  /** Across it. Positive means right of the truth path. */
  crossM: number;
}

export interface EvalMetrics {
  configName: string;
  log: string;
  outageStartMs: number;
  outageDurationS: number;
  samples: number;
  /** Distance the vehicle really covered during the outage, from truth. */
  distanceTravelledM: number;
  /** Final error as a percentage of that distance — the PS's own metric. */
  driftPercent: number;
  finalErrorM: number;
  rmseM: number;
  maeM: number;
  maxErrorM: number;
  alongTrackRmseM: number;
  crossTrackRmseM: number;
  /** Radius containing 95% of the errors. */
  cep95M: number;
  /** Time from GNSS returning to the mode settling back on GNSS. */
  recoveryTimeS: number | null;
  meanUpdateHz: number;
  zuptTriggers: number;
  zaruTriggers: number;
  roadSnapAppliedPct: number;
  positionResets: number;
}

/**
 * Ground truth, interpolated to an arbitrary instant.
 *
 * Truth arrives at the GNSS rate — 1 Hz in simulation, and as slow as 0.09 Hz
 * on the field device — while the estimate is produced at the IMU rate. Simply
 * taking the nearest fix would attribute up to half a fix-interval of genuine
 * travel to the estimator as error: at 14 m/s and a 1 s interval that is 7 m of
 * pure measurement artefact, which is the same order as the numbers being
 * measured.
 */
export function truthAt(truth: readonly TruthPoint[], t: number): LatLon | null {
  if (truth.length === 0) return null;
  if (t <= truth[0]!.t) return { lat: truth[0]!.lat, lon: truth[0]!.lon };
  const last = truth[truth.length - 1]!;
  if (t >= last.t) return { lat: last.lat, lon: last.lon };

  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = truth.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (truth[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = truth[lo]!;
  const b = truth[hi]!;
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/** Local metres-per-degree, good enough over the span of one outage. */
function scaleAt(lat: number): { mPerLat: number; mPerLon: number } {
  return { mPerLat: 111_320, mPerLon: 111_320 * Math.cos((lat * Math.PI) / 180) };
}

/**
 * Direction of travel of the TRUTH path at an instant, degrees clockwise from
 * north, or null if the vehicle is not moving enough to have one.
 *
 * Taken from truth rather than from the estimate on purpose: the whole point is
 * to decompose the error relative to the road the vehicle was actually on. Using
 * the estimate's own heading would let a wrong heading disguise itself by
 * rotating the frame it is measured in.
 */
export function truthHeadingAt(truth: readonly TruthPoint[], t: number): number | null {
  if (truth.length < 2) return null;
  const before = truthAt(truth, t - 500);
  const after = truthAt(truth, t + 500);
  if (!before || !after) return null;
  const { mPerLat, mPerLon } = scaleAt(before.lat);
  const de = (after.lon - before.lon) * mPerLon;
  const dn = (after.lat - before.lat) * mPerLat;
  // Below a metre of movement the direction is fix noise, not travel.
  if (Math.hypot(de, dn) < 1) return null;
  return (Math.atan2(de, dn) * 180) / Math.PI;
}

/**
 * Decompose one position error into along-track and cross-track components.
 *
 * ★ WHY THIS SPLIT IS THE POINT ★
 * A single error magnitude says how wrong we are; the split says how we are
 * wrong, and the two have different causes and different fixes. Cross-track
 * error puts the marker inside a building and is bounded by road geometry.
 * Along-track error keeps the marker on the right road at the wrong point along
 * it, is caused by speed error, and road snapping deliberately does nothing
 * about it. Reporting only the magnitude hides which of those is happening.
 */
export function decomposeError(
  estimate: LatLon,
  truth: LatLon,
  truthHeadingDeg: number | null,
): { errorM: number; alongM: number; crossM: number } {
  const { mPerLat, mPerLon } = scaleAt(truth.lat);
  const de = (estimate.lon - truth.lon) * mPerLon;
  const dn = (estimate.lat - truth.lat) * mPerLat;
  const errorM = Math.hypot(de, dn);

  if (truthHeadingDeg === null) {
    // Stationary: there is no direction of travel, so the split is undefined.
    // Attributing it all to one axis would be an invention.
    return { errorM, alongM: 0, crossM: 0 };
  }

  const h = (truthHeadingDeg * Math.PI) / 180;
  const fE = Math.sin(h);
  const fN = Math.cos(h);
  return {
    errorM,
    alongM: de * fE + dn * fN,
    // Right-hand normal to the direction of travel.
    crossM: de * fN - dn * fE,
  };
}

function rms(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/** Distance the vehicle actually covered between two instants, from truth. */
export function truthDistanceM(
  truth: readonly TruthPoint[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  let prev: TruthPoint | null = null;
  for (const p of truth) {
    if (p.t < fromMs || p.t > toMs) continue;
    if (prev) total += haversineDistance(prev.lat, prev.lon, p.lat, p.lon);
    prev = p;
  }
  return total;
}

export interface ComputeMetricsInput {
  configName: string;
  log: string;
  outageStartMs: number;
  outageDurationMs: number;
  /** States emitted while GNSS was withheld — the stretch under test. */
  outageStates: readonly NavigationState[];
  truth: readonly TruthPoint[];
  /** First state at or after GNSS returned, for recovery timing. */
  recoveredAtMs: number | null;
  zuptTriggers: number;
  zaruTriggers: number;
  roadSnapAppliedFraction: number;
  positionResets: number;
}

/**
 * Every metric the build guide asks for, computed over the outage window.
 *
 * Only the outage is scored. Outside it the estimate is reset onto GNSS every
 * fix, so including it would average the real error down toward zero and make
 * a longer drive look more accurate than a shorter one.
 */
export function computeMetrics(input: ComputeMetricsInput): EvalMetrics {
  const errors: ErrorSample[] = [];

  for (const s of input.outageStates) {
    const truthPos = truthAt(input.truth, s.t);
    if (!truthPos) continue;
    const heading = truthHeadingAt(input.truth, s.t);
    const d = decomposeError(s.position, truthPos, heading);
    errors.push({ t: s.t, errorM: d.errorM, alongM: d.alongM, crossM: d.crossM });
  }

  const magnitudes = errors.map((e) => e.errorM);
  const sorted = [...magnitudes].sort((a, b) => a - b);
  const outageEndMs = input.outageStartMs + input.outageDurationMs;
  const distanceTravelledM = truthDistanceM(input.truth, input.outageStartMs, outageEndMs);
  const finalErrorM = errors.length > 0 ? errors[errors.length - 1]!.errorM : 0;

  const first = input.outageStates[0];
  const last = input.outageStates[input.outageStates.length - 1];
  const spanMs = first && last ? last.t - first.t : 0;
  const meanUpdateHz =
    spanMs > 0 && input.outageStates.length > 1
      ? ((input.outageStates.length - 1) / spanMs) * 1000
      : 0;

  return {
    configName: input.configName,
    log: input.log,
    outageStartMs: input.outageStartMs,
    outageDurationS: input.outageDurationMs / 1000,
    samples: errors.length,
    distanceTravelledM,
    // Guarded: over a few metres of travel the ratio is dominated by its
    // denominator and says nothing useful.
    driftPercent: distanceTravelledM > 20 ? (finalErrorM / distanceTravelledM) * 100 : NaN,
    finalErrorM,
    rmseM: rms(magnitudes),
    maeM:
      magnitudes.length > 0
        ? magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length
        : 0,
    maxErrorM: magnitudes.length > 0 ? Math.max(...magnitudes) : 0,
    alongTrackRmseM: rms(errors.map((e) => e.alongM)),
    crossTrackRmseM: rms(errors.map((e) => e.crossM)),
    cep95M: percentile(sorted, 0.95),
    recoveryTimeS:
      input.recoveredAtMs === null ? null : (input.recoveredAtMs - outageEndMs) / 1000,
    meanUpdateHz,
    zuptTriggers: input.zuptTriggers,
    zaruTriggers: input.zaruTriggers,
    roadSnapAppliedPct: input.roadSnapAppliedFraction * 100,
    positionResets: input.positionResets,
  };
}
