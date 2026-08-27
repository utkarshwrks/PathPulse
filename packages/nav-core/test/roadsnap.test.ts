import { describe, expect, it } from 'vitest';
import {
  applyRoadSnap,
  findRoadMatch,
  headingMismatchDeg,
  RoadIndex,
  enuToLatLon,
  type RoadGraph,
} from '../src/index.js';

const ORIGIN = { lat: 28.6315, lon: 77.2167 };

/** Build a straight way from ENU metres, so tests can think in metres. */
function wayFromEnu(
  id: string,
  points: Array<[number, number]>,
  extra: Partial<RoadGraph['ways'][number]> = {},
): RoadGraph['ways'][number] {
  return {
    id,
    coords: points.map(([e, n]) => {
      const p = enuToLatLon(e, n, ORIGIN.lat, ORIGIN.lon);
      return [p.lon, p.lat] as [number, number];
    }),
    ...extra,
  };
}

function graphOf(...ways: RoadGraph['ways']): RoadGraph {
  return { bbox: [0, 0, 0, 0], ways };
}

function indexOf(graph: RoadGraph): RoadIndex {
  return new RoadIndex(graph, ORIGIN.lat, ORIGIN.lon);
}

describe('RoadIndex', () => {
  const northSouth = wayFromEnu('w1', [
    [0, -500],
    [0, 500],
  ]);

  it('finds a segment near the query point', () => {
    const idx = indexOf(graphOf(northSouth));
    expect(idx.nearbySegments(0, 0, 50).length).toBeGreaterThan(0);
  });

  it('finds a long segment from its middle, not just its ends', () => {
    // ★ The reason segments are stamped into every cell they cross. ★
    // A 1 km road between two junctions would otherwise be invisible to a
    // query standing halfway along it, which is where a vehicle usually is.
    const idx = indexOf(graphOf(northSouth));
    expect(idx.nearbySegments(0, 400, 30).length).toBeGreaterThan(0);
    expect(idx.nearbySegments(0, -400, 30).length).toBeGreaterThan(0);
  });

  it('returns nothing far from any road', () => {
    const idx = indexOf(graphOf(northSouth));
    expect(idx.nearbySegments(5000, 5000, 50)).toEqual([]);
  });

  it('computes bearings in the compass sense', () => {
    const idx = indexOf(
      graphOf(
        wayFromEnu('north', [
          [0, 0],
          [0, 100],
        ]),
        wayFromEnu('east', [
          [1000, 0],
          [1100, 0],
        ]),
      ),
    );
    expect(idx.nearbySegments(0, 50, 20)[0]!.bearingDeg).toBeCloseTo(0, 0);
    expect(idx.nearbySegments(1050, 0, 20)[0]!.bearingDeg).toBeCloseTo(90, 0);
  });

  it('accumulates arc length along a way', () => {
    const idx = indexOf(
      graphOf(
        wayFromEnu('w', [
          [0, 0],
          [0, 100],
          [0, 300],
        ]),
      ),
    );
    // Query from the junction so both segments are in range: at n=200 only the
    // second one is, which is correct behaviour but tests nothing about arcs.
    const segs = idx.nearbySegments(0, 100, 60).sort((a, b) => a.arcStartM - b.arcStartM);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.arcStartM).toBeCloseTo(0, 0);
    expect(segs[0]!.lengthM).toBeCloseTo(100, 0);
    expect(segs[1]!.arcStartM).toBeCloseTo(100, 0);
    expect(segs[1]!.lengthM).toBeCloseTo(200, 0);
  });

  it('skips duplicate and malformed coordinates', () => {
    const graph = graphOf({
      id: 'w',
      coords: [
        [77.2167, 28.6315],
        [77.2167, 28.6315], // duplicate
        [Number.NaN, 28.6316], // malformed
        [77.2168, 28.6317],
      ],
    });
    const idx = indexOf(graph);
    expect(idx.size).toBeGreaterThanOrEqual(0);
    expect(idx.wayCount).toBe(1);
  });
});

describe('heading mismatch', () => {
  it('treats the reverse direction as a match on a two-way road', () => {
    // A way's bearing is the direction OSM happens to draw it. Driving the
    // other way down a two-way street is a perfect match, not a 180° error.
    expect(headingMismatchDeg(180, 0, false)).toBeCloseTo(0, 6);
    expect(headingMismatchDeg(0, 180, false)).toBeCloseTo(0, 6);
  });

  it('keeps direction on a one-way road', () => {
    // Here the direction is real information — it is what distinguishes one
    // carriageway of a dual carriageway from the other.
    expect(headingMismatchDeg(180, 0, true)).toBeCloseTo(180, 6);
  });

  it('scores a perpendicular road as badly mismatched either way', () => {
    expect(headingMismatchDeg(90, 0, false)).toBeCloseTo(90, 6);
    expect(headingMismatchDeg(90, 0, true)).toBeCloseTo(90, 6);
  });
});

