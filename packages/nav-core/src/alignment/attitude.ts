import type { Quaternion, Vec3 } from '../types.js';
import { Vec3LowPassFilter } from '../filters/lowpass.js';
import { GRAVITY_MPS2 } from './gravity.js';

/**
 * Orientation-independent attitude reference.
 *
 * ★ THIS FIXES THE SINGLE WORST BUG IN THE PROJECT ★
 *
 * The old code took yaw rate straight from the device-frame gyroscope Z axis:
 *
 *     const yawRate = gyroZSign * (gz - biasZ)
 *
 * That is only yaw if the phone is lying flat on its back. Stand the phone up
 * in a windshield cradle and device +Z points at the horizon, so `gz` measures
 * the vehicle's *roll*, not its heading. Put the phone in a pocket and it
 * measures some arbitrary mixture. The integrated heading is then garbage, the
 * dot sets off in a direction unrelated to the road, and no downstream filter
 * can recover it because the error is in the input, not the estimate.
 *
 * The fix is to stop caring about device axes. Gravity tells us where "down"
 * is in the device frame at all times, for free, from the accelerometer we are
 * already reading. Yaw is by definition rotation about the vertical, so:
 *
 *     yawRate = -(omega · up_hat)
 *
 * Project the gyro vector onto the measured gravity direction. That is the
 * component of rotation about the true vertical, whatever the phone's
 * orientation, and it keeps working when the phone is picked up and re-seated
 * mid-drive.
 *
 * The negation converts from the gyroscope's right-hand rule (counter-clockwise
 * positive, viewed from above) to a compass bearing (clockwise positive), which
 * is the convention DeadReckoningEngine integrates in.
 *
 * The same up-vector gives us a horizontal plane, so the accelerometer's
 * forward/lateral split also stops depending on the phone sitting flat.
 */
export class AttitudeEstimator {
  /** Only used to seed `up` quickly at start-up, before the filter takes over. */
  private readonly gravityLowPass = new Vec3LowPassFilter(0.25, 50);
  private up: Vec3 = [0, 0, 1];
  private settled = false;
  private sampleCount = 0;
  /** How close |gravity| is to 9.81 — drops while accelerating hard. */
  private tiltQualityValue = 0;
  /**
   * Correction weight per sample once settled. At 50 Hz this is a ~30 s time
   * constant, chosen so that a ten-second motorway on-ramp cannot drag the
   * vertical with it. See the note on push().
   */
  private readonly steadyAlpha = 0.0007;
  /**
   * Slow average of |specific force|, used to gate the correction.
   *
   * Gating on the instantaneous magnitude does not work: 20 Hz road vibration
   * swings it by ~1 m/s^2 every sample, which would suppress the correction
   * permanently and leave the vertical to drift on gyro bias alone. Averaging
   * over about a second lets vibration cancel while a sustained acceleration —
   * which is exactly what must suppress the correction — still shows up.
   */
  private smoothedMag = 0;
  private hasSmoothedMag = false;

  /** Unit vector pointing up, expressed in the device frame. */
  get upVector(): Readonly<Vec3> {
    return this.up;
  }

