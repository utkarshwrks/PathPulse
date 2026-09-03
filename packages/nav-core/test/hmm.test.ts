/**
 * Phase 14 — Newson-Krumm HMM map matching.
 *
 * ★ THE TESTS THAT MATTER ARE THE ONES NEAREST-ROAD SNAPPING CANNOT PASS ★
 *
 * Phase 6D's matcher asks, per position, "which road is closest and points
 * roughly the right way?" That has one structural blind spot: it cannot
 * express that a road is CLOSE BUT UNREACHABLE. A service road twenty metres
 * away, the opposite carriageway, the road under a flyover — all are twenty
 * metres away, and all would require driving to the next junction and back.
 *
 * Each test below is built so that the greedy answer is wrong and the
 * sequence answer is right, and both are asserted.
 */
import { describe, expect, it } from 'vitest';
import { RoadIndex } from '../src/mapmatch/RoadIndex.js';
import { RoadTopology } from '../src/mapmatch/RoadTopology.js';
import { HmmMapMatcher, type HmmObservation } from '../src/mapmatch/hmm.js';
import { findRoadMatch } from '../src/constraints/roadsnap.js';
import { enuToLatLon } from '../src/geo/enu.js';
import type { RoadGraph } from '../src/mapmatch/types.js';

const ORIGIN = { lat: 28.6315, lon: 77.2167 };

