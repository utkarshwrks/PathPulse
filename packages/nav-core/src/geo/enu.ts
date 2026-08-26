import type { EnuPoint, LatLon } from '../types.js';
import { WGS84_A, WGS84_B, WGS84_E2, WGS84_EP2 } from './constants.js';
import { toDegrees, toRadians } from './angles.js';

export interface EcefPoint {
  x: number;
  y: number;
  z: number;
}

/** Geodetic (deg, deg, m) -> ECEF (m). */
export function latLonToEcef(lat: number, lon: number, heightM = 0): EcefPoint {
  const phi = toRadians(lat);
  const lambda = toRadians(lon);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  // Radius of curvature in the prime vertical.
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  return {
    x: (N + heightM) * cosPhi * Math.cos(lambda),
    y: (N + heightM) * cosPhi * Math.sin(lambda),
    z: (N * (1 - WGS84_E2) + heightM) * sinPhi,
  };
}

/**
 * ECEF (m) -> geodetic (deg, deg, m), via Bowring's closed-form solution.
 * Accurate to well under a millimetre for terrestrial altitudes, and unlike
 * the iterative form it has no convergence loop to blow the 10 Hz budget.
 */
export function ecefToLatLon(x: number, y: number, z: number): LatLon & { heightM: number } {
  const p = Math.hypot(x, y);
  if (p < 1e-9) {
    // On the polar axis: longitude is undefined, pick 0.
    const sign = z >= 0 ? 1 : -1;
    return { lat: sign * 90, lon: 0, heightM: Math.abs(z) - WGS84_B };
  }
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const phi = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );
  const lambda = Math.atan2(y, x);
  const sinPhi = Math.sin(phi);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const heightM = p / Math.cos(phi) - N;
  return { lat: toDegrees(phi), lon: toDegrees(lambda), heightM };
}

/**
 * Geodetic -> local East-North-Up metres, about a reference point.
 *
 * Why this exists: dead reckoning integrates metres per second. Doing that in
 * degrees means carrying a latitude-dependent scale factor through every step.
 * Convert once at the reference, do all the math in flat metres, convert back
 * only for display.
 */
export function latLonToEnu(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number,
  heightM = 0,
  refHeightM = 0,
): EnuPoint {
  const ref = latLonToEcef(refLat, refLon, refHeightM);
  const pt = latLonToEcef(lat, lon, heightM);
  const dx = pt.x - ref.x;
  const dy = pt.y - ref.y;
  const dz = pt.z - ref.z;

  const phi = toRadians(refLat);
  const lambda = toRadians(refLon);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);

  return {
    e: -sinLambda * dx + cosLambda * dy,
    n: -sinPhi * cosLambda * dx - sinPhi * sinLambda * dy + cosPhi * dz,
    u: cosPhi * cosLambda * dx + cosPhi * sinLambda * dy + sinPhi * dz,
  };
}

/** Local East-North-Up metres -> geodetic, about a reference point. */
export function enuToLatLon(
  e: number,
  n: number,
  refLat: number,
  refLon: number,
  u = 0,
  refHeightM = 0,
): LatLon & { heightM: number } {
  const phi = toRadians(refLat);
  const lambda = toRadians(refLon);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);

  // Transpose of the ENU rotation matrix.
  const dx = -sinLambda * e - sinPhi * cosLambda * n + cosPhi * cosLambda * u;
  const dy = cosLambda * e - sinPhi * sinLambda * n + cosPhi * sinLambda * u;
  const dz = cosPhi * n + sinPhi * u;

  const ref = latLonToEcef(refLat, refLon, refHeightM);
  return ecefToLatLon(ref.x + dx, ref.y + dy, ref.z + dz);
}
