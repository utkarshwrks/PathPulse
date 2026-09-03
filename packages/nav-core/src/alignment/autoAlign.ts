/**
 * Phase 12 — automatic phone-to-vehicle alignment.
 *
 * ★ WHAT IS ACTUALLY MISSING, AND WHAT IS NOT ★
 *
 * Half of alignment is already solved and has been since Phase 4.
 * `AttitudeEstimator` tracks the measured gravity direction, so pitch and roll
 * come free and continuously — the phone can be flat on a dash, upright in a
 * cradle or face-down in a cup holder and the horizontal plane is still
 * correct. That is the hard half, and it is not this file's job.
 *
 * What is missing is the last degree of freedom: WHICH WAY IN THAT PLANE THE
 * BONNET POINTS. Gravity cannot tell you — every yaw about the vertical looks
 * identical to an accelerometer at rest. Until now that came from
 * `SimpleAlignment`, which needed somebody to press a button and drive
 * straight, and which nothing in the app ever called. So the shipped default
 * was "the phone's +Y axis points along the bonnet", i.e. a guess.
 *
 * The problem statement's first expected-solution bullet asks for this to be
 * automatic, and it is right to: a 20 degree mount error turns a fifth of
 * every braking event into phantom sideways motion, and the driver who props
 * the phone at an angle has no idea they have done anything wrong.
 *
 * ★ HOW ★
 * While the vehicle is driving straight, all of its acceleration is
 * longitudinal — accelerating and braking are the same axis, opposite signs.
 * So the horizontal acceleration samples from a straight stretch form a
 * cigar-shaped cloud whose long axis IS the vehicle's forward axis. Principal
 * component analysis finds that axis in closed form from a 2x2 covariance.
 *
 * PCA returns an axis, not a direction — forward and backward are the same
 * line. That last bit is resolved against the derivative of speed: when the
 * vehicle is speeding up, the acceleration points forward. Nothing else in the
 * signal can tell you, which is why a mean-of-acceleration approach (what
 * SimpleAlignment did) is not merely less accurate but actively fragile — one
 * hard brake outweighs ten gentle accelerations and flips the answer 180
 * degrees, sending the estimate down the road in reverse.
 *
 * ★ AND THEN IT HAS TO KEEP BEING TRUE ★
 * A phone in a holder gets knocked. A phone in a cup holder rotates every time
 * the car corners. So this watches the gravity direction it aligned against
 * and, when that has moved and stayed moved, throws the alignment away and
 * says so — dropping confidence rather than continuing to report a number it
 * no longer believes. Silently wrong is the one outcome that is not allowed.
 */
import type { Vec3 } from '../types.js';

/** How the phone appears to be held, inferred from how still gravity is. */
export type MountMode = 'UNKNOWN' | 'FIXED' | 'LOOSE';

export type AlignStatus =
  /** Nothing usable yet — parked, crawling, or turning. */
  | 'WAITING'
  /** A straight stretch is in progress and samples are accumulating. */
  | 'COLLECTING'
  /** An alignment is held and trusted. */
  | 'ALIGNED'
  /** The mount moved. The old answer has been discarded. */
  | 'REALIGNING';

export interface AutoAlignState {
  /** Rotation from the attitude plane's reference axis to vehicle forward. */
  yawOffsetRad: number;
  isCalibrated: boolean;
  /** 0..1. Feeds the engine's confidence — never just the UI. */
  quality: number;
  status: AlignStatus;
  mount: MountMode;
  /** Device tilt from the measured gravity direction, degrees. */
  pitchDeg: number;
  rollDeg: number;
  /** Straight-line stretches successfully used so far. */
  observations: number;
  lastAlignedAtMs: number | null;
}

