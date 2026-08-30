import { describe, expect, it } from 'vitest';
import {
  buildConfidenceRing,
  confidenceAreaM2,
  DEFAULT_ELLIPSE_OPTIONS,
  haversineDistance,
  normalizeAngle,
} from '../src/index.js';

/**
 * The confidence ellipse.
 *
 * This shape is a claim about how wrong the system might be, drawn on top of
 * the map a judge is checking it against. A ring that is the right size but
 * rotated 90 degrees, or that quietly swaps along-track for cross-track, would
 * look entirely plausible on screen and be exactly backwards — so the geometry
 * is measured here in metres and bearings rather than trusted.
 */

const CENTRE = { lat: 28.6315, lon: 77.2167 };

/** Bearing from the centre to a ring vertex, degrees clockwise from north. */
function bearingTo(lat: number, lon: number): number {
  const phi1 = (CENTRE.lat * Math.PI) / 180;
  const phi2 = (lat * Math.PI) / 180;
  const dLambda = ((lon - CENTRE.lon) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function distanceTo(lat: number, lon: number): number {
  return haversineDistance(CENTRE.lat, CENTRE.lon, lat, lon);
}

describe('buildConfidenceRing', () => {
  it('closes the ring, as GeoJSON requires', () => {
    const ring = buildConfidenceRing(CENTRE, { alongM: 50, crossM: 20, headingDeg: 0 });
    expect(ring.length).toBe(DEFAULT_ELLIPSE_OPTIONS.segments + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('emits [lon, lat] order, not [lat, lon]', () => {
    const ring = buildConfidenceRing(CENTRE, { alongM: 30, crossM: 30, headingDeg: 0 });
    for (const [lon, lat] of ring) {
      expect(Math.abs(lon - CENTRE.lon)).toBeLessThan(0.01);
      expect(Math.abs(lat - CENTRE.lat)).toBeLessThan(0.01);
    }
  });

  it('puts the long axis along the heading, not across it', () => {
    // Heading east. Along-track error is 100 m, cross-track 10 m, so the ring
    // must reach ~100 m to the east and ~10 m to the north.
    const ring = buildConfidenceRing(CENTRE, { alongM: 100, crossM: 10, headingDeg: 90 });

    let east = { d: 0, err: Infinity };
    let north = { d: 0, err: Infinity };
    for (const [lon, lat] of ring) {
      const b = normalizeAngle(bearingTo(lat, lon));
      const d = distanceTo(lat, lon);
      if (Math.abs(normalizeAngle(b - 90)) < east.err) east = { d, err: Math.abs(normalizeAngle(b - 90)) };
      if (Math.abs(normalizeAngle(b - 0)) < north.err) north = { d, err: Math.abs(normalizeAngle(b - 0)) };
    }

    expect(east.d).toBeGreaterThan(95);
    expect(east.d).toBeLessThan(105);
    expect(north.d).toBeGreaterThan(8);
    expect(north.d).toBeLessThan(12);
  });

  it('rotates with heading rather than staying axis-aligned', () => {
    const northbound = buildConfidenceRing(CENTRE, {
      alongM: 200,
      crossM: 10,
      headingDeg: 0,
    });
    const eastbound = buildConfidenceRing(CENTRE, {
      alongM: 200,
      crossM: 10,
      headingDeg: 90,
    });

    const farthestBearing = (ring: Array<[number, number]>) => {
      let best = { b: 0, d: -1 };
      for (const [lon, lat] of ring) {
        const d = distanceTo(lat, lon);
        if (d > best.d) best = { b: normalizeAngle(bearingTo(lat, lon)), d };
      }
      return best.b;
    };

    // The major axis is symmetric, so the farthest vertex may be at either
    // end of it — an axis at bearing b is the same axis as one at b + 180.
    const axisOffset = (bearing: number, expected: number) =>
      Math.min(
        Math.abs(normalizeAngle(bearing - expected)),
        Math.abs(normalizeAngle(bearing - expected - 180)),
      );

    expect(axisOffset(farthestBearing(northbound), 0)).toBeLessThan(2);
    expect(axisOffset(farthestBearing(eastbound), 90)).toBeLessThan(2);
  });

  it('degenerates to a circle when along and cross are equal — the GNSS case', () => {
    const ring = buildConfidenceRing(CENTRE, { alongM: 25, crossM: 25, headingDeg: 137 });
    const radii = ring.map(([lon, lat]) => distanceTo(lat, lon));
    for (const r of radii) {
      expect(r).toBeGreaterThan(24.5);
      expect(r).toBeLessThan(25.5);
    }
  });

  it('grows the along axis without touching the cross axis — the outage signature', () => {
    const early = buildConfidenceRing(CENTRE, { alongM: 20, crossM: 8, headingDeg: 45 });
    const late = buildConfidenceRing(CENTRE, { alongM: 200, crossM: 8, headingDeg: 45 });

    const maxR = (ring: Array<[number, number]>) =>
      Math.max(...ring.map(([lon, lat]) => distanceTo(lat, lon)));
    const minR = (ring: Array<[number, number]>) =>
      Math.min(...ring.map(([lon, lat]) => distanceTo(lat, lon)));

    expect(maxR(late)).toBeGreaterThan(maxR(early) * 5);
    // Road snapping caps cross-track; the drawn shape must reflect that the
    // cap held rather than inflating both axes together.
    expect(Math.abs(minR(late) - minR(early))).toBeLessThan(0.5);
  });

  it('refuses a non-finite or out-of-range centre instead of drawing nonsense', () => {
    const axes = { alongM: 10, crossM: 10, headingDeg: 0 };
    expect(buildConfidenceRing({ lat: NaN, lon: 77 }, axes)).toEqual([]);
    expect(buildConfidenceRing({ lat: 28, lon: Infinity }, axes)).toEqual([]);
    expect(buildConfidenceRing({ lat: 91, lon: 77 }, axes)).toEqual([]);
    expect(buildConfidenceRing({ lat: 28, lon: 181 }, axes)).toEqual([]);
  });

  it('floors a zero or junk axis so the shape stays visible', () => {
    const ring = buildConfidenceRing(CENTRE, { alongM: 0, crossM: NaN, headingDeg: 0 });
    expect(ring.length).toBeGreaterThan(3);
    for (const [lon, lat] of ring) {
      const d = distanceTo(lat, lon);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(2);
    }
  });

  it('caps a runaway axis so a long outage cannot paint the whole viewport', () => {
    const ring = buildConfidenceRing(CENTRE, {
      alongM: 10_000_000,
      crossM: 5,
      headingDeg: 0,
    });
    const maxR = Math.max(...ring.map(([lon, lat]) => distanceTo(lat, lon)));
    expect(maxR).toBeLessThanOrEqual(DEFAULT_ELLIPSE_OPTIONS.maxAxisM * 1.01);
  });

  it('treats an unknown heading as north-up rather than dropping the shape', () => {
    const ring = buildConfidenceRing(CENTRE, { alongM: 40, crossM: 10, headingDeg: NaN });
    expect(ring.length).toBe(DEFAULT_ELLIPSE_OPTIONS.segments + 1);
    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lat)).toBe(true);
      expect(Number.isFinite(lon)).toBe(true);
    }
  });

  it('honours a custom segment count, with a floor that still forms a polygon', () => {
    expect(buildConfidenceRing(CENTRE, { alongM: 10, crossM: 10, headingDeg: 0 }, { segments: 8 }))
      .toHaveLength(9);
    expect(buildConfidenceRing(CENTRE, { alongM: 10, crossM: 10, headingDeg: 0 }, { segments: 1 }))
      .toHaveLength(4);
  });

  it('works at high latitude, where a naive degrees-per-metre scale falls apart', () => {
    const arctic = { lat: 78.2, lon: 15.6 };
    const ring = buildConfidenceRing(arctic, { alongM: 100, crossM: 100, headingDeg: 0 });
    for (const [lon, lat] of ring) {
      const d = haversineDistance(arctic.lat, arctic.lon, lat, lon);
      expect(d).toBeGreaterThan(99);
      expect(d).toBeLessThan(101);
    }
  });
});

describe('confidenceAreaM2', () => {
  it('is pi*a*b', () => {
    expect(confidenceAreaM2({ alongM: 10, crossM: 5, headingDeg: 0 })).toBeCloseTo(
      Math.PI * 50,
      6,
    );
  });

  it('reports zero rather than NaN for junk input', () => {
    expect(confidenceAreaM2({ alongM: NaN, crossM: 5, headingDeg: 0 })).toBe(0);
    expect(confidenceAreaM2({ alongM: -10, crossM: 5, headingDeg: 0 })).toBe(0);
  });
});
