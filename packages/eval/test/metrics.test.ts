import { describe, expect, it } from 'vitest';
import type { NavigationState } from '@pathpulse/nav-core';
import {
  computeMetrics,
  decomposeError,
  truthAt,
  truthDistanceM,
  truthHeadingAt,
  type TruthPoint,
} from '../src/metrics.js';
import { extractTruth, parseJsonl, runEval } from '../src/harness.js';

const LAT = 28.6315;
const LON = 77.2167;
const M_PER_LAT = 111_320;
const M_PER_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

/** A truth track heading due east at a constant speed. */
function eastwardTruth(speedMps = 10, seconds = 10): TruthPoint[] {
  const out: TruthPoint[] = [];
  for (let s = 0; s <= seconds; s++) {
    out.push({ t: s * 1000, lat: LAT, lon: LON + (speedMps * s) / M_PER_LON });
  }
  return out;
}

function offsetLatLon(east: number, north: number) {
  return { lat: LAT + north / M_PER_LAT, lon: LON + east / M_PER_LON };
}

describe('truthAt — interpolation, not nearest neighbour', () => {
  const truth = eastwardTruth();

  it('returns the endpoints exactly', () => {
    expect(truthAt(truth, 0)!.lon).toBeCloseTo(LON, 9);
    expect(truthAt(truth, 10_000)!.lon).toBeCloseTo(LON + 100 / M_PER_LON, 9);
  });

  it('interpolates between fixes', () => {
    // ★ WHY NOT NEAREST ★ Truth arrives at the GNSS rate and the estimate at
    // the IMU rate. Snapping to the nearest fix would charge the estimator for
    // up to half a fix-interval of real travel — 7 m at 14 m/s and 1 Hz, which
    // is the same order as the errors being measured.
    const mid = truthAt(truth, 5500)!;
    expect((mid.lon - LON) * M_PER_LON).toBeCloseTo(55, 3);
  });

  it('clamps outside the recorded span rather than extrapolating', () => {
    expect(truthAt(truth, -9999)!.lon).toBeCloseTo(LON, 9);
    expect(truthAt(truth, 99_999)!.lon).toBeCloseTo(LON + 100 / M_PER_LON, 9);
  });

  it('returns null with no truth at all', () => {
    expect(truthAt([], 0)).toBeNull();
  });

  it('handles a single truth point', () => {
    expect(truthAt([{ t: 0, lat: LAT, lon: LON }], 5000)!.lat).toBeCloseTo(LAT, 9);
  });
});

describe('truthHeadingAt', () => {
  it('reads due east as 90 degrees', () => {
    expect(truthHeadingAt(eastwardTruth(), 5000)!).toBeCloseTo(90, 1);
  });

  it('reads due north as 0 degrees', () => {
    const north: TruthPoint[] = [];
    for (let s = 0; s <= 10; s++) north.push({ t: s * 1000, lat: LAT + (10 * s) / M_PER_LAT, lon: LON });
    expect(truthHeadingAt(north, 5000)!).toBeCloseTo(0, 1);
  });

  it('refuses a heading when the vehicle is not moving', () => {
    // A direction derived from fix noise is worse than admitting there is none.
    const still: TruthPoint[] = [];
    for (let s = 0; s <= 10; s++) still.push({ t: s * 1000, lat: LAT, lon: LON });
    expect(truthHeadingAt(still, 5000)).toBeNull();
  });

  it('returns null with too little truth to have a direction', () => {
    expect(truthHeadingAt([{ t: 0, lat: LAT, lon: LON }], 0)).toBeNull();
  });
});

