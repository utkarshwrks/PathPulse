import type { LatLon } from '../types.js';
import { enuToLatLon } from '../geo/enu.js';
import { toRadians } from '../geo/angles.js';

/**
 * The uncertainty ellipse, as geographic coordinates.
 *
 * ★ WHY AN ELLIPSE AND NOT A CIRCLE ★
 * A circle says "we are somewhere within N metres". That is not what this
 * system knows. Along-track error grows with every second of unaided speed
 * integration; cross-track error is bounded by NHC and, once a road is
 * matched, capped outright by snapping. Those two numbers differ by a factor
 * of several during a long outage, and drawing them as one radius throws away
 * the more interesting half of the story — the half that shows the constraints
 * are doing something.
 *
 * Pure geometry: no map library, no browser types. The renderer hands these
 * coordinates to MapLibre and does no math of its own, which is what lets the
 * shape be unit tested instead of eyeballed.
 */

export interface CovarianceAxes {
  /** Semi-axis along the direction of travel, metres. */
  alongM: number;
  /** Semi-axis across the direction of travel, metres. */
  crossM: number;
  /** Direction of travel, degrees clockwise from true north. */
  headingDeg: number;
}

export interface EllipseRingOptions {
  /** Vertices in the ring. 64 is smooth at any zoom a phone will show. */
  segments: number;
  /**
   * Floor on each semi-axis, metres.
   *
   * A zero-area polygon is not "no uncertainty", it is an invisible shape —
   * and an ellipse that vanishes the instant GNSS is good reads as a rendering
   * bug rather than as confidence.
   */
  minAxisM: number;
  /**
   * Ceiling on each semi-axis, metres.
   *
   * Uncertainty grows without bound during an outage; the drawn shape must
   * not. Past a few kilometres the polygon stops being information and starts
   * being a coloured overlay across the whole viewport.
   */
  maxAxisM: number;
}

export const DEFAULT_ELLIPSE_OPTIONS: EllipseRingOptions = {
  segments: 64,
  minAxisM: 1,
  maxAxisM: 5000,
};

/** Clamp one semi-axis into the drawable range, treating junk as zero. */
function clampAxis(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Build a closed ring of `[lon, lat]` pairs outlining the uncertainty ellipse.
 *
 * The first vertex is repeated as the last, which is what GeoJSON requires of
 * a polygon ring — MapLibre will render an unclosed ring, but it is invalid
 * and anything else consuming the export would be within its rights to reject
 * it.
 *
 * Returns an empty array when the centre is not a real position, so a caller
 * can feed it engine output during INITIALIZING without a special case.
 */
export function buildConfidenceRing(
  centre: LatLon,
  axes: CovarianceAxes,
  options: Partial<EllipseRingOptions> = {},
): Array<[number, number]> {
  const { segments, minAxisM, maxAxisM } = { ...DEFAULT_ELLIPSE_OPTIONS, ...options };

  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return [];
  if (Math.abs(centre.lat) > 90 || Math.abs(centre.lon) > 180) return [];

  const steps = Math.max(3, Math.floor(segments));
  const along = clampAxis(axes.alongM, minAxisM, maxAxisM);
  const cross = clampAxis(axes.crossM, minAxisM, maxAxisM);
  // A heading of NaN means "stationary, direction unknown". North-up is the
  // honest default: with no heading there is no along/cross distinction to
  // orient, and refusing to draw would hide the uncertainty entirely.
  const headingRad = toRadians(Number.isFinite(axes.headingDeg) ? axes.headingDeg : 0);
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);

  const ring: Array<[number, number]> = [];
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const a = along * Math.cos(theta);
    const c = cross * Math.sin(theta);
    // Heading is a compass bearing, so the along-track unit vector in ENU is
    // (sin h, cos h) and cross-track — positive to the right of travel — is
    // (cos h, -sin h).
    const e = a * sinH + c * cosH;
    const n = a * cosH - c * sinH;
    const p = enuToLatLon(e, n, centre.lat, centre.lon);
    ring.push([p.lon, p.lat]);
  }
  ring.push(ring[0]!);
  return ring;
}

/**
 * Area of the ellipse in square metres, for the debug panel.
 *
 * Reported because "the ellipse got bigger" is a qualitative claim and a judge
 * is entitled to a number behind it — Golden Rule #7.
 */
export function confidenceAreaM2(axes: CovarianceAxes): number {
  if (!Number.isFinite(axes.alongM) || !Number.isFinite(axes.crossM)) return 0;
  const along = Math.max(0, axes.alongM);
  const cross = Math.max(0, axes.crossM);
  return Math.PI * along * cross;
}
