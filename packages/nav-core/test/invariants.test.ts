import { describe, expect, it } from 'vitest';
import {
  NavigationEngine,
  haversineDistance,
  type NavigationState,
  type SensorSample,
} from '../src/index.js';

const G = 9.80665;
const START = { lat: 28.6315, lon: 77.2167 };

/**
 * Invariants that must hold whatever the input.
 *
 * These are the properties a demo depends on but a scenario test will not
 * catch: that the engine is deterministic, that it never emits a non-finite
 * value, that the marker never teleports in any mode or configuration, and
 * that a hostile or broken sensor stream cannot make it explode.
 */

/** A drive with configurable outage and optional hostile input. */
function drive(opts: {
  durationS: number;
  outageStartS?: number;
  outageEndS?: number;
  speedMps?: number;
  imuHz?: number;
  noGnssEver?: boolean;
  noImuEver?: boolean;
}): SensorSample[] {
  const {
    durationS,
    outageStartS = -1,
    outageEndS = -1,
    speedMps = 14,
    imuHz = 50,
    noGnssEver = false,
    noImuEver = false,
  } = opts;
  const dtMs = 1000 / imuHz;
  const out: SensorSample[] = [];
  let nextGnssMs = 0;

  for (let tMs = 0; tMs <= durationS * 1000; tMs += dtMs) {
    const p = (tMs / 1000) * 2 * Math.PI * 20;
    const s: SensorSample = { t: Math.round(tMs) };
    if (!noImuEver) {
      s.imu = {
        ax: 0.8 * Math.sin(p),
        ay: 0.8 * Math.sin(p * 1.31),
        az: G + 0.8 * Math.sin(p * 0.77),
        gx: 0,
        gy: 0,
        gz: -0.02, // gentle right turn, right-hand rule
      };
    }
    if (!noGnssEver && tMs >= nextGnssMs) {
      nextGnssMs += 1000;
      const inOutage = tMs >= outageStartS * 1000 && tMs < outageEndS * 1000;
      if (!inOutage) {
        const metresEast = (speedMps * tMs) / 1000;
        s.gnss = {
          lat: START.lat,
          lon: START.lon + metresEast / (111_320 * Math.cos((START.lat * Math.PI) / 180)),
          accuracyM: 4,
          speedMps,
          headingDeg: 90,
          satCount: 9,
        };
      }
    }
    out.push(s);
  }
  return out;
}

function run(samples: SensorSample[], config = {}): NavigationState[] {
  const engine = new NavigationEngine(config);
  return samples.map((s) => engine.update(s));
}

/**
 * Max jump, ignoring frames where the engine logged an explicit POSITION_RESET.
 *
 * A reset is a declared, explained jump — the honest response to an estimate
 * that is kilometres out. Silent jumps are the thing the rule forbids.
 */
function maxUnexplainedJumpM(samples: SensorSample[], config = {}): number {
  const engine = new NavigationEngine(config);
  let prev: NavigationState | null = null;
  let seenResets = 0;
  let max = 0;
  for (const s of samples) {
    const st = engine.update(s);
    const resets = engine.events.all.filter((e) => e.type === 'POSITION_RESET').length;
    const justReset = resets > seenResets;
    seenResets = resets;
    if (prev && !justReset && prev.mode !== 'INITIALIZING' && st.mode !== 'INITIALIZING') {
      const d = haversineDistance(
        prev.position.lat,
        prev.position.lon,
        st.position.lat,
        st.position.lon,
      );
      if (d > max) max = d;
    }
    prev = st;
  }
  return max;
}

