import { enuToLatLon, latLonToEnu, normalizeAngle360, type LatLon } from '@pathpulse/nav-core';

/** A GeoJSON LineString Feature, as stored in data/routes/. */
export interface RouteGeoJson {
  type: 'Feature';
  properties?: { name?: string; description?: string; stopsAtFraction?: number[] };
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
}

interface Vertex {
  e: number;
  n: number;
  /** Cumulative arc length from the start, metres. */
  s: number;
}

/**
 * A driveable polyline in a local ENU plane.
 *
 * Everything is computed in metres about the route's first point, because the
 * vehicle model integrates m/s and doing that in degrees would drag a
 * latitude-dependent scale factor through every step.
 */
export class RoutePath {
  readonly refLat: number;
  readonly refLon: number;
  readonly name: string;
  private readonly verts: Vertex[];

  /**
   * Heading is measured over a window this wide rather than per-segment.
   * A polyline turns instantaneously, which would imply infinite yaw rate; a
   * lookahead window rounds the corner into a turn a real vehicle could make,
   * and gives the gyroscope a finite, realistic angular rate.
   */
  private readonly headingWindowM = 14;

  constructor(route: RouteGeoJson) {
    const coords = route.geometry.coordinates;
    if (coords.length < 2) throw new Error('Route needs at least two coordinates');

    const [lon0, lat0] = coords[0]!;
    this.refLat = lat0;
    this.refLon = lon0;
    this.name = route.properties?.name ?? 'route';

    this.verts = [];
    let s = 0;
    for (let i = 0; i < coords.length; i++) {
      const [lon, lat] = coords[i]!;
      const { e, n } = latLonToEnu(lat, lon, lat0, lon0);
      if (i > 0) {
        const prev = this.verts[i - 1]!;
        s += Math.hypot(e - prev.e, n - prev.n);
      }
      this.verts.push({ e, n, s });
    }
  }

  get lengthM(): number {
    return this.verts[this.verts.length - 1]!.s;
  }

  /** ENU point at arc length `s`, clamped to the route. */
  pointAt(s: number): { e: number; n: number } {
    const clamped = Math.max(0, Math.min(this.lengthM, s));
    const i = this.segmentIndexFor(clamped);
    const a = this.verts[i]!;
    const b = this.verts[i + 1]!;
    const segLen = b.s - a.s;
    const t = segLen > 0 ? (clamped - a.s) / segLen : 0;
    return { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t };
  }

  latLonAt(s: number): LatLon {
    const { e, n } = this.pointAt(s);
    const { lat, lon } = enuToLatLon(e, n, this.refLat, this.refLon);
    return { lat, lon };
  }

  /**
   * Compass heading in degrees [0, 360) at arc length `s`, smoothed over the
   * heading window so corners produce a survivable yaw rate.
   */
  headingAt(s: number): number {
    const half = this.headingWindowM / 2;
    const back = this.pointAt(s - half);
    const fwd = this.pointAt(s + half);
    const de = fwd.e - back.e;
    const dn = fwd.n - back.n;
    if (Math.abs(de) < 1e-9 && Math.abs(dn) < 1e-9) return this.rawHeadingAt(s);
    // atan2(east, north) gives a compass bearing, not a math angle.
    return normalizeAngle360((Math.atan2(de, dn) * 180) / Math.PI);
  }

  /** Unsmoothed segment bearing, used as a fallback at degenerate points. */
  private rawHeadingAt(s: number): number {
    const i = this.segmentIndexFor(Math.max(0, Math.min(this.lengthM, s)));
    const a = this.verts[i]!;
    const b = this.verts[i + 1]!;
    return normalizeAngle360((Math.atan2(b.e - a.e, b.n - a.n) * 180) / Math.PI);
  }

  private segmentIndexFor(s: number): number {
    // Linear scan is fine: routes are tens of vertices, not thousands.
    for (let i = 0; i < this.verts.length - 1; i++) {
      if (s <= this.verts[i + 1]!.s) return i;
    }
    return this.verts.length - 2;
  }
}
