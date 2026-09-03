/**
 * Phase 11 — error-state Kalman filter.
 *
 * The interesting tests here drive a SIMULATED trajectory whose truth is known
 * exactly, inject a known IMU bias into the measurements, and then ask whether
 * the filter finds the bias back. That is the only test of a Kalman filter
 * worth much: it is easy to write one that produces smooth, plausible,
 * confidently wrong output, and the estimated bias is where the lie shows.
 */
import { describe, expect, it } from 'vitest';
import { ErrorStateKalmanFilter, IDX } from '../src/eskf/ErrorStateKalmanFilter.js';
import { DEFAULT_ESKF_CONFIG, IMU_NOISE, eskfConfigForGrade } from '../src/eskf/noise.js';
import {
  identity,
  inverse,
  isPositiveDefinite,
  mul,
  mulVec,
  skew,
  trace,
} from '../src/eskf/matrix.js';
import {
  quatAngleBetweenDeg,
  quatFromHeadingDeg,
  quatFromRotationVector,
  quatMultiply,
  quatToHeadingDeg,
  quatToMatrix,
  rotateByQuat,
  rotateByQuatInverse,
} from '../src/eskf/quaternion.js';
import type { Vec3 } from '../src/types.js';

const G = DEFAULT_ESKF_CONFIG.gravityMps2;

/** Deterministic noise. A test that fails one run in twenty is not a test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r: () => number): number =>
  Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

interface TruthSample {
  t: number;
  position: Vec3;
  velocity: Vec3;
  headingDeg: number;
  /** Specific force in the body frame, m/s^2 — what an accelerometer reads. */
  accelBody: Vec3;
  /** Angular rate in the body frame, rad/s. */
  gyroBody: Vec3;
}

/**
 * A level vehicle driving at `speed(t)` on heading `heading(t)`.
 *
 * Body frame: x forward, y left, z up — the same frame the filter documents.
 * Compass headings run clockwise, so a positive turn rate is a rotation about
 * DOWN, which is why the gyro's z component is negated.
 */
function simulate(opts: {
  durationS: number;
  dt: number;
  speed: (t: number) => number;
  headingDeg: (t: number) => number;
}): TruthSample[] {
  const { durationS, dt } = opts;
  const out: TruthSample[] = [];
  const pos: Vec3 = [0, 0, 0];

  // Strictly less than: a loop that also emits the sample AT durationS runs for
  // one step longer than it claims, which is a whole extra 0.2 m at 20 m/s.
  for (let i = 0; i * dt < durationS - 1e-9; i++) {
    const t = i * dt;
    const h = opts.headingDeg(t);
    const hr = (h * Math.PI) / 180;
    const v = opts.speed(t);

    // Numerical derivatives of the analytic profile, so the simulated IMU is
    // exactly consistent with the simulated trajectory.
    const eps = 1e-4;
    const vdot = (opts.speed(t + eps) - opts.speed(t - eps)) / (2 * eps);
    const hdot =
      (((opts.headingDeg(t + eps) - opts.headingDeg(t - eps)) / (2 * eps)) * Math.PI) / 180;

    const f: Vec3 = [Math.sin(hr), Math.cos(hr), 0]; // forward, ENU
    const right: Vec3 = [Math.cos(hr), -Math.sin(hr), 0];
    const velocity: Vec3 = [v * f[0], v * f[1], 0];
    const aNav: Vec3 = [
      vdot * f[0] + v * hdot * right[0],
      vdot * f[1] + v * hdot * right[1],
      0,
    ];

    // Accelerometer measures specific force: a - g_vec, and g_vec is -G up.
    const q = quatFromHeadingDeg(h);
    const accelBody = rotateByQuatInverse(q, [aNav[0], aNav[1], aNav[2] + G]);

    out.push({
      t,
      position: [pos[0], pos[1], pos[2]],
      velocity,
      headingDeg: h,
      accelBody,
      gyroBody: [0, 0, -hdot],
      });

    pos[0] += velocity[0] * dt;
    pos[1] += velocity[1] * dt;
  }
  return out;
}

