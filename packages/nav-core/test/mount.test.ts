import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CnnSpeedPredictor,
  ML_RAW_CHANNELS,
  ML_WINDOW_SAMPLES,
  SpeedWindowBuffer,
  appendDerivedChannels,
  canonicaliseMountFrame,
  parseSpeedCnnWeights,
} from '../src/index.js';

/**
 * The mount canonicalisation, and the failure it exists to stop.
 *
 * ★ THE MODEL WAS BEING ASKED ABOUT A PHONE IT HAD NEVER SEEN ★
 *
 * Field report, with the satellite badge green: `[ML] 91 km/h` on a handset
 * that was in a hand. `ml/README.md` says the training augmentation covers
 * "any yaw but ±30° of pitch and roll", and says the limit is load-bearing —
 * uniform SO(3) measured worse. A phone held in portrait is 90° of pitch, so
 * every raw window the network saw on that phone came from outside the only
 * distribution it has ever been shown, and a convolutional regressor asked to
 * extrapolate does not decline. It answers.
 *
 * The six derived channels were added to solve exactly this and cannot: they
 * sit BESIDE the six raw ones, which still carry the device frame. Rotating
 * the window first is the missing half.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;
const N = ML_WINDOW_SAMPLES;

type V3 = [number, number, number];

/** Rotation about x, then z — a mount, in degrees. */
function mount(pitchDeg: number, yawDeg: number): (v: V3) => V3 {
  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  return ([x, a, b]) => {
    // R_x(pitch) first: the phone is tipped up out of flat.
    const px = x;
    const py = cp * a - sp * b;
    const pz = sp * a + cp * b;
    // then R_z(yaw): it is turned to face some other bearing.
    return [cy * px - sy * py, sy * px + cy * py, pz];
  };
}

/**
 * A window of plausible in-vehicle IMU: gravity, road vibration, a slow turn.
 *
 * Deterministic — a seeded LCG rather than Math.random — because a test that
 * feeds a network different numbers on every run is a test that will one day
 * fail for a reason nobody can reproduce.
 */
function driveWindow(rotate?: (v: V3) => V3): SpeedWindowBuffer {
  const buf = new SpeedWindowBuffer(N, true);
  let s = 20260907;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
  for (let i = 0; i < N; i++) {
    let a: V3 = [0.4 * Math.sin(i / 7) + rnd() * 0.35, rnd() * 0.35, 9.81 + rnd() * 0.35];
    let w: V3 = [rnd() * 0.02, rnd() * 0.02, 0.06 + rnd() * 0.02];
    if (rotate) {
      a = rotate(a);
      w = rotate(w);
    }
    buf.push(i * 100, a[0], a[1], a[2], w[0], w[1], w[2]);
  }
  return buf;
}

const FLAT_SCALER_MEAN = new Array(12).fill(0);
const FLAT_SCALER_STD = new Array(12).fill(1);

