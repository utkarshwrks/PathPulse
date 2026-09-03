/**
 * Phase 12 — automatic in-vehicle alignment.
 *
 * Every test here mounts a simulated phone at a KNOWN yaw offset and asks
 * whether the estimator finds it back. That is the only claim worth testing:
 * an alignment engine that produces a smooth, confident, plausible number
 * which happens to be wrong is indistinguishable from a working one until the
 * vehicle is in a tunnel.
 */
import { describe, expect, it } from 'vitest';
import {
  AutoAlignment,
  DEFAULT_AUTO_ALIGN_CONFIG,
  tiltFromUp,
  type AutoAlignSample,
} from '../src/alignment/autoAlign.js';
import type { Vec3 } from '../src/types.js';

const DEG = Math.PI / 180;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

interface DriveOpts {
  /** True mount yaw offset, radians — what the estimator has to recover. */
  mountYawRad: number;
  durationS: number;
  startS?: number;
  hz?: number;
  /** Vehicle speed profile, m/s. */
  speed?: (t: number) => number;
  yawRate?: (t: number) => number;
  /** Lateral acceleration in the VEHICLE frame — zero for a straight drive. */
  lateral?: (t: number) => number;
  up?: Vec3;
  noise?: number;
  seed?: number;
}

/**
 * Samples as the engine would hand them over: horizontal acceleration in the
 * attitude plane's own reference frame, which is where the mount offset lives.
 *
 * `toHorizontal()` computes forward = alongF cos(t) - alongR sin(t), so the
 * vehicle's forward axis in plane coordinates is (cos t, -sin t) and its
 * lateral axis is (sin t, cos t). Projecting the vehicle-frame acceleration
 * onto those is the forward map this simulation needs.
 */
function drive(opts: DriveOpts): AutoAlignSample[] {
  const {
    mountYawRad,
    durationS,
    startS = 0,
    hz = 50,
    // ★ REAL DRIVING, NOT A GENTLE SINE ★ Peak longitudinal acceleration here
    // is 2 m/s^2, which is ordinary urban accelerate-and-brake. An earlier
    // fixture used a much longer period, giving barely 0.2 (m/s^2)^2 of
    // variance across a whole window — genuinely too little evidence to align
    // against, and the estimator was right to refuse it.
    speed = (t: number) => 15 + 6 * Math.sin(t / 3),
    yawRate = () => 0,
    lateral = () => 0,
    up = [0, 0, 1] as Vec3,
    noise = 0.05,
    seed = 4242,
  } = opts;

  const r = rng(seed);
  const dt = 1 / hz;
  const c = Math.cos(mountYawRad);
  const s = Math.sin(mountYawRad);
  const out: AutoAlignSample[] = [];

  for (let i = 0; i * dt < durationS; i++) {
    const t = startS + i * dt;
    const eps = 1e-3;
    const aFwd = (speed(t + eps) - speed(t - eps)) / (2 * eps);
    const aLat = lateral(t);

    out.push({
      t: t * 1000,
      planeForward: aFwd * c + aLat * s + noise * r(),
      planeRight: -aFwd * s + aLat * c + noise * r(),
      yawRateRadPerSec: yawRate(t),
      speedMps: speed(t),
      up,
    });
  }
  return out;
}

/**
 * Straight stretches separated by corners — the corner is what closes a window.
 *
 * Two stretches by default, because `minObservations` is 2: one window is an
 * estimate, several that agree is an alignment. Any real drive of more than a
 * minute supplies far more than two.
 */
function straightThenCorner(
  opts: DriveOpts & { straightS: number; stretches?: number },
): AutoAlignSample[] {
  const stretches = opts.stretches ?? 2;
  const out: AutoAlignSample[] = [];
  const period = opts.straightS + 3;
  for (let k = 0; k < stretches; k++) {
    const startS = (opts.startS ?? 0) + k * period;
    out.push(
      ...drive({ ...opts, startS, durationS: opts.straightS, seed: (opts.seed ?? 4242) + k }),
      ...drive({
        ...opts,
        startS: startS + opts.straightS,
        durationS: 3,
        yawRate: () => 0.3,
        seed: (opts.seed ?? 4242) + 500 + k,
      }),
    );
  }
  return out;
}

const feed = (a: AutoAlignment, samples: AutoAlignSample[]): void => {
  for (const s of samples) a.push(s);
};

/** Difference between two angles, degrees, shortest way round. */
function angleErrDeg(aRad: number, bRad: number): number {
  let d = (aRad - bRad) / DEG;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

function normalise(v: number[]): Vec3 {
  const m = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / m, v[1]! / m, v[2]! / m];
}

