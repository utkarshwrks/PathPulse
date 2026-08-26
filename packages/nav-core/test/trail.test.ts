import { describe, expect, it } from 'vitest';
import {
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