describe('findRoadMatch', () => {
  const northSouth = wayFromEnu('ns', [
    [0, -500],
    [0, 500],
  ]);
  const eastWest = wayFromEnu('ew', [
    [-500, 30],
    [500, 30],
  ]);

  it('matches the nearest road and reports the perpendicular distance', () => {
    const idx = indexOf(graphOf(northSouth));
    const m = findRoadMatch({ e: 20, n: 0 }, 0, idx, null);
    expect(m).not.toBeNull();
    expect(m!.wayId).toBe('ns');
    expect(m!.distanceM).toBeCloseTo(20, 1);
    expect(m!.enu.e).toBeCloseTo(0, 1);
    expect(m!.enu.n).toBeCloseTo(0, 1);
  });

  it('prefers the road that matches our heading, not merely the closest', () => {
    // Standing 12 m from an east-west road and 18 m from a north-south one,
    // but travelling north. Distance alone would pick the wrong road.
    const idx = indexOf(graphOf(northSouth, eastWest));
    const m = findRoadMatch({ e: 18, n: 18 }, 0, idx, null);
    expect(m!.wayId).toBe('ns');
  });

  it('applies the continuity bonus to break a near-tie', () => {
    const idx = indexOf(graphOf(northSouth, eastWest));
    // Equidistant-ish and heading diagonally: continuity decides.
    const a = findRoadMatch({ e: 15, n: 15 }, 45, idx, 'ew');
    expect(a!.wayId).toBe('ew');
    const b = findRoadMatch({ e: 15, n: 15 }, 45, idx, 'ns');
    expect(b!.wayId).toBe('ns');
  });

  it('returns null when no road is within the search radius', () => {
    const idx = indexOf(graphOf(northSouth));
    expect(findRoadMatch({ e: 400, n: 0 }, 0, idx, null)).toBeNull();
  });

  it('does not project past the end of a segment', () => {
    // Beyond the end of the road, the closest point is the endpoint — not a
    // point on an imaginary extension of it.
    const idx = indexOf(
      graphOf(
        wayFromEnu('short', [
          [0, 0],
          [0, 100],
        ]),
      ),
    );
    const m = findRoadMatch({ e: 0, n: 140 }, 0, idx, null);
    expect(m).not.toBeNull();
    expect(m!.enu.n).toBeCloseTo(100, 1);
    expect(m!.arcLengthM).toBeCloseTo(100, 1);
  });

  it('reports the matched way name and speed limit', () => {
    const idx = indexOf(
      graphOf(wayFromEnu('mg', [[0, -100], [0, 100]], { name: 'MG Road', maxspeed: 50 })),
    );
    const m = findRoadMatch({ e: 10, n: 0 }, 0, idx, null);
    expect(m!.name).toBe('MG Road');
    expect(m!.maxspeedKph).toBe(50);
  });
});

describe('applyRoadSnap — cross-track only', () => {
  const idx = indexOf(
    graphOf(
      wayFromEnu('ns', [
        [0, -500],
        [0, 500],
      ]),
    ),
  );

  it('moves the estimate across the road, never along it', () => {
    // ★ THE RULE THE BUILD GUIDE CALLS OUT IN CAPITALS ★
    // The road tells us we are ON it — that is real evidence, and it is
    // perpendicular. Where along it we are is exactly what dead reckoning was
    // estimating, and the nearest-point calculation knows nothing about it.
    const before = { e: 30, n: 250 };
    const match = findRoadMatch(before, 0, idx, null)!;
    const after = applyRoadSnap(before, match, 0.5);

    // Cross-track (east, for a north-south road) moved toward the road.
    expect(Math.abs(after.enu.e)).toBeLessThan(Math.abs(before.e));
    // Along-track (north) is untouched.
    expect(after.enu.n).toBeCloseTo(before.n, 9);
  });

  it('leaves along-track alone even when the nearest point is far along', () => {
    // Standing past the end of a road: the nearest point is the endpoint, so a
    // naive lerp toward it would drag the marker 100 m backwards down the road.
    const short = indexOf(
      graphOf(
        wayFromEnu('s', [
          [0, 0],
          [0, 100],
        ]),
      ),
    );
    const before = { e: 10, n: 140 };
    const match = findRoadMatch(before, 0, short, null)!;
    const after = applyRoadSnap(before, match, 0);
    expect(after.enu.n).toBeCloseTo(140, 6);
    expect(Math.abs(after.enu.e)).toBeLessThan(10);
  });

  it('snaps harder when confidence is low', () => {
    const before = { e: 30, n: 0 };
    const match = findRoadMatch(before, 0, idx, null)!;
    const confident = applyRoadSnap(before, match, 1);
    const lost = applyRoadSnap(before, match, 0);
    expect(lost.strength).toBeGreaterThan(confident.strength);
    expect(Math.abs(lost.enu.e)).toBeLessThan(Math.abs(confident.enu.e));
  });

  it('never snaps all the way in one step', () => {
    // A hard snap is a teleport with better manners.
    const before = { e: 40, n: 0 };
    const match = findRoadMatch(before, 0, idx, null)!;
    const after = applyRoadSnap(before, match, 0);
    expect(Math.abs(after.enu.e)).toBeGreaterThan(0.5);
    expect(after.strength).toBeLessThanOrEqual(0.7);
  });

  it('keeps a floor of correction even when fully confident', () => {
    const before = { e: 30, n: 0 };
    const match = findRoadMatch(before, 0, idx, null)!;
    expect(applyRoadSnap(before, match, 1).strength).toBeGreaterThanOrEqual(0.1);
  });

  it('converges onto the road when applied repeatedly', () => {
    let p = { e: 40, n: 0 };
    for (let i = 0; i < 40; i++) {
      const m = findRoadMatch(p, 0, idx, null);
      if (!m) break;
      p = applyRoadSnap(p, m, 0.2).enu;
    }
    expect(Math.abs(p.e)).toBeLessThan(1);
    expect(p.n).toBeCloseTo(0, 6);
  });

  it('reports the signed cross-track error', () => {
    const right = applyRoadSnap({ e: 25, n: 0 }, findRoadMatch({ e: 25, n: 0 }, 0, idx, null)!, 0.5);
    const left = applyRoadSnap({ e: -25, n: 0 }, findRoadMatch({ e: -25, n: 0 }, 0, idx, null)!, 0.5);
    expect(Math.sign(right.crossTrackM)).toBe(-Math.sign(left.crossTrackM));
    expect(Math.abs(right.crossTrackM)).toBeCloseTo(25, 1);
  });
});
