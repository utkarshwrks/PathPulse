import type { Vec3 } from '../types.js';

export interface AlignmentState {
  /** Rotation about the vertical axis from device frame to vehicle frame, radians. */
  yawOffsetRad: number;
  isCalibrated: boolean;
  /** 0..1 — how much to trust the alignment. */
  quality: number;
}

/**
 * Phone-to-vehicle alignment, MVP version.
 *
 * The navigation math needs to know which way the phone is pointing relative
 * to the vehicle: "forward" in the maths must be forward in the world. The
 * default assumes the phone sits flat on a dashboard with its +Y axis pointing
 * along the bonnet, which covers the demo mount.
 *
 * `startCalibration()` refines it: drive straight for a few seconds and the
 * dominant horizontal acceleration direction becomes forward.
 *
 * Phase 12 replaces this with continuous PCA-based alignment that survives the
 * phone being picked up, re-seated, or left loose in a cup holder.
 */
export class SimpleAlignment {
  private yawOffsetRad = 0;
  private calibrated = false;
  private samples: Array<{ x: number; y: number }> = [];
  private calibrating = false;
  private calibrationEndsAtMs = 0;

  get state(): AlignmentState {
    return {
      yawOffsetRad: this.yawOffsetRad,
      isCalibrated: this.calibrated,
      quality: this.calibrated ? 1 : 0.5,
    };
  }

  /** Collect horizontal acceleration for `durationMs` of straight driving. */
  startCalibration(nowMs: number, durationMs = 5000): void {
    this.calibrating = true;
    this.calibrationEndsAtMs = nowMs + durationMs;
    this.samples = [];
  }

  get isCalibrating(): boolean {
    return this.calibrating;
  }

  /** Feed gravity-removed acceleration during calibration. */
  push(linearAccel: Vec3, nowMs: number): void {
    if (!this.calibrating) return;
    const [x, y] = linearAccel;
    // Only samples with real longitudinal content carry direction information.
    if (Math.hypot(x, y) > 0.3) this.samples.push({ x, y });

    if (nowMs >= this.calibrationEndsAtMs) this.finishCalibration();
  }

  private finishCalibration(): void {
    this.calibrating = false;
    if (this.samples.length < 10) return;

    // Mean acceleration direction over straight driving points forward.
    // (Phase 12 upgrades this to a proper principal-component analysis, which
    // is robust to braking reversing the sign.)
    const sum = this.samples.reduce(
      (acc, s) => ({ x: acc.x + s.x, y: acc.y + s.y }),
      { x: 0, y: 0 },
    );
    const meanX = sum.x / this.samples.length;
    const meanY = sum.y / this.samples.length;
    if (Math.hypot(meanX, meanY) < 0.05) return;

    // Angle from the assumed +Y forward axis.
    this.yawOffsetRad = Math.atan2(meanX, meanY);
    this.calibrated = true;
  }

  /**
   * Rotate a device-frame horizontal vector into the vehicle frame.
   *
   * ★ SIGN CONVENTION, DERIVED RATHER THAN GUESSED ★
   *
   * `finishCalibration` sets `yawOffsetRad = atan2(meanX, meanY)` from the
   * acceleration seen while driving straight — so the vehicle's FORWARD
   * direction, expressed in device coordinates, is the unit vector
   * (sin theta, cos theta), and its right-hand side is (cos theta, -sin theta).
   *
   * The components of a device vector are therefore its dot products with
   * those axes:
   *
   *   forward = x sin(theta) + y cos(theta)
   *   lateral = x cos(theta) - y sin(theta)
   *
   * The first version had both signs the other way round, which is the inverse
   * rotation. It was invisible because the offset is zero until calibration
   * runs and nothing calls `startCalibration` yet — but a phone mounted at 90
   * degrees would have reported forward acceleration as backward, and dead
   * reckoning would have driven the vehicle in reverse.
   */
  toVehicleFrame(x: number, y: number): { forward: number; lateral: number } {
    const c = Math.cos(this.yawOffsetRad);
    const s = Math.sin(this.yawOffsetRad);
    return { forward: y * c + x * s, lateral: x * c - y * s };
  }

  reset(): void {
    this.yawOffsetRad = 0;
    this.calibrated = false;
    this.calibrating = false;
    this.samples = [];
  }
}
