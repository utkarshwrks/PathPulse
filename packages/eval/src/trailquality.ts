/**
 * How messy is the drawn line?
 *
 * ★ THE COMPLAINT THIS EXISTS TO TURN INTO A NUMBER ★
 * From the field, on live GNSS: "the green line fluctuate a lot ... it again
 * becomes messy". Accuracy metrics cannot see that. A track can sit 3 m from
 * the truth on average — a good number — while zig-zagging across it every
 * fix, and mean error is identical for a smooth line and a saw-tooth through
 * the same points. Drift is the wrong instrument for a legibility bug.
 *
 * So this measures the shape instead:
 *
 *   tortuosity   drawn path length / true path length. 1.00 is a line that
 *                goes exactly as far as the vehicle did; 1.30 has drawn 30%
 *                more line than there was road, and every extra centimetre is
 *                a wiggle. This is the number that matches what the eye calls
 *                "messy".
 *
 *   reversals    fraction of trail vertices where the direction of travel
 *                turns by more than 90 degrees. On a road, essentially zero.
 *                Receiver noise produces them constantly, and they are what
 *                makes a line look like a scribble rather than a curve.
 *
 *   turnDeg      mean absolute heading change per vertex.
 *
 * And, because a smoother that achieves all three by drawing somewhere the
 * vehicle was not is worse than the problem:
 *
 *   crossTrackRmsM / p90M   error against the simulated truth.
 *
 * The pairing is the whole point. Any of these alone can be gamed; together
 * they cannot. A change that lowers tortuosity while raising cross-track error
 * has not smoothed the line, it has moved it.
 */
import {
  NavigationEngine,
  appendTrailPoint,
  buildTrailSegments,
  haversineDistance,
} from '@pathpulse/nav-core';
import type { EngineConfig, RoadGraph, SensorSample, TrailPoint } from '@pathpulse/nav-core';
import { SimulationSource } from '@pathpulse/sensor-sources';
import type { RouteGeoJson } from '@pathpulse/sensor-sources';

export interface TrailQuality {
  tortuosity: number;
  reversalFraction: number;
  meanTurnDeg: number;
  crossTrackRmsM: number;
  crossTrackP90M: number;
  /**
   * Signed mean along-track error, metres. Negative means the marker sits
   * BEHIND where the vehicle is.
   *
   * ★ KEPT APART FROM CROSS-TRACK BECAUSE THEY ARE DIFFERENT COMPLAINTS ★
   * Total position error here is dominated by lag: the estimate is pulled
   * toward each fix at a fixed fraction, so it trails the vehicle by a few
   * seconds, which at 14 m/s is tens of metres of along-track error and
   * almost none of it visible as mess. Cross-track is what decides whether
   * the line looks like it is on the road. Averaging the two together
   * reports a smoothing change as a regression, or hides one.
   */
  alongTrackMeanM: number;
  points: number;
  truthDistanceM: number;
}

/** Bearing a to b, degrees clockwise from north. */
function bearingDeg(a: TrailPoint, b: TrailPoint): number {
  const dLat = b.lat - a.lat;
  const dLon = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  return (Math.atan2(dLon, dLat) * 180) / Math.PI;
}

function angleDiff(a: number, b: number): number {
  let d = ((b - a + 180) % 360) - 180;
  if (d < -180) d += 360;
  return Math.abs(d);
}

export function measureTrail(
  trail: readonly TrailPoint[],
  truth: ReadonlyArray<{ t: number; lat: number; lon: number }>,
): TrailQuality {
  let drawn = 0;
  for (let i = 1; i < trail.length; i++) {
    drawn += haversineDistance(trail[i - 1]!.lat, trail[i - 1]!.lon, trail[i]!.lat, trail[i]!.lon);
  }
  let truthDist = 0;
  for (let i = 1; i < truth.length; i++) {
    truthDist += haversineDistance(truth[i - 1]!.lat, truth[i - 1]!.lon, truth[i]!.lat, truth[i]!.lon);
  }

  let turns = 0;
  let reversals = 0;
  let turnSum = 0;
  for (let i = 2; i < trail.length; i++) {
    const b1 = bearingDeg(trail[i - 2]!, trail[i - 1]!);
    const b2 = bearingDeg(trail[i - 1]!, trail[i]!);
    const d = angleDiff(b1, b2);
    turnSum += d;
    turns++;
    if (d > 90) reversals++;
  }

  // Error against the truth, decomposed onto the direction the vehicle was
  // actually travelling. The truth is sampled far denser than the trail, so
  // the nearest-in-time point is a fair reference.
  const cross: number[] = [];
  let alongSum = 0;
  let ti = 0;
  for (const p of trail) {
    while (ti + 1 < truth.length && truth[ti + 1]!.t <= p.t) ti++;
    const tp = truth[ti];
    const next = truth[ti + 1] ?? truth[ti];
    if (!tp || !next) continue;
    const cosLat = Math.cos((tp.lat * Math.PI) / 180);
    // Local flat-earth metres. Over the tens of metres involved this is exact
    // enough, and it keeps the projection to two multiplications.
    const ex = (p.lon - tp.lon) * 111_320 * cosLat;
    const ey = (p.lat - tp.lat) * 110_574;
    let hx = (next.lon - tp.lon) * 111_320 * cosLat;
    let hy = (next.lat - tp.lat) * 110_574;
    const hlen = Math.hypot(hx, hy);
    if (hlen < 1e-9) continue;
    hx /= hlen;
    hy /= hlen;
    alongSum += ex * hx + ey * hy;
    // Perpendicular component: the signed distance off the line of travel.
    cross.push(Math.abs(ex * -hy + ey * hx));
  }
  cross.sort((a, b) => a - b);
  const rms = cross.length
    ? Math.sqrt(cross.reduce((s, e) => s + e * e, 0) / cross.length)
    : 0;

  return {
    tortuosity: truthDist > 0 ? drawn / truthDist : 0,
    reversalFraction: turns > 0 ? reversals / turns : 0,
    meanTurnDeg: turns > 0 ? turnSum / turns : 0,
    crossTrackRmsM: rms,
    crossTrackP90M: cross.length ? cross[Math.floor(cross.length * 0.9)]! : 0,
    alongTrackMeanM: cross.length ? alongSum / cross.length : 0,
    points: trail.length,
    truthDistanceM: truthDist,
  };
}