describe('decomposeError — along-track vs cross-track', () => {
  const truth = { lat: LAT, lon: LON };

  it('calls an error ahead of truth pure along-track', () => {
    // Travelling east, 30 m further east than reality.
    const d = decomposeError(offsetLatLon(30, 0), truth, 90);
    expect(d.errorM).toBeCloseTo(30, 2);
    expect(d.alongM).toBeCloseTo(30, 2);
    expect(d.crossM).toBeCloseTo(0, 2);
  });

  it('calls an error behind truth negative along-track', () => {
    const d = decomposeError(offsetLatLon(-30, 0), truth, 90);
    expect(d.alongM).toBeCloseTo(-30, 2);
  });

  it('calls a sideways error pure cross-track', () => {
    // Travelling east, 25 m to the south — right of the direction of travel.
    const d = decomposeError(offsetLatLon(0, -25), truth, 90);
    expect(d.errorM).toBeCloseTo(25, 2);
    expect(d.alongM).toBeCloseTo(0, 2);
    expect(d.crossM).toBeCloseTo(25, 2);
  });

  it('signs the two sides of the road oppositely', () => {
    const right = decomposeError(offsetLatLon(0, -25), truth, 90);
    const left = decomposeError(offsetLatLon(0, 25), truth, 90);
    expect(Math.sign(right.crossM)).toBe(-Math.sign(left.crossM));
  });

  it('splits a diagonal error into both components', () => {
    const d = decomposeError(offsetLatLon(30, -40), truth, 90);
    expect(d.errorM).toBeCloseTo(50, 1);
    expect(d.alongM).toBeCloseTo(30, 1);
    expect(d.crossM).toBeCloseTo(40, 1);
    // Pythagoras must hold, or the decomposition is losing energy somewhere.
    expect(Math.hypot(d.alongM, d.crossM)).toBeCloseTo(d.errorM, 3);
  });

  it('rotates with the direction of travel', () => {
    // The same physical offset is along-track heading east and cross-track
    // heading north. That is the entire point of decomposing against truth.
    const east = decomposeError(offsetLatLon(30, 0), truth, 90);
    const north = decomposeError(offsetLatLon(30, 0), truth, 0);
    expect(east.alongM).toBeCloseTo(30, 1);
    expect(Math.abs(north.crossM)).toBeCloseTo(30, 1);
  });

  it('declines to split when there is no direction of travel', () => {
    // Attributing a stationary error to one axis would be an invention.
    const d = decomposeError(offsetLatLon(30, 0), truth, null);
    expect(d.errorM).toBeCloseTo(30, 2);
    expect(d.alongM).toBe(0);
    expect(d.crossM).toBe(0);
  });
});

describe('truthDistanceM', () => {
  it('measures the distance actually covered in a window', () => {
    expect(truthDistanceM(eastwardTruth(10, 10), 0, 10_000)).toBeCloseTo(100, 0);
  });

  it('measures only inside the window', () => {
    expect(truthDistanceM(eastwardTruth(10, 10), 2000, 5000)).toBeCloseTo(30, 0);
  });

  it('is zero for an empty window', () => {
    expect(truthDistanceM(eastwardTruth(), 50_000, 60_000)).toBe(0);
  });
});