  /** 0..1. Low when the phone is being shaken or the estimate is still filling. */
  get quality(): number {
    return this.tiltQualityValue;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * Feed one raw IMU sample (specific force with gravity included, plus the
   * gyro). Must be the RAW accelerometer, not the gravity-removed one.
   *
   * ★ WHY THIS IS A COMPLEMENTARY FILTER AND NOT A LOW-PASS ★
   *
   * The first version simply low-passed the accelerometer at 0.25 Hz and called
   * the result gravity. That is a trap. When a car accelerates at 2 m/s^2 the
   * accelerometer reads (0, 2, 9.81); a low-pass slow enough to reject
   * vibration is still fast enough to follow a five-second acceleration, so the
   * "gravity" estimate tilts by about 11 degrees to point along (0, 2, 9.81).
   * Subtracting 9.81 along that tilted direction then cancels the very
   * acceleration we were trying to measure — forward acceleration came out near
   * zero, speed never rebuilt after a stop, and the vehicle sat at 0 m/s in the
   * tunnel while the real one drove away at 13.7 m/s.
   *
   * The fix is to let the GYROSCOPE carry the vertical through those seconds
   * and use the accelerometer only as a slow long-term anchor:
   *
   *   predict:  up <- up - (omega x up) dt     (a world-fixed vector rotates by
   *                                             -omega as seen from the device)
   *   correct:  up <- normalise(up + alpha (a_hat - up))
   *
   * With alpha giving a ~30 s time constant, a ten-second on-ramp moves the
   * vertical by a negligible amount, while gyro bias — which would otherwise
   * make the prediction drift without limit — is still washed out over minutes.
   * This is the standard complementary-filter split: gyro for the short term,
   * accelerometer for the long term, each covering the other's weakness.
   */
  push(
    ax: number,
    ay: number,
    az: number,
    gx = 0,
    gy = 0,
    gz = 0,
    dtMs = 20,
    gyroBias: Readonly<Vec3> = [0, 0, 0],
  ): void {
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return;

    const mag = Math.hypot(ax, ay, az);
    // Free fall or a dead sensor. Keep the last good vertical rather than
    // normalising by ~0 and producing infinities.
    if (mag < 1) return;

    this.sampleCount++;

    if (!this.settled) {
      // Start-up: no usable vertical yet, so take the accelerometer at close to
      // face value. The vehicle is assumed roughly level and unaccelerating for
      // the first half second, which is what happens when an app is opened.
      const [lx, ly, lz] = this.gravityLowPass.push(ax, ay, az);
      const lmag = Math.hypot(lx, ly, lz);
      if (lmag >= 1) this.up = [lx / lmag, ly / lmag, lz / lmag];
      if (this.sampleCount >= 25) this.settled = true;
      this.tiltQualityValue = 0;
      return;
    }

    const dt = dtMs / 1000;
    if (dt > 0 && dt < 1 && Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz)) {
      // Predict: rotate the vertical by -omega.
      //
      // Bias is removed here, not just where yaw is read. The prediction is
      // what carries the vertical through the seconds when the accelerometer
      // cannot be trusted, so an uncorrected 0.01 rad/s bias would walk it
      // 0.57 deg every second — and 1 degree of tilt is 0.171 m/s^2 of false
      // acceleration. ZARU supplies the estimate for free at every stop.
      const wx = gx - gyroBias[0];
      const wy = gy - gyroBias[1];
      const wz = gz - gyroBias[2];
      const [ux, uy, uz] = this.up;
      this.up = [
        ux - (wy * uz - wz * uy) * dt,
        uy - (wz * ux - wx * uz) * dt,
        uz - (wx * uy - wy * ux) * dt,
      ];
    }

    // Track |a| slowly, so vibration averages out but sustained acceleration
    // does not. ~1 s at 50 Hz.
    const magAlpha = 0.02;
    if (!this.hasSmoothedMag) {
      this.smoothedMag = mag;
      this.hasSmoothedMag = true;
    } else {
      this.smoothedMag += magAlpha * (mag - this.smoothedMag);
    }

    // Correct, gated by how much this sample looks like pure gravity.
    //
    // When the averaged specific force departs from g, the accelerometer is
    // measuring motion as well as gravity and is a BAD attitude reference —
    // following it tilts the vertical toward the acceleration and cancels the
    // very signal being integrated. That was field defect #6. The Gaussian
    // gate falls away sharply: at 2 m/s^2 of sustained acceleration it is
    // essentially zero, so the gyro carries the vertical instead.
    //
    // Never exactly zero, and never gated for long, because gravity is the
    // only thing stopping gyro bias from walking the vertical away over a
    // whole drive.
    const err = Math.abs(this.smoothedMag - GRAVITY_MPS2) / GRAVITY_MPS2;
    const gate = Math.exp(-((err / 0.02) ** 2));
    const trust = Math.max(0.02, gate);
    const alpha = this.steadyAlpha * trust;

    const nx = ax / mag;
    const ny = ay / mag;
    const nz = az / mag;
    let [px, py, pz] = this.up;
    px += alpha * (nx - px);
    py += alpha * (ny - py);
    pz += alpha * (nz - pz);

    const pmag = Math.hypot(px, py, pz);
    if (pmag > 1e-6) this.up = [px / pmag, py / pmag, pz / pmag];

    this.tiltQualityValue = Math.max(0, Math.min(1, gate));
  }

  /** Seed the vertical immediately, bypassing the start-up ramp. */
  seed(ax: number, ay: number, az: number): void {
    const mag = Math.hypot(ax, ay, az);
    if (mag < 1) return;
    this.up = [ax / mag, ay / mag, az / mag];
    this.settled = true;
    this.sampleCount = Math.max(this.sampleCount, 25);
  }

