export interface NhcConfig {
  /**
   * How much of the lateral velocity to remove, 0..1.
   *
   * Deliberately not 1.0. Real vehicles do slip a little — tyre slip angle,
   * crabbing in crosswind, a skid — and a constraint asserted with absolute
   * certainty makes the estimator over-confident, so it stops believing
   * genuine evidence that contradicts it later.
   */
  strength: number;
  /**
   * Above this lateral-acceleration mismatch the alignment is suspect rather
   * than the vehicle sliding, m/s^2.
   */
  lateralMismatchTolerance: number;
}

export const DEFAULT_NHC_CONFIG: NhcConfig = {
  strength: 0.95,
  lateralMismatchTolerance: 2.0,
};

export interface NhcResult {
  /** Velocity after the constraint, ENU metres per second. */
  vE: number;
  vN: number;
  /** Speed along the heading after the constraint. */
  forwardSpeed: number;
  /** Lateral speed that was removed — a useful diagnostic. */
  removedLateralMps: number;
}

/**
 * NHC — Non-Holonomic Constraint.
 *
 * The physics is trivial and the payoff is the largest of any constraint here:
 * a car cannot slide sideways and cannot fly. So in the vehicle body frame the
 * lateral and vertical velocity components are zero. Any lateral velocity the
 * integration produced is, by construction, error — so delete it.
 *
 * This is what kills cross-track drift, which is the component that puts the
 * marker inside a building. The problem statement names NHC explicitly.
 *
 * Ten lines of code, and in the guide's own ablation it takes drift from 22%
 * to 11%.
 */
export function applyNhc(
  vE: number,
  vN: number,
  headingDeg: number,
  config: NhcConfig = DEFAULT_NHC_CONFIG,
): NhcResult {
  if (!Number.isFinite(vE) || !Number.isFinite(vN) || !Number.isFinite(headingDeg)) {
    return { vE: 0, vN: 0, forwardSpeed: 0, removedLateralMps: 0 };
  }

  const h = (headingDeg * Math.PI) / 180;
  // Compass bearing: the forward unit vector is (sin h, cos h) in ENU.
  const fE = Math.sin(h);
  const fN = Math.cos(h);
  // Right-hand side of the vehicle, 90 degrees clockwise from forward.
  const rE = Math.cos(h);
  const rN = -Math.sin(h);

  const forwardSpeed = vE * fE + vN * fN;
  const lateralSpeed = vE * rE + vN * rN;
  const keptLateral = lateralSpeed * (1 - config.strength);

  return {
    vE: forwardSpeed * fE + keptLateral * rE,
    vN: forwardSpeed * fN + keptLateral * rN,
    forwardSpeed,
    removedLateralMps: lateralSpeed - keptLateral,
  };
}

/**
 * Consistency check between the measured lateral acceleration and the lateral
 * acceleration the vehicle's own turn rate implies.
 *
 * In a steady turn a vehicle experiences a_lateral = v * yawRate. If the
 * accelerometer reports a large lateral force that the gyroscope's turn rate
 * cannot account for, we are not looking at cornering — we are looking at a
 * phone that has shifted in its mount, or an alignment offset that is simply
 * wrong. Either way the forward/lateral split is untrustworthy, so the
 * accelerometer-derived speed should be de-weighted rather than integrated
 * with confidence.
 *
 * @returns 0..1 confidence in the current forward/lateral decomposition.
 */
export function lateralConsistency(
  measuredLateralMps2: number,
  speedMps: number,
  yawRateRadPerSec: number,
  config: NhcConfig = DEFAULT_NHC_CONFIG,
): number {
  if (!Number.isFinite(measuredLateralMps2) || !Number.isFinite(yawRateRadPerSec)) return 0;
  const expected = speedMps * yawRateRadPerSec;
  const mismatch = Math.abs(measuredLateralMps2 - expected);
  return Math.max(0, Math.min(1, 1 - mismatch / config.lateralMismatchTolerance));
}