export interface DriveOptions {
  route: RouteGeoJson;
  graph?: RoadGraph | null;
  /** Reported and actual 1-sigma horizontal error, metres. */
  gnssAccuracyM: number;
  /** Fix rate. A handset is nearer 1 Hz than the 5 Hz a simulator defaults to. */
  gnssRateHz: number;
  imuRateHz?: number;
  seconds: number;
  seed?: number;
  config?: Partial<EngineConfig>;
  /** Overrides the trail's separation filter, for comparing filters. */
  trailOptions?: { maxPoints?: number; minSeparationM?: number; simplifyToleranceM?: number };
  /** Centred half-window used when rendering. 0 draws the raw buffer. */
  smoothHalfWindow?: number;
}

/**
 * Drive the simulator through the engine and collect the trail the app would
 * have drawn — including the 10 Hz emit throttle, which decides how often a
 * point is even offered to the buffer.
 */
export function driveTrail(opts: DriveOptions): {
  quality: TrailQuality;
  trail: TrailPoint[];
} {
  const imuRateHz = opts.imuRateHz ?? 50;
  const source = new SimulationSource({
    route: opts.route,
    gnssAccuracyM: opts.gnssAccuracyM,
    gnssRateHz: opts.gnssRateHz,
    imuRateHz,
    seed: opts.seed ?? 1337,
    loop: true,
  });
  const engine = new NavigationEngine(opts.config ?? {});
  if (opts.graph) engine.setRoadGraph(opts.graph);

  const truth: Array<{ t: number; lat: number; lon: number }> = [];
  let trail: TrailPoint[] = [];
  let lastEmitMs = -Infinity;
  const EMIT_INTERVAL_MS = 100;

  const stepMs = 1000 / imuRateHz;
  const steps = Math.round((opts.seconds * 1000) / stepMs);


  // Stepped one sample at a time rather than advanced in one call, because the
  // truth has to be read BETWEEN samples: `advance` returns the whole batch and
  // by then the vehicle has moved to the end of it.
  for (let i = 0; i < steps; i++) {
    const emitted: SensorSample[] = source.advance(stepMs);
    for (const sample of emitted) {
      const t = source.truthPosition;
      truth.push({ t: sample.t, lat: t.lat, lon: t.lon });

      const state = engine.update(sample);
      if (sample.t - lastEmitMs < EMIT_INTERVAL_MS - stepMs / 2) continue;
      lastEmitMs = sample.t;
      if (state.mode === 'INITIALIZING') continue;
      if (state.position.lat === 0 && state.position.lon === 0) continue;
      trail = appendTrailPoint(
        trail,
        { lat: state.position.lat, lon: state.position.lon, mode: state.mode, t: state.t },
        opts.trailOptions ?? {},
      );
    }
  }

  // ★ SCORE WHAT IS DRAWN, NOT WHAT IS STORED ★
  // The buffer is deliberately raw; the smoothing is a render decision. So the
  // metrics have to be taken from the rendered geometry, or they measure a
  // line nobody sees.
  const drawn: TrailPoint[] = [];
  for (const seg of buildTrailSegments(trail, {
    smoothHalfWindow: opts.smoothHalfWindow ?? 0,
  })) {
    for (const [lon, lat] of seg.coordinates) {
      drawn.push({ lon, lat, mode: seg.mode, t: 0 });
    }
  }
  // Times are needed to line the drawn line up against the truth, and the
  // segments dropped them. Restored by position in the buffer, which is exact:
  // rendering only moves vertices, it never adds or removes them.
  let k = 0;
  for (const d of drawn) {
    if (k < trail.length) d.t = trail[Math.min(k, trail.length - 1)]!.t;
    k++;
  }
  return { quality: measureTrail(drawn, truth), trail };
}
