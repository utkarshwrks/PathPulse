import { DEG2RAD, RAD2DEG } from './constants.js';

export const toRadians = (deg: number): number => deg * DEG2RAD;
export const toDegrees = (rad: number): number => rad * RAD2DEG;

/**
 * Wrap an angle in degrees into (-180, 180].
 * Used everywhere heading differences are taken — without it, a turn across
 * north reads as a 359-degree swing and the turn detector fires spuriously.
 */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return NaN;
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** Wrap an angle in degrees into [0, 360). Compass convention. */
export function normalizeAngle360(deg: number): number {
  if (!Number.isFinite(deg)) return NaN;
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** Wrap radians into (-pi, pi]. */
export function normalizeRadians(rad: number): number {
  if (!Number.isFinite(rad)) return NaN;
  let a = rad % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Shortest signed difference a - b, in (-180, 180]. */
export function angleDifference(a: number, b: number): number {
  return normalizeAngle(a - b);
}