describe('canonicaliseMountFrame', () => {
  it('is a no-op on a window that is already flat', () => {
    // The trained pose, stated exactly: horizontal specific force averaging to
    // zero over the window, so the mean IS gravity and it is already on +z.
    // Nothing here may move, or every published drift figure was measured on a
    // different input than the one that now ships. (Measured the same way on
    // the real thing: over both IO-VNBD replays, as recorded, MAE against
    // Doppler is 3.28 and 4.21 m/s with the rotation and without it.)
    const raw = new Float32Array(ML_RAW_CHANNELS * N);
    for (let t = 0; t < N; t++) {
      const sign = t % 2 === 0 ? 1 : -1;
      raw[t] = sign * 0.3;
      raw[N + t] = sign * 0.2;
      raw[2 * N + t] = 9.81 + sign * 0.4;
      raw[5 * N + t] = 0.05;
    }
    const before = Float32Array.from(raw);
    canonicaliseMountFrame(raw, N);
    for (let i = 0; i < raw.length; i++) {
      expect(raw[i]).toBeCloseTo(before[i]!, 5);
    }
  });

  it('takes out a residual tilt, and only a residual', () => {
    // A cradle is never exactly level, and the correction for two degrees has
    // to BE two degrees — a rotation that overshot would be its own error
    // source, applied to every window for the rest of the drive.
    const raw = new Float32Array(ML_RAW_CHANNELS * N);
    const R = mount(2, 0);
    for (let t = 0; t < N; t++) {
      const [ax, ay, az] = R([0, 0, 9.81]);
      raw[t] = ax;
      raw[N + t] = ay;
      raw[2 * N + t] = az;
    }
    const tiltedY = raw[N]!;
    expect(Math.abs(tiltedY)).toBeGreaterThan(0.3);
    canonicaliseMountFrame(raw, N);
    expect(raw[N]).toBeCloseTo(0, 3);
    expect(raw[2 * N]).toBeCloseTo(9.81, 3);
  });

  it('puts gravity on +z from any mount', () => {
    const mounts: Array<[number, number]> = [
      [90, 37],
      [60, -110],
      [180, 0],
      [-45, 200],
      [12, 5],
    ];
    for (const [pitch, yaw] of mounts) {
      const raw = new Float32Array(ML_RAW_CHANNELS * N);
      const R = mount(pitch, yaw);
      for (let t = 0; t < N; t++) {
        const [ax, ay, az] = R([0, 0, 9.81]);
        raw[t] = ax;
        raw[N + t] = ay;
        raw[2 * N + t] = az;
      }
      canonicaliseMountFrame(raw, N);
      // Down is down, whatever the phone was doing.
      expect(raw[0]).toBeCloseTo(0, 3);
      expect(raw[N]).toBeCloseTo(0, 3);
      expect(raw[2 * N]).toBeCloseTo(9.81, 3);
    }
  });

  it('leaves the derived channels exactly where they were', () => {
    // They are norms and dot products against the same gravity estimate, so
    // they are rotation-invariant by construction. Asserted rather than
    // assumed, because if it were ever false the Python fixtures in
    // derived.test.ts would stop describing what the phone computes.
    const flat = driveWindow();
    const tipped = driveWindow(mount(90, 37));
    const a = flat.buildWindow(FLAT_SCALER_MEAN, FLAT_SCALER_STD)!;
    const b = tipped.buildWindow(FLAT_SCALER_MEAN, FLAT_SCALER_STD)!;
    for (let c = 6; c < 12; c++) {
      for (let t = 0; t < N; t++) {
        expect(b[c * N + t]).toBeCloseTo(a[c * N + t]!, 3);
      }
    }
  });

  it('does not divide by a gravity it does not have', () => {
    // Free fall, or a synthetic vector. The identity is the honest answer: we
    // do not know which way is down, so we do not pretend to have turned the
    // phone. NaN here would poison all twelve channels.
    const raw = new Float32Array(ML_RAW_CHANNELS * N);
    for (let t = 0; t < N; t++) raw[t] = t % 2 === 0 ? 1 : -1;
    canonicaliseMountFrame(raw, N);
    for (const v of raw) expect(Number.isFinite(v)).toBe(true);
  });

  it('keeps the accelerometer and the gyroscope in one frame', () => {
    // They are bolted to the same board. Rotating one without the other would
    // invent a handset whose sensors sit at an angle to each other, and the
    // yaw-rate channel is the turn signal.
    const raw = new Float32Array(ML_RAW_CHANNELS * N);
    const R = mount(90, 0);
    for (let t = 0; t < N; t++) {
      const [ax, ay, az] = R([0, 0, 9.81]);
      const [wx, wy, wz] = R([0, 0, 0.25]);
      raw[t] = ax;
      raw[N + t] = ay;
      raw[2 * N + t] = az;
      raw[3 * N + t] = wx;
      raw[4 * N + t] = wy;
      raw[5 * N + t] = wz;
    }
    canonicaliseMountFrame(raw, N);
    // A yaw rate about the true vertical comes back on gz, where a flat phone
    // would have reported it.
    expect(raw[3 * N]).toBeCloseTo(0, 3);
    expect(raw[4 * N]).toBeCloseTo(0, 3);
    expect(raw[5 * N]).toBeCloseTo(0.25, 3);
  });
});

