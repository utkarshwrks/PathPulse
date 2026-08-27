import type { Vec3 } from '../types.js';
import { GRAVITY_MPS2 } from '../alignment/gravity.js';

export interface ZuptConfig {
  /** Samples averaged before an accelerometer bias estimate is accepted. */
  sampleCount: number;
  /** EMA weight for each accepted estimate. */
  alpha: number;
  /** Largest believable accelerometer bias, m/s^2. */
  maxBiasMps2: number;
}

export const DEFAULT_ZUPT_CONFIG: ZuptConfig = {
  sampleCount: 50,
  alpha: 0.1,
  maxBiasMps2: 0.5,
};

export interface ZuptResult {
  /** True while the vehicle is held at zero velocity. */
  applied: boolean;
  /** True on the sample where a bias estimate was accepted. */
  biasUpdated: boolean;
}

/**
 * ZUPT — Zero Velocity Update.
 *
 * When the vehicle is stationary its velocity is exactly zero. Not "small" —
 * zero, known with certainty, for free. Every red light resets the error
 * budget, which is why ZUPT is worth more in city driving than any amount of
 * filter tuning.
 *
 * ★ THIS IS THE FIX FOR THE PHANTOM MOTION ★
 *
 * Before this existed, DeadReckoningEngine.propagate() fell back to
 * `speed = speed + accel * dt` whenever GNSS was absent. With accel near zero
 * that expression holds the last speed forever. In our field test the app sat
 * at a confident 25.8 km/h for 197 seconds while the phone was standing
 * still, inventing 4 km of travel and dragging the marker across open ground.
 * `applyZeroVelocity()` existed the whole time and nothing ever called it.
 *
 * Standing still also gives us the accelerometer's bias: the only specific
 * force acting on a stationary phone is gravity, so whatever is left after
 * subtracting a 9.81 m/s^2 vector along the measured vertical is bias. That
 * matters because bias double-integrates — 0.02 m/s^2 becomes ~36 m of
 * position error after one minute, and unlike white noise it never averages
 * out.
 */
export class ZuptProcessor {
  private readonly config: ZuptConfig;
  private readonly samples: Vec3[] = [];
  private bias: Vec3 = [0, 0, 0];
  private initialised = false;
  private triggers = 0;
  private wasStationary = false;

  constructor(config: Partial<ZuptConfig> = {}) {
    this.config = { ...DEFAULT_ZUPT_CONFIG, ...config };
  }

  get accelBias(): Readonly<Vec3> {
    return this.bias;
  }

  get triggerCount(): number {
    return this.triggers;
  }

  get hasEstimate(): boolean {
    return this.initialised;
  }

  /**
   * @param ax,ay,az raw specific force, device frame, gravity included
   * @param up       unit vector pointing up in the device frame, from AttitudeEstimator
   */
  push(
    ax: number,
    ay: number,
    az: number,
    up: Readonly<Vec3>,
    isStationary: boolean,
  ): ZuptResult {
    if (!isStationary) {
      this.samples.length = 0;
      this.wasStationary = false;
      return { applied: false, biasUpdated: false };
    }

    // Count one trigger per stop, not one per sample — otherwise the HUD
    // reports thousands of ZUPTs for a single red light.
    if (!this.wasStationary) {
      this.triggers++;
      this.wasStationary = true;
    }

    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
      return { applied: true, biasUpdated: false };
    }

    // Residual after removing gravity along the measured vertical.
    const residual: Vec3 = [
      ax - GRAVITY_MPS2 * up[0],
      ay - GRAVITY_MPS2 * up[1],
      az - GRAVITY_MPS2 * up[2],
    ];
    this.samples.push(residual);
    if (this.samples.length < this.config.sampleCount) {
      return { applied: true, biasUpdated: false };
    }

    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const [x, y, z] of this.samples) {
      sx += x;
      sy += y;
      sz += z;
    }
    const n = this.samples.length;
    const candidate: Vec3 = [sx / n, sy / n, sz / n];
    this.samples.length = 0;

    const mag = Math.hypot(candidate[0], candidate[1], candidate[2]);
    if (!Number.isFinite(mag) || mag > this.config.maxBiasMps2) {
      return { applied: true, biasUpdated: false };
    }

    if (!this.initialised) {
      this.bias = candidate;
      this.initialised = true;
    } else {
      const a = this.config.alpha;
      this.bias = [
        this.bias[0] * (1 - a) + candidate[0] * a,
        this.bias[1] * (1 - a) + candidate[1] * a,
        this.bias[2] * (1 - a) + candidate[2] * a,
      ];
    }
    return { applied: true, biasUpdated: true };
  }

  reset(): void {
    this.samples.length = 0;
    this.bias = [0, 0, 0];
    this.initialised = false;
    this.triggers = 0;
    this.wasStationary = false;
  }
}
