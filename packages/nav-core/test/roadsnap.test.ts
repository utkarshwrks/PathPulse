import { describe, expect, it } from 'vitest';
import {
  applyRoadSnap,
  canTrustSpeedLimit,
  DEFAULT_ROAD_SNAP_CONFIG,
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

  const shortRoad = () =>
    indexOf(
      graphOf(
        wayFromEnu('s', [
          [0, 0],
          [0, 100],
        ]),
      ),
    );

  it('BOUNDS the along-track correction past the end of a road, rather than forbidding it', () => {
    // ★ THE ONE EXCEPTION, AND WHY IT EXISTS ★
    //
    // Standing 40 m past the end of a 100 m road, the nearest point on it is
    // the endpoint, so the offset to that point is almost entirely ALONG the
    // road. The strict rule discarded that component — and therefore moved the
    // marker almost nowhere, leaving it drawn in a field off the end of a road
    // while the panel named the road it was not on. In the field measurement
    // that geometry accounted for every remaining off-road excursion.
    //
    // So the correction is capped, not banned: the map may nudge the marker
    // onto the end of a road, it may never carry it down one. The cap is what
    // preserves the original rule's purpose.
    const before = { e: 10, n: 140 };
    const match = findRoadMatch(before, 0, shortRoad(), null)!;
    const after = applyRoadSnap(before, match, 0);

    const alongMoved = Math.abs(after.enu.n - before.n);
    expect(alongMoved).toBeGreaterThan(0);
    expect(alongMoved).toBeLessThanOrEqual(DEFAULT_ROAD_SNAP_CONFIG.maxAlongCorrectionM + 1e-6);
    // And it moves TOWARD the road, never away down it.
    expect(after.enu.n).toBeLessThan(before.n);
    expect(Math.abs(after.enu.e)).toBeLessThan(10);
  });

  it('restores the strict cross-track-only rule when the cap is zero', () => {
    // The old behaviour is still expressible, and still tested, so the change
    // is a deliberate bound rather than a quietly abandoned invariant.
    const before = { e: 10, n: 140 };
    const match = findRoadMatch(before, 0, shortRoad(), null)!;
    const after = applyRoadSnap(before, match, 0, {
      ...DEFAULT_ROAD_SNAP_CONFIG,
      maxAlongCorrectionM: 0,
    });
    expect(after.enu.n).toBeCloseTo(140, 9);
  });

  it('never moves along-track at all for an ordinary interior match', () => {
    // The common case, which is the whole point: alongside a road, the
    // perpendicular foot has no along component and none is invented.
    const before = { e: 30, n: 250 };
    const match = findRoadMatch(before, 0, idx, null)!;
    const after = applyRoadSnap(before, match, 0.5);
    expect(after.enu.n).toBeCloseTo(before.n, 9);
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


describe('canTrustSpeedLimit — matching a road and trusting its limit differ', () => {
  const idx = indexOf(
    graphOf(
      wayFromEnu('trunk', [[0, -300], [0, 300]], { name: 'NH45', maxspeed: 80 }),
      wayFromEnu('service', [[30, -300], [30, 300]], { name: 'Service Rd', maxspeed: 20 }),
    ),
  );

  it('trusts a close, well-aligned match', () => {
    const m = findRoadMatch({ e: 3, n: 0 }, 0, idx, null)!;
    expect(m.wayId).toBe('trunk');
    expect(canTrustSpeedLimit(m, 0, false)).toBe(true);
  });

  it('refuses a match that is inside the search radius but far away', () => {
    // ★ THE GATE THAT MADE PHASE 6D WORK ★
    // Snapping geometry is forgiving; a speed limit is not. Feeding the limit
    // from any match inside the full 50 m radius made highway along-track error
    // WORSE — 107 m to 135 m — by clamping a vehicle on a trunk road to a
    // service road's 20 km/h. Restricting it to confident matches turned the
    // same mechanism into 107 m to 34 m.
    const lone = indexOf(
      graphOf(wayFromEnu('trunk', [[0, -300], [0, 300]], { name: 'NH45', maxspeed: 80 })),
    );
    const m = findRoadMatch({ e: 40, n: 0 }, 0, lone, null)!;
    expect(m.distanceM).toBeGreaterThan(DEFAULT_ROAD_SNAP_CONFIG.speedLimitTrustDistanceM);
    expect(canTrustSpeedLimit(m, 0, false)).toBe(false);
  });

  it('would otherwise adopt the wrong road\'s limit', () => {
    // Drifted 28 m east, the nearest road is the 20 km/h service road, not the
    // 80 km/h trunk road actually being driven. The match is still made — the
    // marker is pulled somewhere sensible — but its limit is 25 m away and so
    // is not trusted.
    const m = findRoadMatch({ e: 28, n: 0 }, 0, idx, null)!;
    expect(m.wayId).toBe('service');
    expect(m.maxspeedKph).toBe(20);
    expect(canTrustSpeedLimit(m, 0, false)).toBe(true);
  });

  it('refuses a match whose heading disagrees', () => {
    // Close to a road but travelling across it — probably a junction, or the
    // wrong road entirely. Either way its limit is not evidence.
    const m = findRoadMatch({ e: 3, n: 0 }, 0, idx, null)!;
    expect(canTrustSpeedLimit(m, 90, false)).toBe(false);
  });

  it('accepts the reverse direction on a two-way road', () => {
    const m = findRoadMatch({ e: 3, n: 0 }, 180, idx, null)!;
    expect(canTrustSpeedLimit(m, 180, false)).toBe(true);
  });

  it('rejects the reverse direction on a one-way road', () => {
    const one = indexOf(
      graphOf(wayFromEnu('ow', [[0, -300], [0, 300]], { maxspeed: 60, oneway: true })),
    );
    const m = findRoadMatch({ e: 3, n: 0 }, 180, one, null)!;
    expect(canTrustSpeedLimit(m, 180, true)).toBe(false);
  });

  it('refuses when the road has no speed limit tagged', () => {
    // Most OSM ways in India carry no maxspeed. Inventing a default and
    // clamping to it would be worse than not clamping at all.
    const untagged = indexOf(graphOf(wayFromEnu('u', [[0, -300], [0, 300]], { name: 'Lane' })));
    const m = findRoadMatch({ e: 3, n: 0 }, 0, untagged, null)!;
    expect(m.maxspeedKph).toBeUndefined();
    expect(canTrustSpeedLimit(m, 0, false)).toBe(false);
  });
});

describe('road snapping — staying on the road during an outage', () => {
  /**
   * ★ THE FIELD BUG ★
   * "When it goes to dead reckoning it goes off the road, into the plots."
   *
   * Measured over the committed logs before these tests existed: 27 % of
   * dead-reckoning samples were DRAWN more than 10 m from any road, the worst
   * 106 m out. Three causes, one test each.
   */
  const road = () =>
    indexOf(
      graphOf(
        wayFromEnu('main', [
          [0, -1000],
          [0, 1000],
        ]),
      ),
    );

  it('a full-strength snap puts the marker ON the road, not most of the way there', () => {
    // Cause 1: strength was `1 - confidence` clamped to [0.1, 0.7]. On the
    // first second of an outage confidence is still 1, so it applied a TENTH
    // of the correction — and it could never exceed 70 %, so a permanent 30 %
    // of a growing error was always on screen.
    const before = { e: 40, n: 0 };
    const match = findRoadMatch(before, 0, road(), null)!;

    const old = applyRoadSnap(before, match, 1); // the old confidence rule
    expect(Math.abs(old.enu.e)).toBeGreaterThan(30); // still 36 m off the road

    const full = applyRoadSnap(before, match, 1, DEFAULT_ROAD_SNAP_CONFIG, 1);
    expect(Math.abs(full.enu.e)).toBeLessThan(0.001); // on it
    expect(full.enu.n).toBeCloseTo(0, 9); // and no along-track invention
  });

  it('the widened radius still finds the road when the estimate has wandered', () => {
    // Cause 2: with one fixed 50 m radius, snapping switches itself off at the
    // exact moment it becomes the only evidence left — and the marker is then
    // free to wander open ground for the rest of the outage.
    const idx = road();
    const far = { e: 120, n: 0 };

    expect(findRoadMatch(far, 0, idx, null)).toBeNull();

    const wide = findRoadMatch(
      far,
      0,
      idx,
      null,
      DEFAULT_ROAD_SNAP_CONFIG,
      DEFAULT_ROAD_SNAP_CONFIG.wideSearchRadiusM,
    );
    expect(wide).not.toBeNull();
    expect(wide!.distanceM).toBeCloseTo(120, 0);
  });

  it('continuity does not survive running off the end of the held way', () => {
    // Cause 3, and the subtlest. Past the end of a way the correction to it is
    // almost entirely ALONG the road, which the snap discards — so it computed
    // a 23 m error and moved the marker zero metres, leaving it in a field at
    // the end of a road while the panel named the road it was not on. The
    // continuity bonus was what held it there.
    const idx = indexOf(
      graphOf(
        wayFromEnu('ending', [
          [0, 0],
          [0, 100],
        ]),
        wayFromEnu('continuing', [
          [12, 100],
          [12, 400],
        ]),
      ),
    );

    // Sitting past the end of 'ending', beside 'continuing'.
    const here = { e: 6, n: 200 };
    const match = findRoadMatch(here, 0, idx, 'ending')!;
    expect(match.wayId).toBe('continuing');
  });

  it('keeps continuity for an ordinary interior match', () => {
    // The bonus still does its job where it belongs — telling parallel roads
    // apart while we are genuinely alongside one.
    const idx = indexOf(
      graphOf(
        wayFromEnu('a', [
          [0, -500],
          [0, 500],
        ]),
        wayFromEnu('b', [
          [24, -500],
          [24, 500],
        ]),
      ),
    );
    const here = { e: 13, n: 0 };
    expect(findRoadMatch(here, 0, idx, 'a')!.wayId).toBe('a');
    expect(findRoadMatch(here, 0, idx, 'b')!.wayId).toBe('b');
  });
});