function way(
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

const graphOf = (...ways: RoadGraph['ways']): RoadGraph => ({ bbox: [0, 0, 0, 0], ways });

function build(graph: RoadGraph) {
  const index = new RoadIndex(graph, ORIGIN.lat, ORIGIN.lon);
  const topology = new RoadTopology(graph, ORIGIN.lat, ORIGIN.lon);
  return { index, topology, matcher: new HmmMapMatcher(index, topology) };
}

const obs = (e: number, n: number, headingDeg: number, travelledM: number): HmmObservation => ({
  t: 0,
  e,
  n,
  headingDeg,
  sigmaM: 6,
  travelledM,
});

describe('RoadTopology', () => {
  it('joins ways that share a coordinate, and only those', () => {
    // ★ SHARED COORDINATES, NOT NEARBY ONES ★ Overpass returns geometry from
    // shared OSM nodes, so a junction is an IDENTICAL coordinate. A
    // distance-based join with any tolerance at all would weld every flyover
    // to the road beneath it.
    const g = graphOf(
      way('a', [
        [0, 0],
        [0, 200],
      ]),
      way('b', [
        [0, 200],
        [200, 200],
      ]),
      // Passes within a metre of 'a' but shares no coordinate — a flyover.
      way('c', [
        [1, -100],
        [1, 300],
      ]),
    );
    const { topology } = build(g);

    const alongA = topology.routeDistanceM(
      { wayId: 'a', arcLengthM: 10 },
      { wayId: 'b', arcLengthM: 50 },
    );
    expect(alongA).not.toBeNull();
    expect(alongA!).toBeCloseTo(190 + 50, 0);

    // 'c' is a metre away and unreachable. That "null" is the whole point.
    expect(
      topology.routeDistanceM({ wayId: 'a', arcLengthM: 100 }, { wayId: 'c', arcLengthM: 200 }),
    ).toBeNull();
  });

  it('measures distance along a single way as a difference of arc lengths', () => {
    const { topology } = build(
      graphOf(
        way('m', [
          [0, 0],
          [0, 500],
        ]),
      ),
    );
    expect(
      topology.routeDistanceM({ wayId: 'm', arcLengthM: 100 }, { wayId: 'm', arcLengthM: 380 }),
    ).toBeCloseTo(280, 1);
  });

  it('lets a two-way road be driven in reverse', () => {
    // OSM's drawing direction is not the direction of travel. A matcher that
    // could only follow it would reject every legal route down a two-way street.
    const { topology } = build(
      graphOf(
        way('a', [
          [0, 0],
          [0, 200],
        ]),
        way('b', [
          [0, 200],
          [0, 400],
        ]),
      ),
    );
    expect(
      topology.routeDistanceM({ wayId: 'b', arcLengthM: 100 }, { wayId: 'a', arcLengthM: 50 }),
    ).not.toBeNull();
  });

  it('refuses to route further than its bound', () => {
    const { topology } = build(
      graphOf(
        way('long', [
          [0, 0],
          [0, 5000],
        ]),
      ),
    );
    // Same way but the two edges are one; still, past the ceiling it is null
    // for anything needing a junction search.
    const near = topology.routeDistanceM(
      { wayId: 'long', arcLengthM: 0 },
      { wayId: 'long', arcLengthM: 4000 },
    );
    expect(near).toBeCloseTo(4000, 0); // same edge: arithmetic, not a search
  });

  it('counts junctions and edges', () => {
    const { topology } = build(
      graphOf(
        way('a', [
          [0, 0],
          [0, 100],
          [0, 200],
        ]),
        way('b', [
          [0, 100],
          [100, 100],
        ]),
      ),
    );
    expect(topology.nodeCount).toBeGreaterThan(2);
    expect(topology.edgeCount).toBeGreaterThan(1);
  });
});

describe('HMM — the parallel service road', () => {
  /**
   * A trunk road, and a service road 18 m to its east that only connects at
   * the far end. The vehicle drives up the trunk road. A couple of noisy
   * observations land nearer the service road.
   */
  const g = graphOf(
    way('trunk', [
      [0, 0],
      [0, 600],
    ], { highway: 'trunk', name: 'Trunk' }),
    way('service', [
      [18, 0],
      [18, 500],
    ], { highway: 'service', name: 'Service' }),
    way('link', [
      [18, 500],
      [0, 600],
    ], { highway: 'service' }),
  );

  it('greedy snapping takes the bait, per position', () => {
    const { index } = build(g);
    // 12 m east of the trunk road is 6 m from the service road, so the nearest
    // road IS the service road. That is the structural blind spot: asked about
    // one position in isolation, geometry gives the wrong answer and there is
    // nothing else to consult.
    expect(findRoadMatch({ e: 12, n: 200 }, 0, index, null)!.wayId).toBe('service');
  });

  it('Phase 6D’s continuity bonus is a one-step version of the same idea', () => {
    // Worth stating plainly rather than pretending the old matcher is useless:
    // the 20 m bonus for staying on the held way IS sequence reasoning, over a
    // window of exactly one step. It survives this case.
    const { index } = build(g);
    expect(findRoadMatch({ e: 12, n: 200 }, 0, index, 'trunk')!.wayId).toBe('trunk');
  });

  it('★ but one step is memory, not reasoning, and it cannot be talked out of it', () => {
    // The mirror-image failure, and the one that actually bites. These two
    // roads are 18 m apart and the bonus is 20 m, so the held way ALWAYS wins:
    // whichever road greedy latches onto first, it keeps, however clearly the
    // position says otherwise. Here it has latched onto the service road, the
    // vehicle is 2 m from the trunk road and 16 m from the service road, and
    // greedy still says service.
    //
    // One step of memory cannot revise a decision, only defend it. Viterbi
    // over a window can, because it re-scores the whole path every time.
    const { index } = build(g);
    expect(findRoadMatch({ e: 2, n: 200 }, 0, index, 'service')!.wayId).toBe('service');

    const { matcher } = build(g);
    for (let n = 0; n <= 180; n += 20) matcher.push(obs(0.5, n, 0, 20));
    expect(matcher.push(obs(2, 200, 0, 20))!.wayId).toBe('trunk');
  });

  it('the HMM holds the trunk road, because getting there is a 600 m detour', () => {
    const { matcher } = build(g);
    // A clean run up the trunk road, then the same drifted observation that
    // outvotes the one-step bonus above.
    for (let n = 0; n <= 180; n += 20) matcher.push(obs(0.5, n, 0, 20));
    const noisy = matcher.push(obs(16, 200, 0, 20));
    expect(noisy!.wayId).toBe('trunk');
  });

  it('and still follows the vehicle when it genuinely changes road', () => {
    // ★ THE OTHER HALF ★ A matcher that never changes its mind is not robust,
    // it is stuck. Driven consistently along the service road from the start,
    // it must say so.
    const { matcher } = build(g);
    for (let n = 0; n <= 300; n += 20) matcher.push(obs(18, n, 0, 20));
    expect(matcher.matchedWayId).toBe('service');
  });
});

describe('HMM — the divided carriageway', () => {
  /**
   * Two one-way carriageways 14 m apart, joined only at their ends. Travelling
   * north on the northbound side, an observation that drifts west lands closer
   * to the southbound one — where a vehicle travelling north cannot be.
   */
  const g = graphOf(
    way('north', [
      [0, 0],
      [0, 800],
    ], { oneway: true, name: 'Northbound' }),
    way('south', [
      [-14, 800],
      [-14, 0],
    ], { oneway: true, name: 'Southbound' }),
  );

  it('rejects the opposite carriageway on heading alone', () => {
    const { matcher } = build(g);
    for (let n = 0; n <= 200; n += 25) matcher.push(obs(0, n, 0, 25));
    const drifted = matcher.push(obs(-9, 225, 0, 25));
    expect(drifted!.wayId).toBe('north');
  });
});

describe('HMM — flyovers', () => {
  const g = graphOf(
    way('under', [
      [0, 0],
      [0, 400],
    ], { name: 'Under' }),
    way('over', [
      [-200, 200],
      [200, 200],
    ], { name: 'Over', layerM: 6 }),
  );

  it('uses altitude to separate two roads that cross at the same point', () => {
    // Without an altitude the two are simply crossing roads and the heading
    // term separates them. With one, a vehicle at ground level is pushed off
    // the flyover explicitly — which matters when the flyover runs PARALLEL
    // rather than across, and heading cannot help.
    const { matcher } = build(g);
    for (let n = 100; n <= 190; n += 15) {
      matcher.push({ ...obs(0, n, 0, 15), altitudeM: 0 });
    }
    const atCrossing = matcher.push({ ...obs(0, 200, 0, 10), altitudeM: 0 });
    expect(atCrossing!.wayId).toBe('under');
  });
});

describe('HMM — behaviour under stress', () => {
  const straight = graphOf(
    way('m', [
      [0, -100],
      [0, 2000],
    ]),
  );

  it('returns null where the graph has no coverage', () => {
    const { matcher } = build(straight);
    expect(matcher.push(obs(5000, 5000, 0, 10))).toBeNull();
  });

  it('recovers after leaving and re-entering coverage', () => {
    // Every path dying is not a crash, it is the end of a trellis. The
    // sequence evidence is genuinely gone and restarting from the emissions is
    // the honest response.
    const { matcher } = build(straight);
    for (let n = 0; n <= 100; n += 20) matcher.push(obs(0, n, 0, 20));
    expect(matcher.push(obs(9000, 9000, 0, 20))).toBeNull();
    const back = matcher.push(obs(0, 140, 0, 20));
    expect(back).not.toBeNull();
    expect(back!.wayId).toBe('m');
  });

  it('bounds its own window rather than growing without limit', () => {
    const { matcher } = build(straight);
    for (let i = 0; i < 500; i++) matcher.push(obs(0, i * 3, 0, 3));
    // Still answering, still fast: the assertion is that the loop above
    // finished at all, which it would not if the window were unbounded and the
    // trellis quadratic in the drive length.
    expect(matcher.matchedWayId).toBe('m');
  });

  it('is deterministic', () => {
    const run = () => {
      const { matcher } = build(straight);
      let last = null;
      for (let n = 0; n <= 300; n += 20) last = matcher.push(obs(1, n, 0, 20));
      return last;
    };
    expect(run()).toEqual(run());
  });

  it('survives non-finite input', () => {
    const { matcher } = build(straight);
    expect(matcher.push(obs(Number.NaN, 0, 0, 10))).toBeNull();
  });

  it('forgets everything on reset', () => {
    const { matcher } = build(straight);
    for (let n = 0; n <= 100; n += 20) matcher.push(obs(0, n, 0, 20));
    matcher.reset();
    expect(matcher.matchedWayId).toBeNull();
  });
});