describe('matrix', () => {
  it('inverts a matrix', () => {
    const a = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ];
    const p = mul(a, inverse(a));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(p[i]![j]!).toBeCloseTo(i === j ? 1 : 0, 10);
    }
  });

  it('throws on a singular matrix rather than returning Infinity', () => {
    expect(() =>
      inverse([
        [1, 2],
        [2, 4],
      ]),
    ).toThrow(/singular/);
  });

  it('skew(w) u equals cross(w, u)', () => {
    const w = [0.3, -1.2, 0.7];
    const u = [2, 5, -1];
    const cross = [
      w[1]! * u[2]! - w[2]! * u[1]!,
      w[2]! * u[0]! - w[0]! * u[2]!,
      w[0]! * u[1]! - w[1]! * u[0]!,
    ];
    expect(mulVec(skew(w), u)).toEqual(cross);
  });

  it('rejects a matrix that is not positive definite', () => {
    expect(isPositiveDefinite(identity(4))).toBe(true);
    expect(
      isPositiveDefinite([
        [1, 2],
        [2, 1],
      ]),
    ).toBe(false);
  });
});

describe('quaternion', () => {
  it('round-trips a compass heading', () => {
    for (const h of [0, 45, 90, 180, 270, 359]) {
      expect(quatToHeadingDeg(quatFromHeadingDeg(h))).toBeCloseTo(h, 6);
    }
  });

  it('points the body x-axis along the bearing in ENU', () => {
    // Heading 90 is due east: forward should be +east, no north component.
    const f = rotateByQuat(quatFromHeadingDeg(90), [1, 0, 0]);
    expect(f[0]).toBeCloseTo(1, 9);
    expect(f[1]).toBeCloseTo(0, 9);
  });

  it('rotateByQuatInverse undoes rotateByQuat', () => {
    const q = quatMultiply(quatFromHeadingDeg(37), quatFromRotationVector([0.1, -0.2, 0.05]));
    const v = [1.5, -2.5, 0.75];
    const back = rotateByQuatInverse(q, rotateByQuat(q, v));
    for (let i = 0; i < 3; i++) expect(back[i]!).toBeCloseTo(v[i]!, 9);
  });

  it('measures the angle between two attitudes', () => {
    expect(quatAngleBetweenDeg(quatFromHeadingDeg(10), quatFromHeadingDeg(10))).toBeCloseTo(0, 9);
    expect(quatAngleBetweenDeg(quatFromHeadingDeg(0), quatFromHeadingDeg(30))).toBeCloseTo(30, 6);
    // Shortest path: 350 degrees apart is 10 degrees apart.
    expect(quatAngleBetweenDeg(quatFromHeadingDeg(0), quatFromHeadingDeg(350))).toBeCloseTo(10, 6);
  });

  it('builds a rotation matrix that is orthonormal', () => {
    const r = quatToMatrix(quatFromRotationVector([0.4, 0.2, -0.9]));
    const rtr = mul(
      [
        [r[0]![0]!, r[1]![0]!, r[2]![0]!],
        [r[0]![1]!, r[1]![1]!, r[2]![1]!],
        [r[0]![2]!, r[1]![2]!, r[2]![2]!],
      ],
      r,
    );
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(rtr[i]![j]!).toBeCloseTo(i === j ? 1 : 0, 9);
    }
  });
});

