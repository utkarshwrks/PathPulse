/**
 * Phase 18B — telling a motorcycle from a car, from the IMU alone.
 *
 * ★ THE DISCRIMINATOR, AND WHY THE OBVIOUS ONE DOES NOT WORK ★
 *
 * The obvious idea is "a bike leans, so look for roll". It fails, because the
 * SPECIFIC FORCE tilts by the same angle in both vehicles: a car cornering at
 * 4.5 m/s^2 lateral has a resultant tilted 25 degrees from vertical, exactly as
 * a bike leaning 25 degrees does. Same trajectory, same forces. Measuring the
 * tilt of the force tells you about the corner, not about the vehicle.
 *
 * What differs is whether the SENSOR follows it.
 *
 *   A car stays level. The phone is bolted to a level thing, so in the phone's
 *   own frame the specific force SWINGS sideways by the full 25 degrees.
 *
 *   A bike rolls until the resultant runs down its own axis. The phone is
 *   bolted to that, so in the phone's own frame the force does not move at all
 *   — it only gets heavier. That is what leaning is for.
 *
 * So: during a sustained turn, compare how far the instantaneous specific-force
 * direction has moved from its own slow average against how far the corner says
 * it should have. A car scores near one. A bike scores near zero.
 *
 * ★ AND IT MUST DEFAULT TO CAR ★
 * Getting this wrong in the bike direction applies a lean compensation that is
 * not warranted, inflating every turn. Getting it wrong in the car direction
 * costs the compensation, which is what every version before this one did. The
 * asymmetry says: require real evidence to leave CAR.
 */
import { GRAVITY_MPS2 } from '../alignment/gravity.js';
import type { Vec3 } from '../types.js';

export type VehicleType = 'UNKNOWN' | 'CAR' | 'TWO_WHEELER';

export interface VehicleTypeConfig {
  /** Turn rate below which a sample carries no information, rad/s. */
  minYawRateRadPerSec: number;
  /** And speed below which the lean physics does not apply, m/s. */
  minSpeedMps: number;
  /** Expected tilt below this is too small to measure against, degrees. */
  minExpectedTiltDeg: number;
  /** Samples of evidence before a verdict is offered. */
  minSamples: number;
  /** Follow ratio below this is a leaning vehicle. */
  bikeThreshold: number;
  /** And above this is a level one. */
  carThreshold: number;
}

export const DEFAULT_VEHICLE_TYPE_CONFIG: VehicleTypeConfig = {
  minYawRateRadPerSec: 0.12,
  minSpeedMps: 5,
  minExpectedTiltDeg: 6,
  minSamples: 60,
  // Deliberately far apart, with a wide band of "not sure" between them. The
  // cost of a wrong bike verdict is a compensation applied to a car; the cost
  // of no verdict is the behaviour every previous phase had.
  bikeThreshold: 0.35,
  carThreshold: 0.65,
};

export interface VehicleTypeState {
  type: VehicleType;
  /** 0 = the sensor never follows the force, 1 = it follows it entirely. */
  followRatio: number;
  /** Turning samples that carried usable evidence. */
  samples: number;
  confidence: number;
}

export class VehicleTypeDetector {
  private config: VehicleTypeConfig;
  private ratioSum = 0;
  private count = 0;
  private decided: VehicleType = 'UNKNOWN';

  constructor(config: Partial<VehicleTypeConfig> = {}) {
    this.config = { ...DEFAULT_VEHICLE_TYPE_CONFIG, ...config };
  }

  setConfig(patch: Partial<VehicleTypeConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  get state(): VehicleTypeState {
    const ratio = this.count > 0 ? this.ratioSum / this.count : 0;
    return {
      type: this.decided,
      followRatio: ratio,
      samples: this.count,
      confidence:
        this.count < this.config.minSamples
          ? 0
          : Math.min(1, this.count / (this.config.minSamples * 3)),
    };
  }

  /**
   * @param accel   RAW specific force, device frame, gravity included.
   * @param up      the slowly-tracked vertical in device coordinates.
   * @param speedMps current speed.
   * @param measuredYawRateRadPerSec yaw rate about `up`.
   */
  push(
    accel: Vec3,
    up: Readonly<Vec3>,
    speedMps: number,
    measuredYawRateRadPerSec: number,
  ): VehicleTypeState {
    const mag = Math.hypot(accel[0], accel[1], accel[2]);
    if (
      !Number.isFinite(mag) ||
      mag < 1 ||
      !Number.isFinite(speedMps) ||
      speedMps < this.config.minSpeedMps ||
      Math.abs(measuredYawRateRadPerSec) < this.config.minYawRateRadPerSec
    ) {
      return this.state;
    }

    // What the corner says the tilt should be. Uses the measured yaw rate,
    // which understates a bike's — and that only makes the expected tilt
    // smaller, so a bike's ratio is if anything flattered UPWARD. The test is
    // conservative in the direction that matters.
    const lateral = Math.abs(speedMps * measuredYawRateRadPerSec);
    const expectedTiltRad = Math.atan2(lateral, GRAVITY_MPS2);
    if ((expectedTiltRad * 180) / Math.PI < this.config.minExpectedTiltDeg) return this.state;

    // How far the force actually moved in the SENSOR's frame.
    const dot =
      (accel[0] * up[0] + accel[1] * up[1] + accel[2] * up[2]) / mag;
    const measuredTiltRad = Math.acos(Math.max(-1, Math.min(1, dot)));

    const ratio = measuredTiltRad / expectedTiltRad;
    this.ratioSum += Math.max(0, Math.min(2, ratio));
    this.count++;

    if (this.count >= this.config.minSamples) {
      const mean = this.ratioSum / this.count;
      if (mean <= this.config.bikeThreshold) this.decided = 'TWO_WHEELER';
      else if (mean >= this.config.carThreshold) this.decided = 'CAR';
      // Between the two, no verdict — and no verdict means CAR behaviour,
      // which is the safe default. Silence is a decision here, not an omission.
    }
    return this.state;
  }

  reset(): void {
    this.ratioSum = 0;
    this.count = 0;
    this.decided = 'UNKNOWN';
  }
}
