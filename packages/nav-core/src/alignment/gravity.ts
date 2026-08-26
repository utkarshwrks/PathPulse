import type { Quaternion, Vec3 } from '../types.js';
import { Vec3LowPassFilter } from '../filters/lowpass.js';

export const GRAVITY_MPS2 = 9.80665;

/**
 * Separates vehicle motion from gravity.
 *
 * ★ ATTITUDE ACCURACY IS POSITION ACCURACY ★
 *
 * An accelerometer measures specific force — gravity plus motion, mixed. To
 * get motion alone you must know exactly which way is down, and any error in
 * that estimate leaks gravity straight into the motion signal.
 *
 * Work the numbers: a 1 degree attitude error tilts the gravity vector enough
 * to inject sin(1 deg) x 9.81 = 0.171 m/s^2 of false acceleration. Position
 * error from a constant acceleration is 0.5 x a x t^2, so after 60 seconds
 * that is 0.5 x 0.171 x 3600 = ~308 metres.
 *
 * One degree. Five minutes of tunnel. Three hundred metres of error, from an
 * error you cannot see on any screen.
 *
 * This is why Phase 12 builds a proper automatic alignment engine, and why the
 * rotation-vector path below is strongly preferred over the low-pass fallback.
 */
export class GravityRemover {
  private readonly gravityEstimate = new Vec3LowPassFilter(0.3, 50);
  private hasQuaternion = false;

  /**
   * @returns linear acceleration with gravity removed, still in the device frame
   *          when using the fallback, or rotated to world when a quaternion is
   *          available.
   */
  remove(ax: number, ay: number, az: number, quat?: Quaternion): Vec3 {
    if (quat && quat.every(Number.isFinite)) {
      this.hasQuaternion = true;
      return this.removeWithQuaternion(ax, ay, az, quat);
    }
    this.hasQuaternion = false;
    return this.removeWithLowPass(ax, ay, az);
  }

  get usingQuaternion(): boolean {
    return this.hasQuaternion;
  }

  /**
   * Rotate the measurement into the world frame, then subtract a known-vertical
   * gravity vector. Preferred: the rotation vector sensor fuses gyro, accel and
   * magnetometer, so it tracks attitude far better than filtering ever can.
   */
  private removeWithQuaternion(ax: number, ay: number, az: number, q: Quaternion): Vec3 {
    const [w, x, y, z] = q;
    // v' = q * v * q^-1, expanded.
    const tx = 2 * (y * az - z * ay);
    const ty = 2 * (z * ax - x * az);
    const tz = 2 * (x * ay - y * ax);
    const worldX = ax + w * tx + (y * tz - z * ty);
    const worldY = ay + w * ty + (z * tx - x * tz);
    const worldZ = az + w * tz + (x * ty - y * tx);
    // World frame is East-North-Up, so gravity is entirely on +Z.
    return [worldX, worldY, worldZ - GRAVITY_MPS2];
  }

  /**
   * Fallback when no rotation vector exists: gravity is the slow-moving part
   * of the accelerometer signal, so a very low cutoff isolates it.
   *
   * Weaker than the quaternion path — a sustained real acceleration (a long
   * motorway on-ramp) is slow enough to be mistaken for gravity, so it gets
   * absorbed into the estimate and vanishes from the output.
   */
  private removeWithLowPass(ax: number, ay: number, az: number): Vec3 {
    const [gx, gy, gz] = this.gravityEstimate.push(ax, ay, az);
    return [ax - gx, ay - gy, az - gz];
  }

  reset(): void {
    this.gravityEstimate.reset();
  }
}
