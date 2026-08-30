import { describe, expect, it } from 'vitest';
import {
  buildGpx,
  buildTripGeoJson,
  escapeXml,
  tripFileName,
  type TrailPoint,
} from '../src/index.js';

/**
 * Trip export.
 *
 * ★ THIS FILE IS OPENED ON SOMEONE ELSE'S MACHINE ★
 * Every other output in this project is checked while we are standing next to
 * it. A GPX is loaded into QGIS or BaseCamp days later, by someone with no
 * reason to be charitable, and a malformed one simply fails to open — there is
 * no recovering from that in the room, because we are not in the room. So the
 * format is asserted character by character rather than eyeballed once.
 */

const EPOCH = Date.UTC(2026, 7, 30, 9, 15, 0);

function trail(
  points: Array<[number, number, TrailPoint['mode'], number]>,
): TrailPoint[] {
  return points.map(([lat, lon, mode, t]) => ({ lat, lon, mode, t }));
}

const DRIVE = trail([
  [23.1815, 79.9864, 'GNSS', 0],
  [23.1820, 79.9870, 'GNSS', 1000],
  [23.1825, 79.9876, 'DEAD_RECKONING', 2000],
  [23.1830, 79.9882, 'DEAD_RECKONING', 3000],
  [23.1835, 79.9888, 'GNSS', 4000],
]);

const REFERENCE = [
  { lat: 23.1815, lon: 79.9864, t: 0 },
  { lat: 23.1821, lon: 79.9871, t: 1000 },
  { lat: 23.1836, lon: 79.9889, t: 4000 },
];

