import type { LatLon, NavMode } from '../types.js';
import { haversineDistance } from '../geo/distance.js';

/**
 * Travelled-path buffer.
 *
 * Pure data transformation — no map library, no browser types — so the
 * segment-splitting rules below are unit tested rather than eyeballed on a map.
 */

export interface TrailPoint extends LatLon {
  mode: NavMode;
  t: number;
}

/** A run of consecutive points sharing one mode, ready to render as a line. */
export interface TrailSegment {
  mode: NavMode;
  /** GeoJSON order: [lon, lat]. */
  coordinates: Array<[number, number]>;
}

export interface TrailOptions {
  /** Ring-buffer cap. Older points are dropped. */
  maxPoints: number;
  /**
   * Minimum movement before a point is kept. A phone sitting still still
   * reports jitter, which would otherwise fill the buffer with noise and
   * push out real history.
   */
  minSeparationM: number;
}

export const DEFAULT_TRAIL_OPTIONS: TrailOptions = {
  maxPoints: 500,
  minSeparationM: 0.5,
};

/**
 * Append a point, honouring the separation filter and the ring-buffer cap.
 * Returns a new array; the input is never mutated.
 *
 * A mode change always forces the point to be kept even if the vehicle has
 * barely moved — otherwise the exact sample where GNSS dropped could be
 * filtered out and the trail would recolour at the wrong place.
 */
export function appendTrailPoint(
  trail: readonly TrailPoint[],
  point: TrailPoint,
  options: Partial<TrailOptions> = {},
): TrailPoint[] {
  const { maxPoints, minSeparationM } = { ...DEFAULT_TRAIL_OPTIONS, ...options };

  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [...trail];

  const last = trail[trail.length - 1];
  if (last) {
    const movedM = haversineDistance(last.lat, last.lon, point.lat, point.lon);
    const modeChanged = last.mode !== point.mode;
    if (!modeChanged && movedM < minSeparationM) return [...trail];
  }

  const next = [...trail, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

/**
 * Split the trail into per-mode segments.
 *
 * Segments overlap by one vertex on purpose: the point where the mode changes
 * is the last vertex of the old segment AND the first of the new one. Without
 * that shared vertex the rendered line shows a visible gap at every mode
 * change — precisely the moment a judge is looking at.
 */
export function buildTrailSegments(trail: readonly TrailPoint[]): TrailSegment[] {
  if (trail.length === 0) return [];

  const segments: TrailSegment[] = [];
  let current: TrailSegment | undefined;

  for (const p of trail) {
    const coord: [number, number] = [p.lon, p.lat];
    if (!current || current.mode !== p.mode) {
      if (current) {
        // Close the old segment on the new point so the line stays joined.
        current.coordinates.push(coord);
      }
      current = { mode: p.mode, coordinates: [coord] };
      segments.push(current);
    } else {
      current.coordinates.push(coord);
    }
  }

  // A lone point is not a line; MapLibre would silently drop it anyway.
  return segments.filter((s) => s.coordinates.length >= 2);
}

/** Total ground distance covered by the buffered trail, in metres. */
export function trailDistanceM(trail: readonly TrailPoint[]): number {
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    total += haversineDistance(a.lat, a.lon, b.lat, b.lon);
  }
  return total;
}
