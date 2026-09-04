/**
 * Phase 18B — two-wheelers, which lean.
 *
 * ★ WHY THIS IS A REAL PROBLEM AND NOT A DETAIL ★
 *
 * The problem statement names them: "millions of two-wheelers (motorcycles /
 * scooters)". India has more of them than everything else combined, and every
 * constraint in this engine was written for a car.
 *
 * The one that breaks is not the non-holonomic constraint, which people expect
 * — it is the ATTITUDE reference. `AttitudeEstimator` finds "down" by tracking
 * the measured specific force, which is correct for a vehicle that stays level
 * and wrong for one that does not. In a steady turn a motorcycle leans until
 * the resultant of gravity and centripetal acceleration runs straight down its
 * own vertical axis — that is what leaning IS, and it is why a rider feels
 * pressed into the seat rather than sideways.
 *
 * So a phone strapped to a leaning bike measures a specific force that never
 * moves in its own frame. The estimator concludes the bike's tilted axis is
 * "down", and the yaw rate it reads by projecting the gyro onto that axis is
 * the true yaw rate multiplied by cos(lean).
 *
 * A 25-degree lean is cos(25°) = 0.906. The bike turns nine per cent less than
 * the engine believes... in the wrong direction: the engine believes it turned
 * LESS than it did. Over a 90-degree corner that is eight degrees of heading
 * error, and eight degrees over a kilometre of tunnel is 140 metres of
 * cross-track error — from one roundabout.
 *
 * ★ THE CLOSED FORM ★
 *
 * A bike in a steady turn leans so that the resultant is along its own
 * vertical:
 *
 *     tan(lean) = a_lateral / g = v * omega_true / g
 *
 * and the gyro's component along that leaned vertical is
 *
 *     omega_measured = omega_true * cos(lean)
 *
 * Substituting one into the other eliminates the unknown true rate entirely:
 *
 *     tan(lean) = v * (omega_measured / cos(lean)) / g
 *     sin(lean) = v * omega_measured / g
 *
 * So the lean comes from quantities we already have — speed and the yaw rate
 * we measured — with no iteration and no extra sensor. And then
 * `omega_true = omega_measured / cos(lean)`.
 *
 * Worked: 15 m/s, true rate 0.30 rad/s. Lateral is 4.5 m/s^2, so the lean is
 * atan(4.5/9.81) = 24.6 degrees and the gyro reads 0.30 * cos(24.6) = 0.273.
 * Recovering: sin(lean) = 15 * 0.273 / 9.81 = 0.417, lean = 24.6 degrees,
 * omega_true = 0.273 / 0.909 = 0.300. Exactly back.
 */
import { GRAVITY_MPS2 } from '../alignment/gravity.js';

/**
 * Lean angle from speed and the MEASURED yaw rate, radians.
 *
 * Signed: positive means leaning right, matching a positive (clockwise) yaw
 * rate. The magnitude is what the compensation uses; the sign is for the UI
 * and for the vehicle-type detector.
 *
 * ★ THE CLAMP IS NOT DEFENSIVE, IT IS PHYSICAL ★ `sin(lean) = v*w/g` has no
 * solution when v*w exceeds g: that would be a lean past 90 degrees, which is
 * a crash rather than a corner. It happens transiently from noise at low speed,
 * and clamping is the honest answer — the bike is at its limit, not inverted.
 */
export function leanAngleRad(speedMps: number, measuredYawRateRadPerSec: number): number {
  if (!Number.isFinite(speedMps) || !Number.isFinite(measuredYawRateRadPerSec)) return 0;
  const s = (Math.max(0, speedMps) * measuredYawRateRadPerSec) / GRAVITY_MPS2;
  return Math.asin(Math.max(-0.999, Math.min(0.999, s)));
}

/**
 * The true yaw rate about the VERTICAL, recovered from the leaned measurement.
 *
 * ★ THIS MUST BE GATED ON A DETECTED TWO-WHEELER. IT IS NOT A NO-OP FOR A CAR ★
 *
 * The first version of this comment claimed it was — the reasoning being that
 * with no lean, cos(0) is 1 — and a test disproved it immediately. The
 * function cannot tell whether the vehicle leaned; it INFERS a lean from speed
 * and yaw rate, and a car cornering briskly produces exactly the same inputs
 * as a bike leaning. At 15 m/s and 0.35 rad/s it infers a 32-degree lean and
 * inflates the car's turn rate by 18 %.
 *
 * So the compensation is applied only when `VehicleTypeDetector` has actually
 * decided TWO_WHEELER, and the detector defaults to CAR and requires real
 * cornering evidence to leave it. The asymmetry is deliberate: a wrong bike
 * verdict inflates every corner for the rest of the drive, while a wrong car
 * verdict merely costs the compensation — which is the behaviour every phase
 * before this one had.
 */
export function leanCompensatedYawRate(
  speedMps: number,
  measuredYawRateRadPerSec: number,
): number {
  const lean = leanAngleRad(speedMps, measuredYawRateRadPerSec);
  const c = Math.cos(lean);
  // Below about 6 degrees of cos the correction exceeds 10x and is noise
  // amplification rather than compensation.
  if (!(c > 0.1)) return measuredYawRateRadPerSec;
  return measuredYawRateRadPerSec / c;
}

/**
 * Turn radius implied by the lean, metres.
 *
 * From tan(lean) = v^2 / (r*g). Diagnostic rather than an input: it is a second
 *, independent statement about the same corner, and a rider can be shown it.
 */
export function turnRadiusFromLeanM(speedMps: number, leanRad: number): number {
  const t = Math.abs(Math.tan(leanRad));
  if (!(t > 1e-6) || !Number.isFinite(speedMps)) return Infinity;
  return (speedMps * speedMps) / (GRAVITY_MPS2 * t);
}
