import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAIL_SMOOTH_HALF_WINDOW,
  appendTrailPoint,
  buildTrailSegments,
  trailDistanceM,
  type TrailPoint,
} from '../src/index.js';

const CP = { lat: 28.6315, lon: 77.2167 };

/** Build a point roughly `metres` north of Connaught Place. */
function north(metres: number, mode: TrailPoint['mode'] = 'GNSS', t = 0): TrailPoint {
  return { lat: CP.lat + metres / 111_132, lon: CP.lon, mode, t };
}

describe('appendTrailPoint', () => {
  it('keeps points that are far enough apart', () => {
    let trail: TrailPoint[] = [];
    trail = appendTrailPoint(trail, north(0));
    trail = appendTrailPoint(trail, north(10));
    trail = appendTrailPoint(trail, north(20));
    expect(trail).toHaveLength(3);
  });

  it('filters out stationary jitter below the separation threshold', () => {
    let trail: TrailPoint[] = [north(0)];
    // 10 cm of wobble, well under the 0.5 m default.
    for (let i = 0; i < 20; i++) trail = appendTrailPoint(trail, north(0.1 * (i % 2)));
    expect(trail).toHaveLength(1);
  });

  it('always keeps a point when the mode changes, however small the move', () => {
    // This is the guard that stops the trail recolouring at the wrong place.
    let trail: TrailPoint[] = [north(0, 'GNSS')];
    trail = appendTrailPoint(trail, north(0.01, 'DEAD_RECKONING'));
    expect(trail).toHaveLength(2);
    expect(trail[1]!.mode).toBe('DEAD_RECKONING');
  });

  it('caps the buffer and drops the oldest points', () => {
    let trail: TrailPoint[] = [];
    for (let i = 0; i < 600; i++) trail = appendTrailPoint(trail, north(i * 5), { maxPoints: 500 });
    expect(trail).toHaveLength(500);
    // The survivors are the most recent ones.
    expect(trail[0]!.lat).toBeGreaterThan(north(400).lat);
  });

  it('never mutates the input array', () => {
    const original: TrailPoint[] = [north(0)];
    const frozen = Object.freeze([...original]);
    const next = appendTrailPoint(frozen, north(10));
    expect(frozen).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it('rejects non-finite coordinates instead of poisoning the trail', () => {
    const trail = appendTrailPoint([north(0)], { lat: NaN, lon: 77, mode: 'GNSS', t: 1 });
    expect(trail).toHaveLength(1);
  });
});

describe('buildTrailSegments', () => {
  it('returns nothing for an empty trail', () => {
    expect(buildTrailSegments([])).toEqual([]);
  });

  it('drops a single point — one vertex is not a line', () => {
    expect(buildTrailSegments([north(0)])).toEqual([]);
  });

  it('produces one segment when the mode never changes', () => {
    const segs = buildTrailSegments([north(0), north(10), north(20)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.mode).toBe('GNSS');
    expect(segs[0]!.coordinates).toHaveLength(3);
  });

  it('splits on mode change and shares the boundary vertex', () => {
    const trail = [
      north(0, 'GNSS'),
      north(10, 'GNSS'),
      north(20, 'DEAD_RECKONING'),
      north(30, 'DEAD_RECKONING'),
    ];
    const segs = buildTrailSegments(trail);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.mode).toBe('GNSS');
    expect(segs[1]!.mode).toBe('DEAD_RECKONING');

    // The shared vertex: last of segment 0 === first of segment 1.
    // Without this the rendered line has a gap exactly at the mode change.
    expect(segs[0]!.coordinates.at(-1)).toEqual(segs[1]!.coordinates[0]);
  });

  it('handles the full GNSS -> DR -> RECOVERING -> GNSS demo sequence', () => {
    const trail: TrailPoint[] = [
      north(0, 'GNSS'),
      north(10, 'GNSS'),
      north(20, 'DEAD_RECKONING'),
      north(30, 'DEAD_RECKONING'),
      north(40, 'RECOVERING'),
      north(50, 'GNSS'),
      north(60, 'GNSS'),
    ];
    const segs = buildTrailSegments(trail);
    expect(segs.map((s) => s.mode)).toEqual([
      'GNSS',
      'DEAD_RECKONING',
      'RECOVERING',
      'GNSS',
    ]);
    // Every boundary is joined.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i - 1]!.coordinates.at(-1)).toEqual(segs[i]!.coordinates[0]);
    }
  });

  it('emits GeoJSON [lon, lat] order, not [lat, lon]', () => {
    const segs = buildTrailSegments([north(0), north(10)]);
    const [lon, lat] = segs[0]!.coordinates[0]!;
    expect(lon).toBeCloseTo(CP.lon, 6);
    expect(lat).toBeCloseTo(CP.lat, 4);
  });
});

describe('trailDistanceM', () => {
  it('is zero for fewer than two points', () => {
    expect(trailDistanceM([])).toBe(0);
    expect(trailDistanceM([north(0)])).toBe(0);
  });

  it('sums leg lengths', () => {
    const d = trailDistanceM([north(0), north(100), north(200)]);
    expect(d).toBeGreaterThan(195);
    expect(d).toBeLessThan(205);
  });
});

describe('buildTrailSegments — smoothing the drawn line', () => {
  /**
   * A straight run north with a repeatable lateral wobble on it.
   *
   * Deterministic rather than random: the property under test is "the drawn
   * line is shorter than the wobble made it", and a seeded-random fixture that
   * happened to wobble mildly would pass a broken smoother.
   */
  function wobblyLine(n: number, amplitudeM: number, mode: TrailPoint['mode'] = 'GNSS') {
    const pts: TrailPoint[] = [];
    for (let i = 0; i < n; i++) {
      // Alternating sign, so consecutive vertices sit on opposite sides of the
      // true line — the saw-tooth the field report describes.
      const off = (i % 2 === 0 ? 1 : -1) * amplitudeM;
      pts.push({
        lat: CP.lat + (i * 1.4) / 111_132,
        lon: CP.lon + off / (111_320 * Math.cos((CP.lat * Math.PI) / 180)),
        mode,
        t: i * 100,
      });
    }
    return pts;
  }

  function drawnLengthM(coords: Array<[number, number]>): number {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const dx =
        (coords[i]![0] - coords[i - 1]![0]) * 111_320 * Math.cos((CP.lat * Math.PI) / 180);
      const dy = (coords[i]![1] - coords[i - 1]![1]) * 110_574;
      total += Math.hypot(dx, dy);
    }
    return total;
  }

  it('★ shortens a saw-tooth toward the line it is wobbling about', () => {
    // The whole complaint, as a number: "the green line fluctuate a lot ...
    // it again becomes messy". Measured on the city route the drawn line was
    // 49% longer than the road; here the fixture is deliberately worse.
    const trail = wobblyLine(60, 0.9);
    const raw = buildTrailSegments(trail)[0]!;
    const smooth = buildTrailSegments(trail, {
      smoothHalfWindow: DEFAULT_TRAIL_SMOOTH_HALF_WINDOW,
    })[0]!;
    expect(drawnLengthM(smooth.coordinates)).toBeLessThan(drawnLengthM(raw.coordinates) * 0.7);
  });

  it('★ never moves the newest vertex, or the line stops short of the marker', () => {
    // A trailing average of the same width is just as smooth and lags 5.2 m at
    // city speed — twenty pixels of gap between the end of the trail and the
    // dot, which reads as a bug. The centred window shrinks at the ends
    // instead, so the last vertex is exact.
    const trail = wobblyLine(40, 1.5);
    const seg = buildTrailSegments(trail, { smoothHalfWindow: 4 })[0]!;
    const last = seg.coordinates[seg.coordinates.length - 1]!;
    expect(last[0]).toBe(trail[trail.length - 1]!.lon);
    expect(last[1]).toBe(trail[trail.length - 1]!.lat);
  });

  it('keeps the first vertex exact too', () => {
    const trail = wobblyLine(40, 1.5);
    const seg = buildTrailSegments(trail, { smoothHalfWindow: 4 })[0]!;
    expect(seg.coordinates[0]![0]).toBe(trail[0]!.lon);
    expect(seg.coordinates[0]![1]).toBe(trail[0]!.lat);
  });

  it('★ does not average across a mode change, which would smear the badge flip', () => {
    // The GNSS-to-dead-reckoning junction is the single most looked-at point
    // on the screen. Averaging across it would drag the last green vertex into
    // the orange run and put the colour change somewhere the mode did not
    // actually change.
    const before = wobblyLine(20, 1.2, 'GNSS');
    const after = wobblyLine(20, 1.2, 'DEAD_RECKONING').map((p, i) => ({
      ...p,
      lat: CP.lat + ((20 + i) * 1.4) / 111_132,
      t: (20 + i) * 100,
    }));
    const segs = buildTrailSegments([...before, ...after], { smoothHalfWindow: 4 });
    expect(segs).toHaveLength(2);
    // The shared junction vertex is drawn at one place in both segments.
    const endOfFirst = segs[0]!.coordinates[segs[0]!.coordinates.length - 1]!;
    const startOfSecond = segs[1]!.coordinates[0]!;
    expect(endOfFirst[0]).toBeCloseTo(startOfSecond[0], 9);
    expect(endOfFirst[1]).toBeCloseTo(startOfSecond[1], 9);
    // And it is the real junction point, not an average pulled across it.
    expect(startOfSecond[1]).toBe(after[0]!.lat);
  });

  it('draws the raw buffer when smoothing is off, which is the default', () => {
    const trail = wobblyLine(20, 1.0);
    const seg = buildTrailSegments(trail)[0]!;
    seg.coordinates.forEach((c, i) => {
      expect(c[0]).toBe(trail[i]!.lon);
      expect(c[1]).toBe(trail[i]!.lat);
    });
  });

  it('★ leaves the buffer untouched — the export is a record, not a picture', () => {
    const trail = wobblyLine(30, 1.0);
    const snapshot = JSON.stringify(trail);
    buildTrailSegments(trail, { smoothHalfWindow: 4 });
    expect(JSON.stringify(trail)).toBe(snapshot);
  });

  it('keeps a real corner, rather than rounding it away', () => {
    // A smoother that also removed turns would be trading one wrong picture
    // for another. Ninety degrees must survive as most of ninety degrees.
    const trail: TrailPoint[] = [];
    for (let i = 0; i < 25; i++) {
      trail.push({ lat: CP.lat + (i * 3) / 111_132, lon: CP.lon, mode: 'GNSS', t: i * 100 });
    }
    const cornerLat = CP.lat + (24 * 3) / 111_132;
    for (let i = 1; i <= 25; i++) {
      trail.push({
        lat: cornerLat,
        lon: CP.lon + (i * 3) / (111_320 * Math.cos((CP.lat * Math.PI) / 180)),
        mode: 'GNSS',
        t: (24 + i) * 100,
      });
    }
    const seg = buildTrailSegments(trail, { smoothHalfWindow: 4 })[0]!;
    const bearing = (a: [number, number], b: [number, number]) =>
      (Math.atan2(
        (b[0] - a[0]) * Math.cos((CP.lat * Math.PI) / 180),
        b[1] - a[1],
      ) *
        180) /
      Math.PI;
    const first = bearing(seg.coordinates[0]!, seg.coordinates[3]!);
    const last = bearing(
      seg.coordinates[seg.coordinates.length - 4]!,
      seg.coordinates[seg.coordinates.length - 1]!,
    );
    expect(Math.abs(last - first)).toBeGreaterThan(80);
  });
});