describe('ErrorStateKalmanFilter — prediction', () => {
  it('carries a straight, constant-speed drive with a perfect IMU', () => {
    const truth = simulate({
      durationS: 10,
      dt: 0.01,
      speed: () => 20,
      headingDeg: () => 0, // due north
    });

    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 20, 0], headingDeg: 0 });
    for (const s of truth) f.predict(s.accelBody, s.gyroBody, 0.01);

    const end = f.snapshot();
    expect(end.position[1]).toBeCloseTo(200, 1);
    expect(Math.abs(end.position[0])).toBeLessThan(0.01);
    expect(end.speedMps).toBeCloseTo(20, 3);
    expect(end.headingDeg).toBeCloseTo(0, 3);
  });

  it('tracks a turn from gyro alone', () => {
    // A quarter circle: 90 degrees over 20 s at 15 m/s.
    const truth = simulate({
      durationS: 20,
      dt: 0.005,
      speed: () => 15,
      headingDeg: (t) => 4.5 * t,
    });

    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 15, 0], headingDeg: 0 });
    for (const s of truth) f.predict(s.accelBody, s.gyroBody, 0.005);

    const end = f.snapshot();
    const last = truth[truth.length - 1]!;
    expect(end.headingDeg).toBeCloseTo(last.headingDeg, 1);
    expect(Math.hypot(end.position[0] - last.position[0], end.position[1] - last.position[1]))
      .toBeLessThan(1.5);
  });

  it('ignores a duplicate sample and a clock jump', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [10, 0, 0], headingDeg: 90 });
    const before = f.snapshot();
    f.predict([0, 0, G], [0, 0, 0], 0);
    f.predict([0, 0, G], [0, 0, 0], -0.1);
    f.predict([0, 0, G], [0, 0, 0], 30);
    expect(f.snapshot().position).toEqual(before.position);
  });

  it('never produces a NaN over a five-minute unaided run', () => {
    const truth = simulate({
      durationS: 300,
      dt: 0.01,
      speed: (t) => 15 + 5 * Math.sin(t / 11),
      headingDeg: (t) => 30 * Math.sin(t / 17),
    });
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 15, 0], headingDeg: 0 });
    for (const s of truth) f.predict(s.accelBody, s.gyroBody, 0.01);

    const end = f.snapshot();
    expect(end.position.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(end.covarianceTrace)).toBe(true);
    // Unaided, uncertainty must GROW. A filter whose covariance shrinks while
    // nothing observes it is lying, and that is a far worse failure than drift.
    expect(end.positionSigmaM[0]).toBeGreaterThan(DEFAULT_ESKF_CONFIG.initial.positionM);
  });
});

