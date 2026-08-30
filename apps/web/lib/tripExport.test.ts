import { describe, expect, it } from 'vitest';
import { buildGpx, buildTripGeoJson, type TrailPoint } from '@pathpulse/nav-core';

/**
 * The exported GPX, parsed as real XML.
 *
 * nav-core tests assert the format string by string, which cannot catch a
 * document that is subtly not well-formed — an unbalanced tag deep in a long
 * file, or an unescaped character in a name. jsdom has a real DOMParser, so
 * this asserts the thing that actually matters: a viewer can open it.
 */

function trail(n: number): TrailPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 23.18 + i * 0.0001,
    lon: 79.98 + i * 0.0001,
    mode: (i % 20 < 15 ? 'GNSS' : 'DEAD_RECKONING') as TrailPoint['mode'],
    t: i * 1000,
  }));
}

const REFERENCE = Array.from({ length: 60 }, (_, i) => ({
  lat: 23.18 + i * 0.0001,
  lon: 79.98 + i * 0.0001,
  t: i * 1000,
}));

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`not well-formed: ${error.textContent}`);
  return doc;
}

describe('exported GPX parses as XML', () => {
  it('★ a realistic trip is well-formed', () => {
    const doc = parse(
      buildGpx({ estimated: trail(500), reference: REFERENCE, startedAtEpochMs: Date.now() }),
    );
    expect(doc.documentElement.nodeName).toBe('gpx');
    expect(doc.documentElement.getAttribute('version')).toBe('1.1');
  });

  it('an empty trip is still well-formed', () => {
    const doc = parse(buildGpx({ estimated: [] }));
    expect(doc.documentElement.nodeName).toBe('gpx');
  });

  it('★ a description full of markup cannot break the document', () => {
    // If escaping were wrong this throws rather than quietly producing a file
    // that fails to open on someone else's machine.
    const doc = parse(
      buildGpx({
        estimated: trail(10),
        description: '</gpx><script>alert(1)</script> & "x" \'y\' <trk>',
      }),
    );
    expect(doc.getElementsByTagName('trk').length).toBe(1);
    expect(doc.getElementsByTagName('script').length).toBe(0);
  });

  it('every trkpt carries a numeric lat and lon inside range', () => {
    const doc = parse(buildGpx({ estimated: trail(200), reference: REFERENCE }));
    const points = Array.from(doc.getElementsByTagName('trkpt'));
    expect(points.length).toBeGreaterThan(100);
    for (const p of points) {
      const lat = Number(p.getAttribute('lat'));
      const lon = Number(p.getAttribute('lon'));
      expect(Number.isFinite(lat)).toBe(true);
      expect(Number.isFinite(lon)).toBe(true);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    }
  });

  it('names every track, including the reference', () => {
    const doc = parse(buildGpx({ estimated: trail(60), reference: REFERENCE }));
    const names = Array.from(doc.getElementsByTagName('trk')).map(
      (t) => t.getElementsByTagName('name')[0]?.textContent ?? '',
    );
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(names).toContain('GNSS reference');
    expect(names.some((n) => n.includes('DEAD RECKONING'))).toBe(true);
  });
});

describe('exported GeoJSON round-trips', () => {
  it('★ survives stringify and parse with no NaN or undefined', () => {
    const text = JSON.stringify(
      buildTripGeoJson({ estimated: trail(500), reference: REFERENCE, startedAtEpochMs: 0 }),
    );
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    const back = JSON.parse(text) as ReturnType<typeof buildTripGeoJson>;
    expect(back.type).toBe('FeatureCollection');
    for (const f of back.features) {
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      for (const [lon, lat] of f.geometry.coordinates) {
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      }
    }
  });
});
