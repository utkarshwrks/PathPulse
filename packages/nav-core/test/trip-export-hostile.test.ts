import { describe, expect, it } from 'vitest';
import {
  buildGpx,
  buildTripGeoJson,
  DEFAULT_TRAIL_OPTIONS,
  type TrailPoint,
} from '../src/index.js';

/**
 * Phase 9F, assumed broken.
 *
 * The format tests check that a well-formed file comes out of well-formed
 * input. These check the shapes the app will actually hand it after twenty
 * minutes of driving — which is not the five tidy points a fixture provides.
 */

const EPOCH = Date.UTC(2026, 7, 30, 9, 15, 0);

function longDrive(points: number, startT = 0): TrailPoint[] {
  const out: TrailPoint[] = [];
  for (let i = 0; i < points; i++) {
    out.push({
      lat: 23.18 + i * 0.0001,
      lon: 79.98 + i * 0.0001,
      mode: i % 50 < 40 ? 'GNSS' : 'DEAD_RECKONING',
      t: startT + i * 1000,
    });
  }
  return out;
}

describe('9F hostile — the two tracks must cover the same drive', () => {
  it('★ does not pair a short estimate with a much longer GNSS reference', () => {
    // THE MISMATCH THAT MATTERS. The on-screen trail is a ring buffer capped
    // at 500 points; the GNSS reference buffer holds 5000 fixes. On a long
    // session the estimate covers the last few minutes while the reference
    // covers the whole hour — so the exported file shows a long GNSS track
    // beside a short estimate, which reads as the estimator having given up
    // rather than as two buffers of different sizes.
    // One drive, an hour long. The reference has all of it; the estimate's
    // ring buffer has only the last two minutes — and the last two minutes are
    // geographically at the FAR END, which is the whole point.
    const reference = Array.from({ length: 3700 }, (_, i) => ({
      lat: 23.18 + i * 0.0001,
      lon: 79.98 + i * 0.0001,
      t: i * 1000,
    }));
    const estimated: TrailPoint[] = reference.slice(-120).map((p, i) => ({
      lat: p.lat,
      lon: p.lon,
      mode: i % 50 < 40 ? 'GNSS' : 'DEAD_RECKONING',
      t: p.t,
    }));

    const gj = buildTripGeoJson({ estimated, reference, startedAtEpochMs: EPOCH });
    const gnss = gj.features.find((f) => f.properties.track === 'gnss');
    expect(gnss).toBeDefined();

    // The reference must be confined to the window the estimate covers.
    const lons = gnss!.geometry.coordinates.map(([lon]) => lon);
    const estLons = gj.features
      .filter((f) => f.properties.track === 'estimate')
      .flatMap((f) => f.geometry.coordinates.map(([lon]) => lon));
    expect(Math.min(...lons)).toBeGreaterThanOrEqual(Math.min(...estLons) - 0.01);
  });

  it('keeps the whole reference when the estimate spans the whole session', () => {
    const estimated = longDrive(100);
    const reference = Array.from({ length: 100 }, (_, i) => ({
      lat: 23.18 + i * 0.0001,
      lon: 79.98 + i * 0.0001,
      t: i * 1000,
    }));
    const gj = buildTripGeoJson({ estimated, reference, startedAtEpochMs: EPOCH });
    const gnss = gj.features.find((f) => f.properties.track === 'gnss');
    expect(gnss!.geometry.coordinates).toHaveLength(100);
  });

  it('still emits the reference when there is no estimate to align to', () => {
    const reference = [
      { lat: 23.18, lon: 79.98, t: 0 },
      { lat: 23.19, lon: 79.99, t: 1000 },
    ];
    expect(buildGpx({ estimated: [], reference })).toContain('GNSS reference');
  });
});

describe('9F hostile — realistic volume', () => {
  it('handles a full trail buffer without producing anything malformed', () => {
    const estimated = longDrive(DEFAULT_TRAIL_OPTIONS.maxPoints);
    const gpx = buildGpx({ estimated, startedAtEpochMs: EPOCH });
    expect(gpx).not.toContain('NaN');
    expect(gpx).not.toContain('undefined');
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
    const opens = (gpx.match(/<trk>/g) ?? []).length;
    const closes = (gpx.match(/<\/trk>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('closes every element it opens, at volume', () => {
    const gpx = buildGpx({
      estimated: longDrive(400),
      reference: Array.from({ length: 400 }, (_, i) => ({
        lat: 23.18 + i * 0.0001,
        lon: 79.98 + i * 0.0001,
        t: i * 1000,
      })),
      startedAtEpochMs: EPOCH,
    });
    for (const tag of ['trk', 'trkseg', 'metadata', 'name']) {
      const opens = (gpx.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
      const closes = (gpx.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(opens, tag).toBe(closes);
    }
  });
});

describe('9F hostile — content that could break the document', () => {
  it('survives a description containing markup and unicode', () => {
    const gpx = buildGpx({
      estimated: longDrive(4),
      description: 'Jabalpur ⟶ <script>alert(1)</script> & “quotes” — ०१२',
    });
    expect(gpx).not.toContain('<script>');
    expect(gpx).toContain('&lt;script&gt;');
    expect(gpx).toContain('⟶');
  });

  it('★ never lets an em dash or unicode out of the XML declaration’s encoding', () => {
    // The track names contain a literal em dash. Declaring UTF-8 and emitting
    // it is correct; the failure mode would be declaring something else.
    const gpx = buildGpx({ estimated: longDrive(4) });
    expect(gpx).toContain('encoding="UTF-8"');
    expect(gpx).toContain('PathPulse estimate —');
  });

  it('handles a reference with non-finite entries', () => {
    const gpx = buildGpx({
      estimated: longDrive(4),
      reference: [
        { lat: 23.18, lon: 79.98, t: 0 },
        { lat: NaN, lon: 79.98, t: 1000 },
        { lat: 23.19, lon: 79.99, t: 2000 },
      ],
    });
    expect(gpx).not.toContain('NaN');
  });

  it('does not throw on a trail whose points are all invalid', () => {
    const junk: TrailPoint[] = [
      { lat: NaN, lon: NaN, mode: 'GNSS', t: 0 },
      { lat: 999, lon: 999, mode: 'GNSS', t: 1000 },
    ];
    expect(() => buildGpx({ estimated: junk })).not.toThrow();
    expect(buildTripGeoJson({ estimated: junk }).features).toEqual([]);
  });
});
