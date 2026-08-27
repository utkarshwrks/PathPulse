import type { Vec3 } from '../types.js';

export interface ZaruConfig {
  /** Samples averaged before a bias estimate is accepted. 1 s at 50 Hz. */
  sampleCount: number;
  /** EMA weight for each accepted estimate. Low = slow, stable convergence. */
  alpha: number;
  /**
   * Largest believable gyro bias, rad/s. A consumer MEMS gyro sits well under
   * 0.05; anything past this is real motion that the stationarity detector
   * misclassified, and learning it as bias would corrupt every future heading.
   */
  maxBiasRadPerSec: number;
}

export const DEFAULT_ZARU_CONFIG: ZaruConfig = {
  sampleCount: 50,
  alpha: 0.1,
  maxBiasRadPerSec: 0.05,
};

/**
 * ZARU — Zero Angular Rate Update.
 *
 * When the vehicle is standing still, it is by definition not turning, so
 * every last bit of what the gyroscope reports is bias. That makes a red light
 * a free, perfectly-labelled calibration sample.
 *
 * ★ WHY THIS MATTERS MORE THAN IT LOOKS ★
 *
 * A typical phone gyro has a bias around 0.01 rad/s. That is 0.57 deg/s, which
 * sounds harmless — until you integrate it. Over the 197-second outage in our
 * field test that is 113 degrees of accumulated heading error. The dead
 * reckoning was travelling at a confident 25 km/h in a direction more than a
 * right angle away from the actual road.
 *
 * Heading error is what turns a 20 m problem into a 200 m one, because the
 * position error it creates grows with distance travelled, not with sensor
 * noise. Estimating and removing this bias is the highest-leverage line of
 * code in the constraint set.
 *
 * Bias is tracked in the DEVICE frame, because that is where it physically
 * lives — it is a property of the silicon, not of the vehicle.
 */
export class ZaruProcessor {
  private readonly config: ZaruConfig;
  private readonly samples: Vec3[] = [];
  private bias: Vec3 = [0, 0, 0];
  private initialised = false;
  private triggers = 0;

  constructor(config: Partial<ZaruConfig> = {}) {
    this.config = { ...DEFAULT_ZARU_CONFIG, ...config };
  }

  get gyroBias(): Readonly<Vec3> {
    return this.bias;
  }

  get triggerCount(): number {
    return this.triggers;
  }

  get hasEstimate(): boolean {
    return this.initialised;
  }

  /**
   * Feed one gyro sample together with the current stationarity verdict.
   *
   * @returns true when a bias estimate was accepted on this sample.
   */
  push(gx: number, gy: number, gz: number, isStationary: boolean): boolean {
    if (!isStationary) {
      // Moving again — throw the partial buffer away rather than averaging
      // across the boundary between standing still and pulling off.
      this.samples.length = 0;
      return false;
    }

    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) return false;
    this.samples.push([gx, gy, gz]);
    if (this.samples.length < this.config.sampleCount) return false;

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

    // Sanity gate. A bad stationarity call must not be able to poison the
    // bias, because a poisoned bias silently corrupts every subsequent
    // heading and there is nothing on screen that would reveal it.
    const mag = Math.hypot(candidate[0], candidate[1], candidate[2]);
    if (!Number.isFinite(mag) || mag > this.config.maxBiasRadPerSec) return false;

    if (!this.initialised) {
      // First estimate is taken whole. Easing in from zero would leave a large
      // known bias uncorrected for the first several stops.
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
    this.triggers++;
    return true;
  }

  reset(): void {
    this.samples.length = 0;
    this.bias = [0, 0, 0];
    this.initialised = false;
    this.triggers = 0;
  }
}