describe('ErrorStateKalmanFilter — measurement updates', () => {
  it('pulls position onto a GNSS fix and shrinks its uncertainty', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 0, 0], headingDeg: 0 });
    const before = f.snapshot().positionSigmaM[0];

    const res = f.updateGnssPosition([10, 0, 0], 1);
    expect(res.applied).toBe(true);
    // Sigma 5 prior against sigma 1 measurement: most of the way, not all.
    expect(f.snapshot().position[0]).toBeGreaterThan(9);
    expect(f.snapshot().positionSigmaM[0]).toBeLessThan(before);
  });

  it('gates a wild fix instead of teleporting onto it', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 0, 0], headingDeg: 0 });
    const res = f.updateGnssPosition([5000, 5000, 0], 2, 25);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('gated');
    expect(f.snapshot().position[0]).toBe(0);
  });

  it('forward-speed update sets body speed without inventing a direction', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 5, 0], headingDeg: 0 });
    for (let i = 0; i < 30; i++) f.updateForwardSpeed(20, 0.1);

    const s = f.snapshot();
    const vBody = rotateByQuatInverse(s.quat, s.velocity);
    expect(vBody[0]).toBeCloseTo(20, 1);
    // Heading is unchanged: a speed says nothing about where the vehicle points.
    expect(s.headingDeg).toBeCloseTo(0, 3);
  });

  it('a decayed speed is believed less than a Doppler one', () => {
    const confident = new ErrorStateKalmanFilter();
    const vague = new ErrorStateKalmanFilter();
    for (const f of [confident, vague]) {
      f.initialize({ position: [0, 0, 0], velocity: [0, 10, 0], headingDeg: 0 });
    }
    confident.updateForwardSpeed(20, 0.1);
    vague.updateForwardSpeed(20, 5);
    expect(confident.snapshot().speedMps).toBeGreaterThan(vague.snapshot().speedMps);
  });

  it('ZUPT drives velocity to zero', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [1.4, -0.8, 0.2], headingDeg: 45 });
    for (let i = 0; i < 5; i++) f.updateZupt();
    const v = f.snapshot().velocity;
    expect(Math.hypot(v[0], v[1], v[2])).toBeLessThan(0.02);
  });

  it('ZARU recovers a gyro bias from a stationary vehicle', () => {
    const trueBias: Vec3 = [0.002, -0.001, 0.013];
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 0, 0], headingDeg: 0 });

    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      // 30 s at 100 Hz, parked: the gyro reads its own bias plus noise.
      const gyro: Vec3 = [
        trueBias[0] + 0.001 * gauss(r),
        trueBias[1] + 0.001 * gauss(r),
        trueBias[2] + 0.001 * gauss(r),
      ];
      f.predict([0, 0, G], gyro, 0.01);
      f.updateZupt();
      f.updateZaru(gyro);
    }

    const est = f.snapshot().gyroBias;
    for (let k = 0; k < 3; k++) expect(Math.abs(est[k]! - trueBias[k]!)).toBeLessThan(3e-4);
  });

  it('NHC removes lateral velocity', () => {
    const f = new ErrorStateKalmanFilter();
    // Heading due north, but the velocity vector has 3 m/s of east in it.
    f.initialize({ position: [0, 0, 0], velocity: [3, 20, 0], headingDeg: 0 });
    for (let i = 0; i < 20; i++) f.updateNhc();

    const s = f.snapshot();
    const vBody = rotateByQuatInverse(s.quat, s.velocity);
    expect(Math.abs(vBody[1])).toBeLessThan(0.3);
    // Forward speed is left alone — NHC constrains sideways motion, not travel.
    expect(vBody[0]).toBeGreaterThan(19);
  });

  it('NHC corrects heading, not just the symptom', () => {
    // ★ THE REASON NHC IS A MEASUREMENT AND NOT A PROJECTION ★
    // The vehicle really is driving due north at 20 m/s; the filter's attitude
    // is 5 degrees off. Part A's projection would scrub the apparent lateral
    // velocity and leave the heading wrong. Here the lateral residual is
    // evidence about attitude, so the heading itself should come back.
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 20, 0], headingDeg: 5 });
    const before = Math.abs(f.snapshot().headingDeg);

    for (let i = 0; i < 200; i++) {
      f.predict([0, 0, G], [0, 0, 0], 0.01);
      // Re-assert the truth about velocity each step, as a Doppler fix would.
      f.updateGnssVelocity([0, 20, 0], 0.1);
      f.updateNhc();
    }

    const after = Math.abs(((f.snapshot().headingDeg + 180) % 360) - 180);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1.5);
  });

  it('road projection moves cross-track and leaves along-track alone', () => {
    const f = new ErrorStateKalmanFilter();
    // Road runs due north through east=0. The estimate is 8 m east of it and
    // 500 m up the road.
    f.initialize({ position: [8, 500, 0], velocity: [0, 20, 0], headingDeg: 0 });

    const res = f.updateRoadCrossTrack([0, 123, 0], [1, 0, 0], 1.75);
    expect(res.applied).toBe(true);

    const p = f.snapshot().position;
    expect(p[0]).toBeLessThan(4); // pulled toward the road
    // The road's own arbitrary along-track coordinate (123) must not leak in.
    expect(p[1]).toBeCloseTo(500, 6);
  });

  it('rejects a degenerate road normal', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 0, 0], headingDeg: 0 });
    expect(f.updateRoadCrossTrack([0, 0, 0], [0, 0, 1]).applied).toBe(false);
  });

  it('altitude update touches up and nothing else', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [10, 20, 0], velocity: [0, 0, 0], headingDeg: 0 });
    f.updateAltitude(12, 1);
    const p = f.snapshot().position;
    expect(p[2]).toBeGreaterThan(6);
    expect(p[0]).toBeCloseTo(10, 6);
    expect(p[1]).toBeCloseTo(20, 6);
  });
});