describe('escapeXml', () => {
  it('escapes everything that would break a document', () => {
    expect(escapeXml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });

  it('escapes the ampersand first, so escapes are not double-escaped', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('buildGpx', () => {
  const gpx = buildGpx({ estimated: DRIVE, reference: REFERENCE, startedAtEpochMs: EPOCH });

  it('declares itself as GPX 1.1 with the schema', () => {
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('version="1.1"');
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
  });

  it('★ carries the mode in the track name, not just in the data', () => {
    // The point of the export is that the inferred stretches are visibly
    // labelled as inferred, in a viewer that knows nothing about this project.
    expect(gpx).toContain('PathPulse estimate — DEAD RECKONING (2)');
    expect(gpx).toContain('PathPulse estimate — GNSS (1)');
  });

  it('★ emits the GNSS reference as its own track', () => {
    // Two tracks over the same drive is the whole comparison. One track proves
    // nothing at all.
    expect(gpx).toContain('<name>GNSS reference</name>');
  });

  it('splits the estimate at every mode change', () => {
    // GNSS, DEAD_RECKONING, GNSS = three tracks, plus the reference.
    expect(gpx.match(/<trk>/g)).toHaveLength(4);
  });

  it('★ shares a vertex at each mode change so the line is continuous', () => {
    // REVISED. The first version asserted the opposite — no shared vertex — on
    // the reasoning that a repeated fix overstates the distance. It does not:
    // the shared point ends one run and starts the next, so the segment
    // between them is counted once either way. What the overlap buys is a
    // trajectory with no gaps, and a broken line in QGIS reads as missing data.
    const points = gpx.match(/<trkpt /g) ?? [];
    // Two mode changes, so two vertices appear in two tracks each.
    expect(points).toHaveLength(DRIVE.length + 2 + REFERENCE.length);
  });

  it('writes coordinates as lat/lon attributes, six decimals', () => {
    expect(gpx).toContain('lat="23.181500" lon="79.986400"');
  });

  it('writes real ISO timestamps when the session epoch is known', () => {
    expect(gpx).toContain('<time>2026-08-30T09:15:00.000Z</time>');
    expect(gpx).toContain('<time>2026-08-30T09:15:04.000Z</time>');
  });

  it('★ omits times entirely rather than inventing an epoch', () => {
    // Sample timestamps are milliseconds since the source started. A GPX full
    // of times computed from a made-up origin is worse than one with none,
    // because a reader cannot tell which they are looking at.
    const noEpoch = buildGpx({ estimated: DRIVE });
    expect(noEpoch).not.toContain('<time>');
    expect(noEpoch).toContain('<trkpt lat="23.181500" lon="79.986400" />');
  });

  it('produces a valid document for an empty trip', () => {
    const empty = buildGpx({ estimated: [] });
    expect(empty).toContain('<gpx');
    expect(empty).toContain('</gpx>');
    expect(empty).not.toContain('<trk>');
  });

  it('omits the reference track when there are no fixes', () => {
    expect(buildGpx({ estimated: DRIVE })).not.toContain('GNSS reference');
  });

  it('★ drops non-finite and out-of-range points instead of writing NaN', () => {
    // A single lat="NaN" makes the whole file unopenable, and the failure
    // happens on the judge's machine with no context.
    const dirty = trail([
      [23.18, 79.98, 'GNSS', 0],
      [NaN, 79.98, 'GNSS', 1000],
      [23.18, Infinity, 'GNSS', 2000],
      [999, 79.98, 'GNSS', 3000],
      [23.19, 79.99, 'GNSS', 4000],
    ]);
    const out = buildGpx({ estimated: dirty, startedAtEpochMs: EPOCH });
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
    expect(out.match(/<trkpt /g)).toHaveLength(2);
  });

  it('escapes the description rather than letting it break the document', () => {
    const out = buildGpx({ estimated: DRIVE, description: 'Jabalpur <test> & "run"' });
    expect(out).toContain('Jabalpur &lt;test&gt; &amp; &quot;run&quot;');
    expect(out).not.toContain('<test>');
  });

  it('never emits a negative epoch as a time', () => {
    const out = buildGpx({ estimated: DRIVE, startedAtEpochMs: -1_000_000 });
    expect(out).not.toContain('<time>19');
  });
});

describe('buildTripGeoJson', () => {
  const gj = buildTripGeoJson({
    estimated: DRIVE,
    reference: REFERENCE,
    startedAtEpochMs: EPOCH,
  });

  it('is a FeatureCollection of LineStrings', () => {
    expect(gj.type).toBe('FeatureCollection');
    for (const f of gj.features) {
      expect(f.type).toBe('Feature');
      expect(f.geometry.type).toBe('LineString');
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ uses [lon, lat] order, as GeoJSON requires', () => {
    // Swapping these is the classic mistake, and it puts an Indian drive in
    // Somalia — plausible-looking right up to the moment someone opens it.
    const first = gj.features[0]!.geometry.coordinates[0]!;
    expect(first[0]).toBeCloseTo(79.9864, 4);
    expect(first[1]).toBeCloseTo(23.1815, 4);
  });

  it('tags every feature with its track, and the estimate with its mode', () => {
    const estimate = gj.features.filter((f) => f.properties.track === 'estimate');
    const gnss = gj.features.filter((f) => f.properties.track === 'gnss');
    // Two, not three: this fixture's final GNSS run is a single sample, and a
    // one-coordinate LineString is not a line. GPX keeps it as a lone trkpt,
    // which is valid there; GeoJSON drops it. The geometry is not lost either
    // way — the DEAD_RECKONING run closes ON that point.
    expect(estimate.length).toBe(2);
    // Each run's last point is the next run's first, so the drawn line joins.
    expect(estimate[0]!.geometry.coordinates.at(-1)).toEqual(
      estimate[1]!.geometry.coordinates[0],
    );
    expect(gnss.length).toBe(1);
    expect(estimate.map((f) => f.properties.mode)).toEqual(['GNSS', 'DEAD_RECKONING']);
  });

  it('★ a trailing one-sample run is kept by GPX and dropped by GeoJSON', () => {
    // Worth pinning rather than discovering later: the two formats disagree,
    // and they disagree correctly. GPX 1.1 allows a track with a single point;
    // a GeoJSON LineString needs two, and readers either reject a one-point
    // one or silently draw nothing. Neither loses the position, because the
    // previous run closes on it.
    const lastPoint = DRIVE[DRIVE.length - 1]!;
    expect(buildGpx({ estimated: DRIVE })).toContain(
      `lat="${lastPoint.lat.toFixed(6)}" lon="${lastPoint.lon.toFixed(6)}"`,
    );
    const coords = buildTripGeoJson({ estimated: DRIVE })
      .features.filter((f) => f.properties.track === 'estimate')
      .flatMap((f) => f.geometry.coordinates);
    expect(coords).toContainEqual([
      Number(lastPoint.lon.toFixed(6)),
      Number(lastPoint.lat.toFixed(6)),
    ]);
  });

  it('★ drops a single-point run rather than emitting an invalid LineString', () => {
    // A one-coordinate LineString is rejected outright by some readers and
    // silently drawn as nothing by others.
    const stutter = trail([
      [23.18, 79.98, 'GNSS', 0],
      [23.19, 79.99, 'DEAD_RECKONING', 1000],
      [23.20, 80.0, 'GNSS', 2000],
      [23.21, 80.01, 'GNSS', 3000],
    ]);
    const out = buildTripGeoJson({ estimated: stutter });
    for (const f of out.features) {
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
    // With the shared boundary vertex the one-sample DEAD_RECKONING stretch
    // reaches two coordinates and survives instead of vanishing.
    expect(out.features.map((f) => f.properties.mode)).toEqual([
      'GNSS',
      'DEAD_RECKONING',
      'GNSS',
    ]);
  });

  it('survives JSON.stringify without producing invalid JSON', () => {
    const text = JSON.stringify(gj);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('NaN');
  });

  it('returns an empty collection for an empty trip', () => {
    expect(buildTripGeoJson({ estimated: [] }).features).toEqual([]);
  });

  it('carries start and end times when the epoch is known, and not otherwise', () => {
    expect(gj.features[0]!.properties.startTime).toBe('2026-08-30T09:15:00.000Z');
    const noEpoch = buildTripGeoJson({ estimated: DRIVE });
    expect(noEpoch.features[0]!.properties.startTime).toBeUndefined();
  });
});

describe('tripFileName', () => {
  it('includes the session date and time', () => {
    expect(tripFileName(EPOCH)).toMatch(/^pathpulse_trip_20260830_\d{4}$/);
  });

  it('falls back to a plain name rather than a 1970 date', () => {
    expect(tripFileName()).toBe('pathpulse_trip');
    expect(tripFileName(NaN)).toBe('pathpulse_trip');
  });
});