describe('computeMetrics', () => {
  const truth = eastwardTruth(10, 20);

  function stateAt(t: number, east: number, north = 0): NavigationState {
    const p = offsetLatLon((10 * t) / 1000 + east, north);
    return {
      t,
      mode: 'DEAD_RECKONING',
      position: p,
      velocityMps: 10,
      headingDeg: 90,
      covariance: { alongM: 5, crossM: 5, headingDeg: 2 },
      confidence: 0.5,
      distanceTravelledM: (10 * t) / 1000,
      timeSinceGnssMs: t,
      estimatedDriftM: 0,
      biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    };
  }

  const base = {
    configName: 'test',
    log: 'test.jsonl',
    outageStartMs: 0,
    outageDurationMs: 10_000,
    truth,
    recoveredAtMs: 11_500,
    zuptTriggers: 4,
    zaruTriggers: 9,
    roadSnapAppliedFraction: 0.873,
    positionResets: 0,
  };

  it('reports zero error for a perfect estimate', () => {
    const states = [0, 2500, 5000, 7500, 10_000].map((t) => stateAt(t, 0));
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.finalErrorM).toBeCloseTo(0, 2);
    expect(m.rmseM).toBeCloseTo(0, 2);
    expect(m.driftPercent).toBeCloseTo(0, 2);
  });

  it('computes drift as final error over distance actually travelled', () => {
    // 10 m out at the end of 100 m of real travel is 10%.
    const states = [0, 5000, 10_000].map((t) => stateAt(t, t === 10_000 ? 10 : 0));
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.distanceTravelledM).toBeCloseTo(100, 0);
    expect(m.finalErrorM).toBeCloseTo(10, 1);
    expect(m.driftPercent).toBeCloseTo(10, 1);
  });

  it('refuses a drift percentage over a trivial distance', () => {
    // Over a few metres the ratio is dominated by its denominator and would
    // report a spectacular percentage for a harmless error.
    const m = computeMetrics({
      ...base,
      outageDurationMs: 500,
      outageStates: [stateAt(0, 1)],
    });
    expect(Number.isNaN(m.driftPercent)).toBe(true);
  });

  it('separates a purely along-track error from cross-track', () => {
    const states = [0, 5000, 10_000].map((t) => stateAt(t, 20, 0));
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.alongTrackRmseM).toBeCloseTo(20, 0);
    expect(m.crossTrackRmseM).toBeCloseTo(0, 0);
  });

  it('separates a purely cross-track error from along-track', () => {
    const states = [0, 5000, 10_000].map((t) => stateAt(t, 0, 15));
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.crossTrackRmseM).toBeCloseTo(15, 0);
    expect(m.alongTrackRmseM).toBeCloseTo(0, 0);
  });

  it('reports max error and CEP95 above the mean', () => {
    const states = [
      stateAt(0, 0),
      stateAt(2500, 2),
      stateAt(5000, 4),
      stateAt(7500, 8),
      stateAt(10_000, 40),
    ];
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.maxErrorM).toBeCloseTo(40, 0);
    expect(m.cep95M).toBeGreaterThanOrEqual(m.maeM);
    expect(m.maxErrorM).toBeGreaterThanOrEqual(m.cep95M);
    expect(m.rmseM).toBeGreaterThanOrEqual(m.maeM);
  });

  it('measures recovery from the end of the outage, not the start', () => {
    const m = computeMetrics({ ...base, outageStates: [stateAt(0, 0)] });
    expect(m.recoveryTimeS).toBeCloseTo(1.5, 3);
  });

  it('reports no recovery time when it never recovered', () => {
    const m = computeMetrics({ ...base, recoveredAtMs: null, outageStates: [stateAt(0, 0)] });
    expect(m.recoveryTimeS).toBeNull();
  });

  it('passes the constraint counters through', () => {
    const m = computeMetrics({ ...base, outageStates: [stateAt(0, 0)] });
    expect(m.zuptTriggers).toBe(4);
    expect(m.zaruTriggers).toBe(9);
    expect(m.roadSnapAppliedPct).toBeCloseTo(87.3, 3);
  });

  it('survives an empty outage without throwing', () => {
    const m = computeMetrics({ ...base, outageStates: [] });
    expect(m.samples).toBe(0);
    expect(m.finalErrorM).toBe(0);
    expect(m.maxErrorM).toBe(0);
  });
});

describe('harness — the ground-truth trick', () => {
  const jsonl = [
    { t: 0, imu: { ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 }, gnss: { lat: LAT, lon: LON, accuracyM: 4 } },
    { t: 1000, imu: { ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 } },
    { t: 2000, imu: { ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 }, gnss: { lat: LAT, lon: LON + 0.001, accuracyM: 4 } },
  ]
    .map((s) => JSON.stringify(s))
    .join('\n');

  it('parses JSONL and sorts by time', () => {
    const out = parseJsonl(`${JSON.stringify({ t: 2000 })}\n${JSON.stringify({ t: 0 })}`);
    expect(out.map((s) => s.t)).toEqual([0, 2000]);
  });

  it('skips a truncated final line', () => {
    expect(parseJsonl(`${jsonl}\n{"t":3000,"imu":{`).length).toBe(3);
  });

  it('extracts every recorded fix as ground truth', () => {
    expect(extractTruth(parseJsonl(jsonl))).toHaveLength(2);
  });

  it('withholds GNSS from the estimator during the outage, but keeps the IMU', () => {
    // ★ The estimator must see exactly what a tunnel looks like: the gnss field
    // absent, not zeroed — while the IMU keeps arriving, because that is what
    // dead reckoning runs on.
    const samples = parseJsonl(jsonl);
    const result = runEval(samples, {
      configName: 'test',
      logName: 'test.jsonl',
      engineConfig: {},
      outageStartMs: 1500,
      outageDurationMs: 1000,
    });
    // Truth still holds the fix that was hidden from the engine.
    expect(result.truth).toHaveLength(2);
    expect(result.states.length).toBe(samples.length);
  });

  it('does not mutate the caller\'s samples while stripping GNSS', () => {
    const samples = parseJsonl(jsonl);
    runEval(samples, {
      configName: 'test',
      logName: 'test.jsonl',
      engineConfig: {},
      outageStartMs: 0,
      outageDurationMs: 5000,
    });
    // The ablation reuses one parsed log across every config; mutating it would
    // silently delete GNSS for every run after the first.
    expect(samples.filter((s) => s.gnss)).toHaveLength(2);
  });
});