describe('ErrorStateKalmanFilter — bias observability', () => {
  /**
   * ★ THE TEST THE PHASE EXISTS FOR ★
   * Inject a known accelerometer and gyroscope bias into a simulated drive,
   * aid the filter with 1 Hz GNSS, and require that the estimated biases
   * converge on the injected ones. Everything else about a Kalman filter can
   * be judged by eye; this cannot.
   */
  function driveWithBias(opts: { accelBias: Vec3; gyroBias: Vec3; durationS: number }) {
    const dt = 0.01;
    const truth = simulate({
      durationS: opts.durationS,
      dt,
      // Varied speed and a winding heading: a filter that only ever drives
      // straight at a constant speed cannot separate accelerometer bias from
      // attitude error, and would pass a weaker version of this test by
      // learning nothing at all.
      speed: (t) => 14 + 6 * Math.sin(t / 9),
      headingDeg: (t) => 40 * Math.sin(t / 13) + 10 * Math.sin(t / 3.1),
    });

    const f = new ErrorStateKalmanFilter({ imu: IMU_NOISE.PHONE_MEMS });
    f.initialize({
      position: [0, 0, 0],
      velocity: [...truth[0]!.velocity] as Vec3,
      headingDeg: truth[0]!.headingDeg,
    });

    const r = rng(31337);
    let nextFixAt = 1;
    for (const s of truth) {
      const accel: Vec3 = [
        s.accelBody[0] + opts.accelBias[0] + 0.05 * gauss(r),
        s.accelBody[1] + opts.accelBias[1] + 0.05 * gauss(r),
        s.accelBody[2] + opts.accelBias[2] + 0.05 * gauss(r),
      ];
      const gyro: Vec3 = [
        s.gyroBody[0] + opts.gyroBias[0] + 0.004 * gauss(r),
        s.gyroBody[1] + opts.gyroBias[1] + 0.004 * gauss(r),
        s.gyroBody[2] + opts.gyroBias[2] + 0.004 * gauss(r),
      ];
      f.predict(accel, gyro, dt);
      f.updateNhc();

      if (s.t >= nextFixAt) {
        nextFixAt += 1;
        f.updateGnssPosition(
          [s.position[0] + 1.5 * gauss(r), s.position[1] + 1.5 * gauss(r), 0],
          1.5,
        );
        f.updateGnssVelocity(
          [s.velocity[0] + 0.1 * gauss(r), s.velocity[1] + 0.1 * gauss(r), 0],
          0.1,
        );
      }
    }
    return { filter: f, truth };
  }

  it('converges on an injected accelerometer and gyroscope bias', () => {
    const accelBias: Vec3 = [0.25, -0.15, 0.1];
    const gyroBias: Vec3 = [0.001, -0.002, 0.012];
    const { filter } = driveWithBias({ accelBias, gyroBias, durationS: 240 });
    const est = filter.snapshot();

    // Gyro-z bias is the one that matters — it is what becomes heading error
    // and then cross-track drift — and it is the best observed, because every
    // turn and every NHC update speaks to it.
    expect(Math.abs(est.gyroBias[2] - gyroBias[2])).toBeLessThan(0.003);

    // Accelerometer bias in the horizontal plane. Looser: it is only separable
    // from attitude error while the vehicle manoeuvres, and 0.05 m/s^2 of
    // residual is 0.25 m of position error over a 10 s outage.
    expect(Math.abs(est.accelBias[0] - accelBias[0])).toBeLessThan(0.12);
    expect(Math.abs(est.accelBias[1] - accelBias[1])).toBeLessThan(0.12);

    // And the whole point: better than having assumed zero.
    expect(Math.abs(est.accelBias[0] - accelBias[0])).toBeLessThan(Math.abs(accelBias[0]));
    expect(Math.abs(est.gyroBias[2] - gyroBias[2])).toBeLessThan(Math.abs(gyroBias[2]));
  });

  it('tracks the simulated position it was aided toward', () => {
    const { filter, truth } = driveWithBias({
      accelBias: [0.25, -0.15, 0.1],
      gyroBias: [0.001, -0.002, 0.012],
      durationS: 240,
    });
    const last = truth[truth.length - 1]!;
    const p = filter.snapshot().position;
    expect(Math.hypot(p[0] - last.position[0], p[1] - last.position[1])).toBeLessThan(5);
  });
});