describe('★ the shipped weights, asked about a phone in a hand', () => {
  const model = JSON.parse(
    readFileSync(`${ROOT}apps/web/public/models/speed_model.json`, 'utf8'),
  ) as { scaler: { mean: number[]; std: number[] } };
  const predictor = new CnnSpeedPredictor(parseSpeedCnnWeights(model));
  const { mean, std } = model.scaler;

  /** What the network says about one window, in m/s. */
  function speedFor(rotate?: (v: V3) => V3): number {
    return predictor.predict(driveWindow(rotate).buildWindow(mean, std)!);
  }

  it('answers the same whatever the mount', () => {
    const flat = speedFor();
    const mounts: Array<[number, number]> = [
      [90, 37],
      [60, -110],
      [180, 0],
      [-72, 15],
    ];
    for (const [pitch, yaw] of mounts) {
      // Same drive, same answer. Yaw about the vertical is left wherever it
      // lands, because that is the one degree of freedom the augmentation
      // covers uniformly — so this is a tolerance, not an equality.
      expect(speedFor(mount(pitch, yaw))).toBeCloseTo(flat, 0);
    }
  });

  it('★ and without it, the same drive reads as a motorway', () => {
    // The regression, stated as a number. Rotating the window WITHOUT
    // canonicalising is what shipped, and it is the screenshot.
    const uncorrected = new SpeedWindowBuffer(N, false);
    const R = mount(180, 0);
    let s = 20260907;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return (s / 2147483648) * 2 - 1;
    };
    for (let i = 0; i < N; i++) {
      const a = R([0.4 * Math.sin(i / 7) + rnd() * 0.35, rnd() * 0.35, 9.81 + rnd() * 0.35]);
      const w = R([rnd() * 0.02, rnd() * 0.02, 0.06 + rnd() * 0.02]);
      uncorrected.push(i * 100, a[0], a[1], a[2], w[0], w[1], w[2]);
    }
    const wrong = predictor.predict(uncorrected.buildWindow(mean, std)!);
    // Well over 20 m/s — 72 km/h — from a window whose canonicalised twin the
    // test above scores at a crawl. Integrated, that is the marker running off
    // down the road and being yanked back by the next fix.
    expect(wrong).toBeGreaterThan(20);
    expect(speedFor(R)).toBeLessThan(5);
  });
});

describe('appendDerivedChannels still matches its own contract', () => {
  it('is unaffected by a rotation of its input', () => {
    const raw = new Float32Array(ML_RAW_CHANNELS * N);
    const rot = new Float32Array(ML_RAW_CHANNELS * N);
    const R = mount(75, 210);
    let s = 7;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return (s / 2147483648) * 2 - 1;
    };
    for (let t = 0; t < N; t++) {
      const a: V3 = [rnd() * 0.4, rnd() * 0.4, 9.81 + rnd() * 0.4];
      const w: V3 = [rnd() * 0.1, rnd() * 0.1, rnd() * 0.1];
      const ra = R(a);
      const rw = R(w);
      raw[t] = a[0];
      raw[N + t] = a[1];
      raw[2 * N + t] = a[2];
      raw[3 * N + t] = w[0];
      raw[4 * N + t] = w[1];
      raw[5 * N + t] = w[2];
      rot[t] = ra[0];
      rot[N + t] = ra[1];
      rot[2 * N + t] = ra[2];
      rot[3 * N + t] = rw[0];
      rot[4 * N + t] = rw[1];
      rot[5 * N + t] = rw[2];
    }
    const a12 = new Float32Array(12 * N);
    const b12 = new Float32Array(12 * N);
    a12.set(raw);
    b12.set(rot);
    appendDerivedChannels(a12, N, a12);
    appendDerivedChannels(b12, N, b12);
    for (let c = 6; c < 12; c++) {
      for (let t = 0; t < N; t++) {
        expect(b12[c * N + t]).toBeCloseTo(a12[c * N + t]!, 3);
      }
    }
  });
});