describe('AutoAlignment — recovering a known mount', () => {
  it('finds the offset whatever angle the phone was left at', () => {
    // ★ THE TEST THE PHASE EXISTS FOR ★
    for (const trueYawDeg of [0, 25, -40, 90, -115, 170]) {
      const a = new AutoAlignment();
      feed(a, straightThenCorner({ mountYawRad: trueYawDeg * DEG, straightS: 10, durationS: 10 }));

      const st = a.state;
      expect(st.isCalibrated, `${trueYawDeg} deg`).toBe(true);
      expect(angleErrDeg(st.yawOffsetRad, trueYawDeg * DEG), `${trueYawDeg} deg`).toBeLessThan(5);
      expect(st.quality).toBeGreaterThan(0.5);
    }
  });

  it('resolves forward from backward on a window dominated by braking', () => {
    // ★ WHY PCA ALONE IS NOT ENOUGH ★ The principal axis is a line: forward
    // and reverse sit on it identically. A mean-of-acceleration approach lets
    // one hard brake outvote the accelerations and answers 180 degrees out,
    // which sends the estimate down the road backwards. The sign comes from
    // the derivative of speed instead, and this drive decelerates far more
    // than it accelerates.
    const a = new AutoAlignment();
    feed(
      a,
      straightThenCorner({
        mountYawRad: 60 * DEG,
        straightS: 12,
        durationS: 12,
        speed: (t) => 28 - 9 * Math.sin(t / 5) ** 2 - 0.5 * t,
      }),
    );
    expect(a.state.isCalibrated).toBe(true);
    expect(angleErrDeg(a.state.yawOffsetRad, 60 * DEG)).toBeLessThan(10);
  });

  it('improves rather than jumps as more straight stretches arrive', () => {
    const a = new AutoAlignment();
    const trueYaw = 35 * DEG;
    for (let k = 0; k < 4; k++) {
      feed(
        a,
        straightThenCorner({
          mountYawRad: trueYaw,
          straightS: 8,
          durationS: 8,
          startS: k * 24,
          stretches: 2,
          seed: 100 + k * 7,
        }),
      );
    }
    expect(a.state.observations).toBeGreaterThanOrEqual(3);
    expect(angleErrDeg(a.state.yawOffsetRad, trueYaw)).toBeLessThan(5);
  });
});

describe('AutoAlignment — refusing to answer', () => {
  const attempt = (opts: Partial<DriveOpts> & { straightS: number }): AutoAlignment => {
    const a = new AutoAlignment();
    feed(a, straightThenCorner({ mountYawRad: 30 * DEG, durationS: 10, ...opts }));
    return a;
  };

  it('says nothing while the vehicle is cruising at a constant speed', () => {
    // A perfectly straight motorway on cruise control is a beautiful straight
    // stretch with no longitudinal variation to align against. Answering
    // anyway means aligning to the accelerometer's noise.
    const a = attempt({ straightS: 15, durationS: 15, speed: () => 25, noise: 0.02 });
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.quality).toBe(0);
  });

  it('says nothing while the vehicle is turning', () => {
    const a = attempt({ straightS: 15, durationS: 15, yawRate: () => 0.4 });
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.status).toBe('WAITING');
  });

  it('says nothing below the speed floor', () => {
    // Crawling in traffic: the accelerations are small next to the sensor's
    // own noise and the cloud PCA sees is round rather than cigar-shaped.
    const a = attempt({ straightS: 15, durationS: 15, speed: (t) => 1.5 + Math.sin(t) * 0.5 });
    expect(a.state.isCalibrated).toBe(false);
  });

  it('says nothing when the stretch is too short to be a stretch', () => {
    const a = attempt({ straightS: 2, durationS: 2 });
    expect(a.state.isCalibrated).toBe(false);
  });

  it('ignores non-finite input rather than poisoning the estimate', () => {
    const a = new AutoAlignment();
    const samples = straightThenCorner({ mountYawRad: 45 * DEG, straightS: 10, durationS: 10 });
    for (const s of samples) {
      a.push({ ...s, planeForward: Number.NaN });
      a.push(s);
    }
    expect(a.state.isCalibrated).toBe(true);
    expect(Number.isFinite(a.state.yawOffsetRad)).toBe(true);
  });
});