export interface AutoAlignConfig {
  /**
   * Below this yaw rate the vehicle counts as going straight, rad/s.
   * 0.05 rad/s is just under 3 deg/s — a motorway lane change is faster.
   */
  straightYawRateRadPerSec: number;
  /** Straight for at least this long before the window is worth using, ms. */
  minStraightMs: number;
  /** Cap on how long one window may run before being evaluated, ms. */
  maxWindowMs: number;
  /**
   * Below this speed the alignment is not attempted, m/s.
   *
   * Not arbitrary: at low speed the accelerations are small next to the
   * accelerometer's own noise, so the cloud PCA sees is round rather than
   * cigar-shaped and the "long axis" is whichever way the noise happened to
   * fall. 5 m/s is 18 km/h.
   */
  minSpeedMps: number;
  /**
   * The window must contain at least this much longitudinal variation,
   * (m/s^2)^2. Cruise control on a straight motorway produces a beautifully
   * straight stretch with nothing to align against.
   */
  minVarianceMps2Sq: number;
  /** Samples needed before a window is evaluated. */
  minSamples: number;
  /** Ring-buffer ceiling, so a long straight cannot grow memory without bound. */
  maxSamples: number;
  /**
   * Eigenvalue ratio below which the cloud is too round to trust, 0.5..1.
   * 0.5 is perfectly circular (no information at all); 1 is a perfect line.
   */
  minAxisRatio: number;
  /**
   * Longitudinal energy at which a window counts as fully convincing,
   * (m/s^2)^2. Below it the window still counts, but for less.
   *
   * The axis ratio alone is not enough evidence. A window with barely any
   * acceleration in it can still be strongly one-dimensional — a highway
   * cruise where the only signal is a slight, consistently-directed
   * accelerometer noise floor produces a beautiful cigar pointing nowhere in
   * particular. On the ablation's highway log exactly that put one window at
   * -31.5 degrees when the true mount is zero.
   */
  strongVarianceMps2Sq: number;
  /**
   * Reject a window disagreeing with a settled alignment by more than this,
   * degrees.
   *
   * ★ THIS IS NOT "IGNORE INCONVENIENT DATA" ★ A mount that genuinely moved is
   * detected by the gravity monitor, which throws the whole alignment away and
   * lets the next window in unopposed. So a window that disagrees violently
   * while gravity has NOT moved is not evidence of a new mount — the phone
   * demonstrably has not moved — it is evidence of a bad window.
   */
  maxDisagreementDeg: number;
  /** Windows that must agree before the alignment is used at all. */
  minObservations: number;
  /** Sustained gravity-direction change that invalidates an alignment, degrees. */
  mountMovedDeg: number;
  /** How long that change must persist before it counts as a move, ms. */
  mountMovedHoldMs: number;
  /**
   * Gravity-direction wander above which the mount is called LOOSE, degrees.
   * Purely descriptive — it changes what the UI says, not what the maths does.
   */
  looseMountDeg: number;
  /**
   * How much a new observation moves the held alignment, 0..1.
   *
   * Low, deliberately. Each window is one noisy estimate of a quantity that is
   * genuinely constant while the mount has not moved, so averaging many of
   * them is exactly right — and a mount that HAS moved is handled by throwing
   * the alignment away, not by chasing it.
   */
  blend: number;
}

export const DEFAULT_AUTO_ALIGN_CONFIG: AutoAlignConfig = {
  straightYawRateRadPerSec: 0.05,
  minStraightMs: 5000,
  maxWindowMs: 20_000,
  minSpeedMps: 5,
  minVarianceMps2Sq: 0.02,
  minSamples: 40,
  maxSamples: 1500,
  minAxisRatio: 0.75,
  strongVarianceMps2Sq: 0.5,
  maxDisagreementDeg: 35,
  minObservations: 2,
  mountMovedDeg: 15,
  mountMovedHoldMs: 2000,
  looseMountDeg: 6,
  blend: 0.2,
};

/** One conditioned sample, in the attitude plane's own reference frame. */
export interface AutoAlignSample {
  t: number;
  /** Horizontal acceleration along the plane's reference axis, m/s^2. */
  planeForward: number;
  /** Horizontal acceleration along the plane's right axis, m/s^2. */
  planeRight: number;
  /** Yaw rate about the true vertical, rad/s. Straightness comes from this. */
  yawRateRadPerSec: number;
  /** Best available speed, m/s. */
  speedMps: number;
  /** Measured gravity direction in the device frame, unit length. */
  up: Vec3;
}

interface Stretch {
  f: number[];
  r: number[];
  speed: number[];
  t: number[];
  startedAtMs: number;
}

export class AutoAlignment {
  private config: AutoAlignConfig;

  private yawOffsetRad = 0;
  private calibrated = false;
  private qualityValue = 0;
  private observationCount = 0;
  private lastAlignedAtMs: number | null = null;
  private status: AlignStatus = 'WAITING';

