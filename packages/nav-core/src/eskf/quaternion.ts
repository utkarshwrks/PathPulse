/**
 * Quaternion algebra for the error-state filter.
 *
 * Convention, stated once and relied on everywhere below:
 *
 *   - A quaternion is `[w, x, y, z]` — the same order as `Quaternion` in
 *     types.ts, which is the order Android's rotation vector reports.
 *   - Hamilton product, NOT the JPL convention. Mixing the two silently
 *     transposes every rotation and is the single most common way an ESKF
 *     ends up integrating attitude backwards.
 *   - `q` rotates BODY into NAV: `v_nav = R(q) v_body`.
 *   - The nav frame is ENU (east, north, up) and the body frame is the
 *     VEHICLE frame: x forward, y left, z up. Getting the phone's own axes
 *     into the vehicle frame is the alignment engine's job, not this file's.
 */
import type { Quaternion, Vec3 } from '../types.js';
import type { Mat } from './matrix.js';

export const IDENTITY_QUAT: Quaternion = [1, 0, 0, 0];

export function quatNormalize(q: Quaternion): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  // A zero quaternion has no rotation to preserve, so identity is the only
  // answer that keeps the caller's arithmetic finite.
  if (!Number.isFinite(n) || n < 1e-12) return [...IDENTITY_QUAT];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Hamilton product a ⊗ b. */
export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatConjugate(q: Quaternion): Quaternion {
  return [q[0], -q[1], -q[2], -q[3]];
}

/**
 * The rotation vector `theta` (axis times angle, radians) as a quaternion.
 *
 * The small-angle branch is not an optimisation — at the angles a 200 Hz step
 * produces, `sin(|t|/2)/|t|` is 0/0 in floating point, and the series is the
 * numerically correct expression rather than the approximate one.
 */
export function quatFromRotationVector(theta: readonly number[]): Quaternion {
  const n = Math.hypot(theta[0]!, theta[1]!, theta[2]!);
  if (!Number.isFinite(n)) return [...IDENTITY_QUAT];
  if (n < 1e-8) {
    return quatNormalize([1, theta[0]! / 2, theta[1]! / 2, theta[2]! / 2]);
  }
  const half = n / 2;
  const s = Math.sin(half) / n;
  return [Math.cos(half), theta[0]! * s, theta[1]! * s, theta[2]! * s];
}

/** Rotation matrix R(q), body -> nav. */
export function quatToMatrix(q: Quaternion): Mat {
  const [w, x, y, z] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  return [
    [1 - 2 * (yy + zz), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (xx + zz), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (xx + yy)],
  ];
}

/** v_nav = R(q) v_body. */
export function rotateByQuat(q: Quaternion, v: readonly number[]): Vec3 {
  const r = quatToMatrix(q);
  return [
    r[0]![0]! * v[0]! + r[0]![1]! * v[1]! + r[0]![2]! * v[2]!,
    r[1]![0]! * v[0]! + r[1]![1]! * v[1]! + r[1]![2]! * v[2]!,
    r[2]![0]! * v[0]! + r[2]![1]! * v[1]! + r[2]![2]! * v[2]!,
  ];
}

/** v_body = R(q)^T v_nav. */
export function rotateByQuatInverse(q: Quaternion, v: readonly number[]): Vec3 {
  return rotateByQuat(quatConjugate(q), v);
}

/**
 * Compass heading of the body's forward axis, degrees clockwise from north.
 *
 * Read off the rotated x-axis rather than from Euler angles, so it stays right
 * when the vehicle is pitched — a Euler yaw extracted near vertical is the
 * classic gimbal artefact, and a hill is not an unusual road.
 */
export function quatToHeadingDeg(q: Quaternion): number {
  const f = rotateByQuat(q, [1, 0, 0]);
  // ENU: x is east, y is north. A compass bearing is atan2(east, north).
  const deg = (Math.atan2(f[0], f[1]) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Attitude from a compass heading, level (no pitch or roll). */
export function quatFromHeadingDeg(headingDeg: number): Quaternion {
  // A rotation of phi about up takes the body x-axis to (cos phi, sin phi) in
  // ENU — that is, east = cos phi, north = sin phi. A compass bearing h wants
  // east = sin h, north = cos h. So phi = 90 - h: the quarter turn is the
  // difference between "anticlockwise from east" and "clockwise from north",
  // and dropping it is a mirror-and-rotate that looks almost plausible on a
  // map until the vehicle turns.
  const half = ((90 - headingDeg) * Math.PI) / 360;
  return [Math.cos(half), 0, 0, Math.sin(half)];
}

/** Pitch and roll of the body frame, degrees, for the alignment readout. */
export function quatToPitchRollDeg(q: Quaternion): { pitchDeg: number; rollDeg: number } {
  const f = rotateByQuat(q, [1, 0, 0]);
  const l = rotateByQuat(q, [0, 1, 0]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f[2])));
  const roll = Math.asin(Math.max(-1, Math.min(1, l[2])));
  return { pitchDeg: (pitch * 180) / Math.PI, rollDeg: (roll * 180) / Math.PI };
}

/** Smallest angle between two attitudes, degrees. Used by the tests. */
export function quatAngleBetweenDeg(a: Quaternion, b: Quaternion): number {
  const d = quatMultiply(quatConjugate(quatNormalize(a)), quatNormalize(b));
  const w = Math.min(1, Math.abs(d[0]));
  return (2 * Math.acos(w) * 180) / Math.PI;
}