  /**
   * Yaw rate about the true vertical, in the compass sense (clockwise positive),
   * radians per second.
   *
   * @param bias gyro bias in the device frame, from ZARU. Subtracted before
   *             projection, because bias lives in device axes too.
   */
  yawRate(gx: number, gy: number, gz: number, bias: Vec3 = [0, 0, 0]): number {
    if (!this.settled) return 0;
    const wx = gx - bias[0];
    const wy = gy - bias[1];
    const wz = gz - bias[2];
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) return 0;
    const [ux, uy, uz] = this.up;
    return -(wx * ux + wy * uy + wz * uz);
  }

  /**
   * Split a gravity-removed acceleration into the horizontal plane defined by
   * the current up vector.
   *
   * `yawOffsetRad` rotates within that plane to account for the phone not
   * pointing along the bonnet — that part is still SimpleAlignment's job, but
   * it now operates on a genuinely horizontal plane instead of on device X/Y.
   *
   * @returns forward and lateral acceleration in the vehicle frame, m/s^2, plus
   *          the vertical residual (useful for diagnostics — it should be small).
   */
  toHorizontal(
    linear: Vec3,
    yawOffsetRad = 0,
  ): { forward: number; lateral: number; vertical: number } {
    if (!this.settled) return { forward: 0, lateral: 0, vertical: 0 };

    const [lx, ly, lz] = linear;
    const [ux, uy, uz] = this.up;

    // Strip whatever is left along the vertical. Anything there is either real
    // bump/vibration or leftover gravity — neither belongs in a road-speed
    // integration.
    const vertical = lx * ux + ly * uy + lz * uz;
    const hx = lx - vertical * ux;
    const hy = ly - vertical * uy;
    const hz = lz - vertical * uz;

    // Build a horizontal reference axis from a device axis projected onto the
    // plane. Prefer +Y (the bonnet direction for a flat dash mount), but fall
    // back when the phone is standing on its end and +Y is nearly vertical —
    // projecting it would leave almost nothing to normalise.
    const ref = pickReferenceAxis(this.up);
    const dot = ref[0] * ux + ref[1] * uy + ref[2] * uz;
    let fx = ref[0] - dot * ux;
    let fy = ref[1] - dot * uy;
    let fz = ref[2] - dot * uz;
    const fMag = Math.hypot(fx, fy, fz);
    if (fMag < 1e-6) return { forward: 0, lateral: 0, vertical };
    fx /= fMag;
    fy /= fMag;
    fz /= fMag;

    // Right-handed partner: lateral = up x forward.
    const rx = uy * fz - uz * fy;
    const ry = uz * fx - ux * fz;
    const rz = ux * fy - uy * fx;

    const alongF = hx * fx + hy * fy + hz * fz;
    const alongR = hx * rx + hy * ry + hz * rz;

    // Rotate inside the horizontal plane by the alignment offset.
    const c = Math.cos(yawOffsetRad);
    const s = Math.sin(yawOffsetRad);
    return {
      forward: alongF * c - alongR * s,
      lateral: alongR * c + alongF * s,
      vertical,
    };
  }

  /**
   * Remove gravity using the tracked up vector, in the device frame.
   *
   * Better than GravityRemover's low-pass fallback for our purposes: that one
   * low-passes each axis independently and subtracts, which also removes any
   * sustained real acceleration (a long motorway on-ramp vanishes). This
   * subtracts a fixed 9.81 along a *direction* instead, so sustained
   * longitudinal acceleration survives.
   */
  removeGravity(ax: number, ay: number, az: number): Vec3 {
    if (!this.settled) return [0, 0, 0];
    const [ux, uy, uz] = this.up;
    return [ax - GRAVITY_MPS2 * ux, ay - GRAVITY_MPS2 * uy, az - GRAVITY_MPS2 * uz];
  }

  /** Seed the up vector directly from a rotation-vector quaternion, if present. */
  pushQuaternion(q: Quaternion): void {
    if (!q.every(Number.isFinite)) return;
    const [w, x, y, z] = q;
    // Third row of the rotation matrix: world +Z expressed in the device frame.
    this.up = [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z];
    const mag = Math.hypot(this.up[0], this.up[1], this.up[2]);
    if (mag > 1e-6) {
      this.up = [this.up[0] / mag, this.up[1] / mag, this.up[2] / mag];
      this.settled = true;
      this.tiltQualityValue = 1;
    }
  }

  reset(): void {
    this.gravityLowPass.reset();
    this.up = [0, 0, 1];
    this.settled = false;
    this.sampleCount = 0;
    this.tiltQualityValue = 0;
    this.smoothedMag = 0;
    this.hasSmoothedMag = false;
  }
}

/**
 * Choose the device axis least parallel to "up", so projecting it onto the
 * horizontal plane leaves a well-conditioned vector to normalise.
 */
function pickReferenceAxis(up: Readonly<Vec3>): Vec3 {
  const ay = Math.abs(up[1]);
  const az = Math.abs(up[2]);
  // Phone flat on its back: up ~ +Z, so +Y (towards the top edge) is the
  // natural forward. Phone upright in a cradle: up ~ +Y, so use +Z instead.
  if (ay < 0.9) return [0, 1, 0];
  if (az < 0.9) return [0, 0, 1];
  return [1, 0, 0];
}