  private stretch: Stretch | null = null;
  /** Gravity direction at the moment of the last accepted alignment. */
  private alignedUp: Vec3 | null = null;
  private mountMovedSinceMs: number | null = null;
  private lastUp: Vec3 = [0, 0, 1];
  /** Slow average of frame-to-frame gravity wander, degrees. Drives MountMode. */
  private upWanderDeg = 0;
  private seenSamples = 0;
  /** Set by recalibrate(); forces the next good window to be adopted outright. */
  private forceAdopt = false;

  constructor(config: Partial<AutoAlignConfig> = {}) {
    this.config = { ...DEFAULT_AUTO_ALIGN_CONFIG, ...config };
  }

  setConfig(patch: Partial<AutoAlignConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /**
   * ★ CALIBRATED MEANS USABLE, NOT MERELY COMPUTED ★
   * One window is an estimate; several windows that agree is an alignment.
   * Applying a single noisy answer is strictly worse than applying nothing,
   * because "nothing" is at least a known quantity — and on a perfectly
   * mounted phone, which is what every recorded log has, it is also correct.
   */
  private get usable(): boolean {
    return (
      this.calibrated &&
      this.observationCount >= this.config.minObservations &&
      this.qualityValue >= 0.5
    );
  }

  get state(): AutoAlignState {
    const { pitchDeg, rollDeg } = tiltFromUp(this.lastUp);
    return {
      yawOffsetRad: this.yawOffsetRad,
      isCalibrated: this.usable,
      quality: this.qualityValue,
      status: this.status,
      mount: this.mountMode(),
      pitchDeg,
      rollDeg,
      observations: this.observationCount,
      lastAlignedAtMs: this.lastAlignedAtMs,
    };
  }

  private mountMode(): MountMode {
    if (this.seenSamples < 100) return 'UNKNOWN';
    return this.upWanderDeg > this.config.looseMountDeg ? 'LOOSE' : 'FIXED';
  }

  /**
   * Throw the current alignment away and start again.
   *
   * Wired to the UI's "Re-calibrate" button. Exists because automatic is not
   * the same as infallible: if the driver can see the alignment is wrong, they
   * should not have to argue with the software about it.
   */
  recalibrate(): void {
    this.calibrated = false;
    this.qualityValue = 0;
    this.observationCount = 0;
    this.alignedUp = null;
    this.stretch = null;
    this.mountMovedSinceMs = null;
    this.status = 'REALIGNING';
    this.forceAdopt = true;
  }

  push(s: AutoAlignSample): void {
    if (
      !Number.isFinite(s.planeForward) ||
      !Number.isFinite(s.planeRight) ||
      !Number.isFinite(s.yawRateRadPerSec) ||
      !Number.isFinite(s.speedMps)
    ) {
      return;
    }

    this.trackMount(s);

    const straight = Math.abs(s.yawRateRadPerSec) <= this.config.straightYawRateRadPerSec;
    const fast = s.speedMps >= this.config.minSpeedMps;

    if (!straight || !fast) {
      // A window is only meaningful if the whole of it was straight. Ending it
      // here rather than tolerating a corner is the difference between
      // measuring the vehicle's axis and measuring the corner's.
      if (this.stretch) this.evaluate(this.stretch, s.t);
      this.stretch = null;
      if (this.status === 'COLLECTING') {
        this.status = this.calibrated ? 'ALIGNED' : 'WAITING';
      }
      return;
    }

    if (!this.stretch) {
      this.stretch = { f: [], r: [], speed: [], t: [], startedAtMs: s.t };
      if (!this.calibrated) this.status = 'COLLECTING';
    }

    const w = this.stretch;
    w.f.push(s.planeForward);
    w.r.push(s.planeRight);
    w.speed.push(s.speedMps);
    w.t.push(s.t);

    if (w.f.length > this.config.maxSamples) {
      w.f.shift();
      w.r.shift();
      w.speed.shift();
      w.t.shift();
      w.startedAtMs = w.t[0]!;
    }

    if (s.t - w.startedAtMs >= this.config.maxWindowMs) {
      this.evaluate(w, s.t);
      this.stretch = null;
    }
  }

  /**
   * Watch the direction the alignment was made against.
   *
   * ★ THE MOUNT IS PART OF THE MEASUREMENT ★ A yaw offset is a statement about
   * a rigid relationship between two objects. Knock the phone and the
   * statement is false, and no amount of filtering downstream will notice —
   * the numbers stay smooth and plausible and point the wrong way. Gravity is
   * the only witness we have to the mount moving, so it gets watched.
   */
  private trackMount(s: AutoAlignSample): void {
    const up = normalise(s.up);
    if (!up) return;

    if (this.seenSamples > 0) {
      const step = angleBetweenDeg(this.lastUp, up);
      // Instantaneous wander is dominated by road vibration; the slow average
      // is what distinguishes a dash mount from a phone rolling in a cup holder.
      this.upWanderDeg = this.upWanderDeg * 0.995 + Math.min(30, step * 100) * 0.005;
    }
    this.lastUp = up;
    this.seenSamples++;

    if (!this.calibrated || !this.alignedUp) return;

    const moved = angleBetweenDeg(this.alignedUp, up);
    if (moved > this.config.mountMovedDeg) {
      if (this.mountMovedSinceMs === null) this.mountMovedSinceMs = s.t;
      else if (s.t - this.mountMovedSinceMs >= this.config.mountMovedHoldMs) {
        // ★ DROP IT, DO NOT DRIFT IT ★ A stale alignment is worse than none:
        // none is visible on the confidence bar, stale is invisible.
        this.calibrated = false;
        this.qualityValue = 0;
        this.observationCount = 0;
        this.alignedUp = null;
        this.mountMovedSinceMs = null;
        this.stretch = null;
        this.status = 'REALIGNING';
      }
    } else {
      // A single hard bump is not a move. Only a sustained change counts.
      this.mountMovedSinceMs = null;
    }
  }

  /** Run PCA over one completed straight-line window and maybe adopt it. */
  private evaluate(w: Stretch, nowMs: number): void {
    const n = w.f.length;
    if (n < this.config.minSamples) return;
    if ((w.t[n - 1]! - w.startedAtMs) < this.config.minStraightMs) return;

    let mf = 0;
    let mr = 0;
    for (let i = 0; i < n; i++) {
      mf += w.f[i]!;
      mr += w.r[i]!;
    }
    mf /= n;
    mr /= n;

    // 2x2 covariance of the horizontal acceleration cloud.
    let cff = 0;
    let crr = 0;
    let cfr = 0;
    for (let i = 0; i < n; i++) {
      const df = w.f[i]! - mf;
      const dr = w.r[i]! - mr;
      cff += df * df;
      crr += dr * dr;
      cfr += df * dr;
    }
    cff /= n - 1;
    crr /= n - 1;
    cfr /= n - 1;

    if (cff + crr < this.config.minVarianceMps2Sq) return; // cruise, nothing to see

    // Closed-form eigen-decomposition of a symmetric 2x2. No iteration, which
    // matters: this runs inside the 10 Hz loop on a phone.
    const tr = cff + crr;
    const det = cff * crr - cfr * cfr;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (!(l1 > 0)) return;

    const ratio = l1 / (l1 + Math.max(0, l2));
    if (ratio < this.config.minAxisRatio) return; // the cloud is too round

    // Eigenvector for l1. Both forms are used because one degenerates when the
    // cloud happens to lie along a reference axis and the off-diagonal vanishes.
    let vf: number;
    let vr: number;
    if (Math.abs(cfr) > 1e-9) {
      vf = l1 - crr;
      vr = cfr;
    } else {
      vf = cff >= crr ? 1 : 0;
      vr = cff >= crr ? 0 : 1;
    }
    const vMag = Math.hypot(vf, vr);
    if (!(vMag > 1e-9)) return;
    vf /= vMag;
    vr /= vMag;

    // ★ PCA GIVES A LINE; THE VEHICLE TRAVELS ALONG IT IN ONE DIRECTION ★
    // Resolve it against what the speed actually did: while speeding up, the
    // acceleration points forward. Without this the answer is 180 degrees
    // wrong about half the time and the estimate drives the road in reverse.
    let agreement = 0;
    for (let i = 1; i < n; i++) {
      const dtS = (w.t[i]! - w.t[i - 1]!) / 1000;
      if (!(dtS > 0) || dtS > 1) continue;
      const dv = (w.speed[i]! - w.speed[i - 1]!) / dtS;
      const along = (w.f[i]! - mf) * vf + (w.r[i]! - mr) * vr;
      agreement += along * dv;
    }
    if (agreement < 0) {
      vf = -vf;
      vr = -vr;
    } else if (agreement === 0) {
      // No speed variation at all in a window that nonetheless had
      // acceleration variance — nothing here can resolve the sign, so refuse
      // rather than guess. A coin flip here reverses the vehicle.
      return;
    }

    // toHorizontal() computes `forward = alongF cos(theta) - alongR sin(theta)`,
    // so the vehicle's forward axis in plane coordinates is (cos, -sin).
    const theta = Math.atan2(-vr, vf);

    // Confidence in THIS window: how cigar-shaped the cloud was, AND how much
    // acceleration there was to be shaped in the first place. Both matter, and
    // an early version that used only the first was fooled by a highway cruise
    // whose entire signal was a directional noise floor.
    const shape = clamp01((ratio - this.config.minAxisRatio) / (1 - this.config.minAxisRatio));
    const evidence = clamp01(l1 / this.config.strongVarianceMps2Sq);
    const windowQuality = shape * evidence;

    // A settled alignment plus a wildly disagreeing window, with gravity
    // unmoved, means the window is wrong — the phone provably has not been
    // touched. See `maxDisagreementDeg`.
    if (this.usable && !this.forceAdopt) {
      const disagreementDeg = Math.abs(angleDiff(theta, this.yawOffsetRad)) * (180 / Math.PI);
      if (disagreementDeg > this.config.maxDisagreementDeg) return;
    }

    if (!this.calibrated || this.forceAdopt) {
      this.yawOffsetRad = theta;
      this.qualityValue = windowQuality;
      this.forceAdopt = false;
    } else {
      // Circular blend, so 179 degrees and -179 degrees average to 180 rather
      // than to zero.
      this.yawOffsetRad = blendAngles(this.yawOffsetRad, theta, this.config.blend * windowQuality);
      // ★ QUALITY ACCUMULATES; IT DOES NOT TRACK THE LAST WINDOW ★
      // An earlier version blended toward each window's own quality, so a
      // stretch of motorway cruise — weak evidence, but not contradicting
      // anything — pulled confidence DOWN in an alignment that six previous
      // windows had agreed on. Confidence in a constant quantity should only
      // grow with evidence about it. Contradiction is handled by the
      // disagreement gate above and by the gravity monitor, both of which
      // discard the alignment outright rather than nudging it.
      this.qualityValue = clamp01(this.qualityValue + (1 - this.qualityValue) * windowQuality);
    }

    this.calibrated = true;
    this.observationCount++;
    this.lastAlignedAtMs = nowMs;
    this.alignedUp = [...this.lastUp];
    this.status = 'ALIGNED';
  }

  reset(): void {
    this.yawOffsetRad = 0;
    this.calibrated = false;
    this.qualityValue = 0;
    this.observationCount = 0;
    this.lastAlignedAtMs = null;
    this.status = 'WAITING';
    this.stretch = null;
    this.alignedUp = null;
    this.mountMovedSinceMs = null;
    this.lastUp = [0, 0, 1];
    this.upWanderDeg = 0;
    this.seenSamples = 0;
    this.forceAdopt = false;
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function normalise(v: Vec3): Vec3 | null {
  const m = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(m) || m < 1e-6) return null;
  return [v[0] / m, v[1] / m, v[2] / m];
}

function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Signed shortest difference between two angles, radians. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Shortest-path interpolation between two angles, radians. */
function blendAngles(from: number, to: number, t: number): number {
  return from + angleDiff(to, from) * clamp01(t);
}

/**
 * Device pitch and roll from the measured gravity direction.
 *
 * `up` is the unit specific-force direction at rest, so a phone lying flat and
 * face up reads (0, 0, 1) and gives zero for both. A phone standing upright in
 * a cradle reads (0, 1, 0) and gives -90 degrees of pitch. Reported for the
 * UI and for the alignment readout; nothing in the estimator consumes them,
 * because the estimator uses the up vector itself and has no need to take it
 * apart into angles first.
 */
export function tiltFromUp(up: Vec3): { pitchDeg: number; rollDeg: number } {
  const u = normalise(up) ?? [0, 0, 1];
  const rollRad = Math.atan2(u[0], u[2]);
  const pitchRad = Math.atan2(-u[1], Math.hypot(u[0], u[2]));
  return { pitchDeg: (pitchRad * 180) / Math.PI, rollDeg: (rollRad * 180) / Math.PI };
}