describe('AutoAlignment — the mount is part of the measurement', () => {
  const alignedFirst = (): AutoAlignment => {
    const a = new AutoAlignment();
    feed(a, straightThenCorner({ mountYawRad: 40 * DEG, straightS: 10, durationS: 10 }));
    expect(a.state.isCalibrated).toBe(true);
    return a;
  };

  const TILTED: Vec3 = [Math.sin(30 * DEG), 0, Math.cos(30 * DEG)];

  it('throws the alignment away when the phone has been moved and stays moved', () => {
    const a = alignedFirst();
    // Knocked over: gravity now points somewhere else in the device frame, and
    // stays there. 30 degrees is well past the 15 degree threshold.
    feed(
      a,
      drive({ mountYawRad: 40 * DEG, durationS: 5, startS: 20, up: TILTED, yawRate: () => 0.4 }),
    );

    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.status).toBe('REALIGNING');
    expect(a.state.quality).toBe(0);
  });

  it('keeps the alignment through a single bump', () => {
    // ★ A POTHOLE IS NOT A RE-MOUNT ★ Dropping the alignment on every jolt
    // would leave the system uncalibrated on any real road. Only a change that
    // persists counts.
    const a = alignedFirst();
    feed(a, drive({ mountYawRad: 40 * DEG, durationS: 0.3, startS: 20, up: TILTED }));
    feed(a, drive({ mountYawRad: 40 * DEG, durationS: 3, startS: 21 }));
    expect(a.state.isCalibrated).toBe(true);
  });

  it('re-aligns after being moved, to the new offset', () => {
    const a = alignedFirst();
    feed(a, drive({ mountYawRad: 40 * DEG, durationS: 5, startS: 20, up: TILTED, yawRate: () => 0.4 }));
    expect(a.state.isCalibrated).toBe(false);

    // Re-seated at a different angle. The old answer must not survive.
    feed(
      a,
      straightThenCorner({
        mountYawRad: -70 * DEG,
        straightS: 10,
        durationS: 10,
        startS: 30,
        up: TILTED,
      }),
    );
    expect(a.state.isCalibrated).toBe(true);
    expect(angleErrDeg(a.state.yawOffsetRad, -70 * DEG)).toBeLessThan(6);
  });

  it('tells a dash mount from a phone rolling around loose', () => {
    const fixed = new AutoAlignment();
    feed(fixed, drive({ mountYawRad: 0, durationS: 20 }));
    expect(fixed.state.mount).toBe('FIXED');

    const loose = new AutoAlignment();
    const r = rng(9);
    for (const s of drive({ mountYawRad: 0, durationS: 20 })) {
      // Gravity wandering by several degrees a sample: a phone in a cup holder.
      loose.push({ ...s, up: normalise([0.15 * r(), 0.15 * r(), 1]) });
    }
    expect(loose.state.mount).toBe('LOOSE');
  });

  it('forgets everything on a manual re-calibrate', () => {
    const a = alignedFirst();
    a.recalibrate();
    expect(a.state.isCalibrated).toBe(false);
    expect(a.state.status).toBe('REALIGNING');
    expect(a.state.observations).toBe(0);

    // And the next good window is adopted outright rather than blended into
    // an average the driver just told us to throw away.
    feed(a, straightThenCorner({ mountYawRad: -20 * DEG, straightS: 10, durationS: 10, startS: 30 }));
    expect(angleErrDeg(a.state.yawOffsetRad, -20 * DEG)).toBeLessThan(6);
  });
});

describe('tiltFromUp', () => {
  it('reads zero for a phone lying flat and face up', () => {
    const { pitchDeg, rollDeg } = tiltFromUp([0, 0, 1]);
    expect(pitchDeg).toBeCloseTo(0, 9);
    expect(rollDeg).toBeCloseTo(0, 9);
  });

  it('reads -90 pitch for a phone standing upright in a cradle', () => {
    expect(tiltFromUp([0, 1, 0]).pitchDeg).toBeCloseTo(-90, 6);
  });

  it('reads roll for a phone tipped onto its side', () => {
    expect(tiltFromUp([Math.sin(30 * DEG), 0, Math.cos(30 * DEG)]).rollDeg).toBeCloseTo(30, 6);
  });

  it('survives a zero vector instead of returning NaN', () => {
    const t = tiltFromUp([0, 0, 0]);
    expect(Number.isFinite(t.pitchDeg)).toBe(true);
    expect(Number.isFinite(t.rollDeg)).toBe(true);
  });
});

describe('AutoAlignment — config', () => {
  it('exposes the thresholds rather than burying them', () => {
    expect(DEFAULT_AUTO_ALIGN_CONFIG.minSpeedMps).toBe(5);
    expect(DEFAULT_AUTO_ALIGN_CONFIG.minStraightMs).toBe(5000);
  });
});