describe('determinism — the ablation table depends on it', () => {
  it('produces byte-identical output for identical input', () => {
    // If this ever fails, every measured number in the project becomes a
    // measurement of luck rather than of the constraints.
    const samples = drive({ durationS: 60, outageStartS: 20, outageEndS: 40 });
    const a = run(samples);
    const b = run(samples);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is unaffected by wall-clock time or ordering of construction', () => {
    const samples = drive({ durationS: 30, outageStartS: 10, outageEndS: 20 });
    const first = run(samples);
    // Build an unrelated engine in between, in case of shared module state.
    run(drive({ durationS: 5 }));
    const second = run(samples);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('a reset engine behaves like a fresh one', () => {
    const samples = drive({ durationS: 40, outageStartS: 15, outageEndS: 30 });
    const fresh = run(samples);

    const reused = new NavigationEngine();
    for (const s of drive({ durationS: 25, outageStartS: 5, outageEndS: 15 })) reused.update(s);
    reused.reset();
    const after = samples.map((s) => reused.update(s));

    expect(JSON.stringify(after)).toBe(JSON.stringify(fresh));
  });
});

describe('never emit a non-finite state', () => {
  const hostile: Array<[string, Partial<SensorSample['imu']>]> = [
    ['NaN accel', { ax: NaN, ay: NaN, az: NaN }],
    ['Infinity accel', { ax: Infinity, ay: -Infinity, az: Infinity }],
    ['NaN gyro', { gx: NaN, gy: NaN, gz: NaN }],
    ['absurd accel', { ax: 1e12, ay: -1e12, az: 1e12 }],
    ['absurd gyro', { gx: 1e9, gy: 1e9, gz: 1e9 }],
    ['all zero', { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 }],
  ];

  it.each(hostile)('survives %s', (_name, patch) => {
    const engine = new NavigationEngine();
    const samples = drive({ durationS: 30, outageStartS: 10, outageEndS: 25 });
    for (const s of samples) {
      if (s.imu && s.t > 12_000) Object.assign(s.imu, patch);
      const st = engine.update(s);
      expect(Number.isFinite(st.position.lat)).toBe(true);
      expect(Number.isFinite(st.position.lon)).toBe(true);
      expect(Number.isFinite(st.velocityMps)).toBe(true);
      expect(Number.isFinite(st.headingDeg)).toBe(true);
      expect(Number.isFinite(st.confidence)).toBe(true);
      expect(Number.isFinite(st.estimatedDriftM)).toBe(true);
    }
  });

  it('survives a hostile GNSS fix', () => {
    const engine = new NavigationEngine();
    for (const s of drive({ durationS: 30 })) {
      if (s.gnss && s.t > 10_000) {
        s.gnss.lat = NaN;
        s.gnss.accuracyM = -5;
        s.gnss.speedMps = Infinity;
      }
      const st = engine.update(s);
      expect(Number.isFinite(st.position.lat)).toBe(true);
      expect(Number.isFinite(st.velocityMps)).toBe(true);
    }
  });

  it('keeps confidence and heading inside their ranges at all times', () => {
    const states = run(drive({ durationS: 120, outageStartS: 20, outageEndS: 100 }));
    for (const s of states) {
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(s.headingDeg).toBeGreaterThanOrEqual(0);
      expect(s.headingDeg).toBeLessThan(360);
      expect(s.velocityMps).toBeGreaterThanOrEqual(0);
      expect(s.distanceTravelledM).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Golden Rule #6 — the dot never teleports', () => {
  // 14 m/s at 50 Hz is 0.28 m between samples. Anything past a couple of
  // metres is a jump a judge would see and read as a bug.
  const CONFIGS: Array<[string, Record<string, unknown>]> = [
    ['full', {}],
    ['no NHC', { nhc: false }],
    ['no ZUPT', { zupt: false }],
    ['no ZARU', { zaru: false }],
    ['no forward bias', { forwardBias: false }],
    ['no speed clamp', { speedClamp: false }],
    ['no filters', { lowPass: false, medianFilter: false }],
    ['fixed timeout', { adaptiveTimeout: false }],
  ];

  it.each(CONFIGS)('holds through a full outage cycle — %s', (_name, config) => {
    const samples = drive({ durationS: 90, outageStartS: 20, outageEndS: 70 });
    expect(maxUnexplainedJumpM(samples, config)).toBeLessThan(5);
  });

  it('holds across repeated outage cycles', () => {
    // State leaking between cycles would show up here as a jump on the second
    // or third recovery, not the first.
    // The cycles must continue in SPACE as well as time. An earlier version
    // restarted each cycle at the same coordinates, which teleported the
    // *fixture* by 800 m and blamed the engine for it.
    const samples: SensorSample[] = [];
    let tOffset = 0;
    let lonOffset = 0;
    const metresPerDeg = 111_320 * Math.cos((START.lat * Math.PI) / 180);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const s of drive({ durationS: 60, outageStartS: 20, outageEndS: 40 })) {
        const copy: SensorSample = { ...s, t: s.t + tOffset };
        if (s.gnss) copy.gnss = { ...s.gnss, lon: s.gnss.lon + lonOffset };
        samples.push(copy);
      }
      tOffset += 60_000;
      lonOffset += (14 * 60) / metresPerDeg;
    }
    const states = run(samples);
    expect(maxUnexplainedJumpM(samples)).toBeLessThan(5);
    // And it must still be cycling, not stuck.
    const modes = new Set(states.map((s) => s.mode));
    expect(modes.has('DEAD_RECKONING')).toBe(true);
    expect(modes.has('RECOVERING')).toBe(true);
  });

  it('holds when GNSS returns far from the estimate', () => {
    // A large drift must be slewed at a bounded rate, never snapped — unless
    // it is so large that the estimate is worthless, in which case the reset
    // must be explicit and logged rather than disguised as a smooth slide.
    const samples = drive({ durationS: 200, outageStartS: 20, outageEndS: 180 });
    expect(maxUnexplainedJumpM(samples)).toBeLessThan(5);
  });

  it('explains a reset rather than jumping silently', () => {
    const engine = new NavigationEngine();
    for (const s of drive({ durationS: 400, outageStartS: 20, outageEndS: 380 })) {
      engine.update(s);
    }
    const resets = engine.events.all.filter((e) => e.type === 'POSITION_RESET');
    expect(resets.length).toBeGreaterThan(0);
    expect(resets[0]!.message).toMatch(/too far to slew/);
  });
});

describe('hostile and degenerate sensor streams', () => {
  it('runs with no GNSS at all', () => {
    const states = run(drive({ durationS: 60, noGnssEver: true }));
    expect(states[states.length - 1]!.mode).toBe('INITIALIZING');
    expect(states.every((s) => Number.isFinite(s.position.lat))).toBe(true);
  });

  it('runs with no IMU at all', () => {
    const states = run(drive({ durationS: 60, noImuEver: true }));
    expect(states.some((s) => s.mode === 'GNSS')).toBe(true);
    expect(states.every((s) => Number.isFinite(s.velocityMps))).toBe(true);
  });

  it('ignores duplicate and out-of-order timestamps', () => {
    const engine = new NavigationEngine();
    const samples = drive({ durationS: 20 });
    for (const s of samples) engine.update(s);
    const good = engine.update({ ...samples[samples.length - 1]!, t: 20_100 });

    // Replay the past: must not move the marker.
    for (let i = 0; i < 50; i++) engine.update(samples[i]!);
    const after = engine.update({ ...samples[0]!, t: 5_000 });
    expect(after.position.lat).toBeCloseTo(good.position.lat, 9);
    expect(after.position.lon).toBeCloseTo(good.position.lon, 9);
  });

  it('survives a clock jumping far forwards', () => {
    const engine = new NavigationEngine();
    for (const s of drive({ durationS: 20 })) engine.update(s);
    const before = engine.update({ t: 20_100, imu: { ax: 0, ay: 0, az: G, gx: 0, gy: 0, gz: 0 } });
    // An hour in a single step.
    const after = engine.update({
      t: 3_620_000,
      imu: { ax: 0, ay: 0, az: G, gx: 0, gy: 0, gz: 0 },
    });
    const jump = haversineDistance(
      before.position.lat,
      before.position.lon,
      after.position.lat,
      after.position.lon,
    );
    expect(jump).toBeLessThan(5);
    expect(Number.isFinite(after.position.lat)).toBe(true);
  });

  it('handles a very low sample rate without exploding', () => {
    // At 5 Hz the vehicle legitimately covers 2.8 m between samples at 14 m/s,
    // and a bounded 60 m/s slew adds 12 m more. 5 Hz is itself well below the
    // problem statement's 10 Hz floor, so this is a degradation check rather
    // than a supported mode: the requirement is that it stays continuous.
    const samples = drive({ durationS: 90, outageStartS: 20, outageEndS: 70, imuHz: 5 });
    const states = run(samples);
    expect(maxUnexplainedJumpM(samples)).toBeLessThan(16);
    expect(states.every((s) => Number.isFinite(s.position.lat))).toBe(true);
  });

  it('bounds the event log so a long session cannot exhaust memory', () => {
    const engine = new NavigationEngine();
    const samples: SensorSample[] = [];
    let offset = 0;
    for (let cycle = 0; cycle < 8; cycle++) {
      for (const s of drive({ durationS: 40, outageStartS: 10, outageEndS: 25 })) {
        samples.push({ ...s, t: s.t + offset });
      }
      offset += 40_000;
    }
    for (const s of samples) engine.update(s);
    expect(engine.events.all.length).toBeLessThanOrEqual(200);
  });
});

describe('long outage behaviour', () => {
  it('does not assert a speed it cannot justify after minutes unaided', () => {
    // The coasting decay exists so a stale estimate is bled off rather than
    // asserted indefinitely — the field defect was 197 s at a confident
    // 25.8 km/h while the phone was standing still.
    // The outage must still be running at the final sample. An earlier version
    // ended it at 590 s and then measured at 600 s, so the 14 m/s it read was
    // simply the GNSS speed that had already come back.
    const engine = new NavigationEngine();
    for (const s of drive({ durationS: 600, outageStartS: 20, outageEndS: 10_000 })) {
      engine.update(s);
    }
    const final = engine.update({
      t: 600_100,
      imu: { ax: 0, ay: 0, az: G, gx: 0, gy: 0, gz: 0 },
    });
    expect(final.velocityMps).toBeLessThan(2);
  });

  it('reports collapsing confidence rather than staying certain', () => {
    const states = run(drive({ durationS: 300, outageStartS: 20, outageEndS: 290 }));
    const late = states.filter((s) => s.mode === 'DEAD_RECKONING' && s.t > 250_000);
    expect(late.length).toBeGreaterThan(0);
    for (const s of late) expect(s.confidence).toBeLessThan(0.05);
  });

  it('grows uncertainty monotonically while dead reckoning', () => {
    const states = run(drive({ durationS: 200, outageStartS: 20, outageEndS: 180 })).filter(
      (s) => s.mode === 'DEAD_RECKONING',
    );
    for (let i = 1; i < states.length; i++) {
      expect(states[i]!.covariance.alongM).toBeGreaterThanOrEqual(
        states[i - 1]!.covariance.alongM - 1e-9,
      );
    }
  });
});
