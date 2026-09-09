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
 * The most a road-going two-wheeler leans, radians.
 *
 * ★ THE LEAN IS INFERRED FROM A SPEED WE MAY NOT BE ENTITLED TO BELIEVE ★
 *
 * `sin(lean) = v * w / g` is LINEAR IN v, and during an outage `v` is not
 * measured — it is whatever the speed chain currently believes. So an error in
 * the speed estimate is an error in the inferred lean, and because the
 * correction is `1 / cos(lean)` that error is then applied to the heading,
 * which is the one quantity an outage has no other way to fix.
 *
 * Worked on the field report's ride — a scooter at a true 8.3 m/s, with the
 * speed model reading 24.7 (see `mlSpeedTrustGate`), taking an ordinary corner
 * at a smoothed 0.35 rad/s:
 *
 *   speed used   sin(lean)   lean     correction
 *     8.3 m/s      0.296     17.2°      1.05x     <- what the bike did
 *    24.7 m/s      0.881     61.8°      2.11x     <- what the engine applied
 *
 * A 90-degree corner integrated as 190 degrees. The estimate then points down
 * a road at right angles to the one the rider is on, which is past
 * `maxHeadingMismatchDeg`, so map matching stops matching and the marker is
 * released to wander. "it goes anywhere ... it just do hit and trail."
 *
 * The old bound was numerical rather than physical — `applyLeanCompensation`
 * refused only once cos fell below 0.1, which is 84 degrees, and everything
 * between 40 and 84 degrees passed through multiplying the yaw rate by 1.3 to
 * 9.6. Nothing in that band is a lean. A rider on a public road, on a scooter,
 * in traffic, does not exceed about 40 degrees — MotoGP is 60 and that is with
 * slicks, a closed circuit and a knee on the floor.
 *
 * So an inference past 40 degrees is not a report about the bike; it is a
 * report that one of the inputs is wrong. Clamping keeps the compensation
 * intact for every lean a road rider actually produces — at 40 degrees the
 * correction is still a full 1.31x — and bounds what a bad speed can do to the
 * heading. Which is the right shape: the failure it prevents is unbounded, and
 * the cost when it binds is that a corner is under-rotated by a few per cent.
 */
export const DEFAULT_MAX_LEAN_RAD = (40 * Math.PI) / 180;

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
 *
 * And it is bounded well before that by what a road rider does. See
 * `DEFAULT_MAX_LEAN_RAD`.
 */
export function leanAngleRad(
  speedMps: number,
  measuredYawRateRadPerSec: number,
  maxLeanRad: number = DEFAULT_MAX_LEAN_RAD,
): number {
  if (!Number.isFinite(speedMps) || !Number.isFinite(measuredYawRateRadPerSec)) return 0;
  const s = (Math.max(0, speedMps) * measuredYawRateRadPerSec) / GRAVITY_MPS2;
  const raw = Math.asin(Math.max(-0.999, Math.min(0.999, s)));
  const cap = Number.isFinite(maxLeanRad) ? Math.abs(maxLeanRad) : DEFAULT_MAX_LEAN_RAD;
  return Math.max(-cap, Math.min(cap, raw));
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
  maxLeanRad: number = DEFAULT_MAX_LEAN_RAD,
): number {
  return applyLeanCompensation(
    measuredYawRateRadPerSec,
    leanAngleRad(speedMps, measuredYawRateRadPerSec, maxLeanRad),
  );
}

/**
 * Divide out a lean that was estimated somewhere else.
 *
 * ★ A LEAN IS NOT A PER-SAMPLE QUANTITY ★
 *
 * `leanCompensatedYawRate` infers the lean from the SAME instantaneous yaw rate
 * it then corrects, and that closed loop is only sound for the steady
 * coordinated turn the derivation assumes. A pothole is not a coordinated
 * turn. Neither is engine buzz, or a steering correction, and on an Indian road
 * a scooter delivers all three onto the gyro continuously.
 *
 * What that costs, at 60 km/h, is a transfer function that is neither linear
 * nor monotonic — measured by feeding it single values:
 *
 *   measured w   sin(lean)   applied
 *     0.10 rad/s     0.17     0.101     (1.0x)
 *     0.30           0.51     0.349     (1.2x)
 *     0.50           0.85     0.948     (1.9x)
 *     0.60           1.02     0.600     (1.0x — the clamp, and a cliff)
 *
 * A noise spike at 0.5 rad/s is amplified to nearly twice itself, and one at
 * 0.6 passes through untouched because sin(lean) saturated. Integrated, that is
 * heading error that a real lean never produced — and once the heading is more
 * than `maxHeadingMismatchDeg` from the road, map matching stops matching and
 * the marker is released to wander. Which is the field report: on a scooter,
 * on a straight road, "it moves to other roads and makes zigzag pattern".
 *
 * A physical lean cannot change at that bandwidth. A rider takes the better
 * part of a second to put a bike over and the same to pick it up, so the lean
 * belongs to a SMOOTHED yaw rate while the correction factor applies to the
 * instantaneous one. Splitting the two is what this overload is for; the caller
 * owns the smoothing because it owns the sample clock.
 */
export function applyLeanCompensation(
  measuredYawRateRadPerSec: number,
  leanRad: number,
): number {
  if (!Number.isFinite(measuredYawRateRadPerSec)) return 0;
  if (!Number.isFinite(leanRad)) return measuredYawRateRadPerSec;
  const c = Math.cos(leanRad);
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