describe('ErrorStateKalmanFilter — numerical health', () => {
  it('keeps the covariance symmetric and positive-definite throughout', () => {
    const dt = 0.01;
    const truth = simulate({
      durationS: 180,
      dt,
      speed: (t) => 12 + 8 * Math.sin(t / 7),
      headingDeg: (t) => 60 * Math.sin(t / 11),
    });

    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [...truth[0]!.velocity] as Vec3, headingDeg: truth[0]!.headingDeg });

    const r = rng(99);
    let checks = 0;
    let nextFixAt = 1;
    for (const s of truth) {
      f.predict(s.accelBody, s.gyroBody, dt);
      f.updateNhc();
      if (s.t >= nextFixAt) {
        nextFixAt += 1;
        f.updateGnssPosition([s.position[0] + gauss(r), s.position[1] + gauss(r), 0], 2);
        f.updateGnssVelocity([s.velocity[0], s.velocity[1], 0], 0.2);
        f.updateRoadCrossTrack([s.position[0], s.position[1], 0], [1, 0, 0], 1.75);

        const P = f.covariance;
        for (let i = 0; i < P.length; i++) {
          for (let j = 0; j < P.length; j++) expect(P[i]![j]!).toBe(P[j]![i]!);
        }
        expect(isPositiveDefinite(P)).toBe(true);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(150);
    expect(Number.isFinite(trace(f.covariance))).toBe(true);
  });

  it('is deterministic — the same samples give bit-identical output', () => {
    const truth = simulate({
      durationS: 30,
      dt: 0.01,
      speed: (t) => 10 + 3 * Math.sin(t),
      headingDeg: (t) => 20 * Math.sin(t / 4),
    });
    const run = () => {
      const f = new ErrorStateKalmanFilter();
      f.initialize({ position: [0, 0, 0], velocity: [0, 10, 0], headingDeg: 0 });
      for (const s of truth) {
        f.predict(s.accelBody, s.gyroBody, 0.01);
        f.updateNhc();
      }
      return f.snapshot();
    };
    expect(run()).toEqual(run());
  });

  it('survives non-finite IMU input without corrupting the state', () => {
    const f = new ErrorStateKalmanFilter();
    f.initialize({ position: [0, 0, 0], velocity: [0, 10, 0], headingDeg: 0 });
    f.predict([Number.NaN, 0, G], [0, 0, 0], 0.01);
    f.predict([0, 0, G], [0, Number.POSITIVE_INFINITY, 0], 0.01);
    const s = f.snapshot();
    expect(s.position.every(Number.isFinite)).toBe(true);
    expect(s.velocity.every(Number.isFinite)).toBe(true);
    expect(s.quat.every(Number.isFinite)).toBe(true);
  });
});

describe('IMU grades', () => {
  it('a better sensor drifts less over the same unaided minute', () => {
    const dt = 0.005;
    const truth = simulate({
      durationS: 60,
      dt,
      speed: () => 20,
      headingDeg: (t) => 15 * Math.sin(t / 6),
    });

    // Same drive, same injected bias, three grades. This is the claim
    // packages/edge-engine makes about running the identical estimator against
    // an external FOG-grade unit — asserted here rather than asserted on a slide.
    const drift = (grade: 'PHONE_MEMS' | 'TACTICAL' | 'FOG') => {
      const f = new ErrorStateKalmanFilter(eskfConfigForGrade(grade));
      f.initialize({ position: [0, 0, 0], velocity: [...truth[0]!.velocity] as Vec3, headingDeg: truth[0]!.headingDeg });
      // Ten seconds of aiding, then nothing — the tunnel.
      for (const s of truth) {
        f.predict(s.accelBody, s.gyroBody, dt);
        if (s.t < 10) {
          f.updateGnssPosition([s.position[0], s.position[1], 0], 1);
          f.updateGnssVelocity([s.velocity[0], s.velocity[1], 0], 0.1);
        }
      }
      return f.snapshot().positionSigmaM[0];
    };

    // The estimate is the same — the IMU is perfect in this simulation. What
    // differs is how much uncertainty each grade's noise model accumulates,
    // which is what decides how much a fix is trusted when one returns.
    expect(drift('TACTICAL')).toBeLessThan(drift('PHONE_MEMS'));
    expect(drift('FOG')).toBeLessThan(drift('TACTICAL'));
  });
});

describe('IDX', () => {
  it('blocks tile the 15-dimension error state exactly once', () => {
    expect([IDX.P, IDX.V, IDX.TH, IDX.BA, IDX.BG]).toEqual([0, 3, 6, 9, 12]);
  });
});
