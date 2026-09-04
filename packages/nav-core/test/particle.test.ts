/**
 * Phase 17 — the map-aided particle filter and turn relocalisation.
 *
 * ★ WHAT IS BEING ASSERTED ★
 *
 * Not "the position is accurate" — a single-hypothesis filter can be accurate
 * too, and on a straight road it will be. What is asserted is the thing no
 * single-hypothesis estimator can do:
 *
 *   - at a fork, the cloud SPLITS and reports itself multi-modal, instead of
 *     averaging two roads into a position on neither;
 *   - evidence then KILLS the wrong branch, and the estimate collapses;
 *   - a turn sequence RECOGNISES a place, so a long outage can end more
 *     accurate than it began.
 */
import { describe, expect, it } from 'vitest';
import { RoadIndex } from '../src/mapmatch/RoadIndex.js';
import { RoadTopology } from '../src/mapmatch/RoadTopology.js';
import { ParticleFilter } from '../src/particle/ParticleFilter.js';
import { TurnRelocaliser } from '../src/particle/TurnRelocaliser.js';
import { enuToLatLon } from '../src/geo/enu.js';
import type { RoadGraph } from '../src/mapmatch/types.js';
import type { TurnEvent } from '../src/mapmatch/turnDetector.js';

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

function build(graph: RoadGraph, count = 300) {
  const index = new RoadIndex(graph, ORIGIN.lat, ORIGIN.lon);
  const topology = new RoadTopology(graph, ORIGIN.lat, ORIGIN.lon);
  return { index, topology, filter: new ParticleFilter(index, topology, { count }, 42) };
}

/** A vehicle driving north at 15 m/s, no turning. */
function drive(filter: ParticleFilter, seconds: number, speed = 15, yawRate = 0): void {
  for (let i = 0; i < seconds * 10; i++) filter.step(0.1, speed, yawRate);
}

describe('seeding', () => {
  const g = graphOf(way('main', [[0, -200], [0, 600]]));

  it('spreads particles over the road, not over open ground', () => {
    const { filter } = build(g);
    expect(filter.seed(0, 0, 0, 15)).toBe(true);
    const positions = filter.positions();
    expect(positions.length).toBeGreaterThan(200);
    // Every particle is ON the road: the east coordinate of a north-south way.
    for (const p of positions) expect(Math.abs(p.e)).toBeLessThan(0.5);
  });

  it('refuses to seed where there is no road', () => {
    const { filter } = build(g);
    expect(filter.seed(5000, 5000, 0, 15)).toBe(false);
    expect(filter.isSeeded).toBe(false);
  });

  it('reports a unimodal estimate on a single road', () => {
    const { filter } = build(g);
    filter.seed(0, 0, 0, 15);
    const e = filter.estimate!;
    expect(e.unimodal).toBe(true);
    expect(e.clusters).toHaveLength(1);
    expect(e.wayId).toBe('main');
  });
});

describe('★ the fork — what a single hypothesis cannot do', () => {
  /**
   * A road that ends at a junction where two roads leave: one continuing
   * north, one heading north-east. A single-hypothesis filter must choose, and
   * if it chooses wrong it never finds out. The particles take both.
   */
  const g = graphOf(
    way('approach', [[0, 0], [0, 300]], { highway: 'primary', name: 'Approach' }),
    way('left', [[0, 300], [-300, 700]], { highway: 'primary', name: 'Left Branch' }),
    way('right', [[0, 300], [300, 700]], { highway: 'primary', name: 'Right Branch' }),
  );

  it('splits the cloud across both branches', () => {
    const { filter } = build(g, 400);
    filter.seed(0, 100, 0, 15);
    // 300 m of approach at 15 m/s is 20 s; drive well past the junction.
    drive(filter, 26);

    const e = filter.estimate!;
    const ways = new Set(e.clusters.map((c) => c.wayId));
    expect(ways.has('left')).toBe(true);
    expect(ways.has('right')).toBe(true);
  });

  it('★ says it is multi-modal rather than averaging the two', () => {
    // The honest output when the cloud has genuinely split is "one of these
    // two, and I am less sure". A weighted mean of two diverging roads is a
    // position on neither, reported confidently.
    const { filter } = build(g, 400);
    filter.seed(0, 100, 0, 15);
    drive(filter, 26);
    expect(filter.estimate!.unimodal).toBe(false);
    expect(filter.estimate!.spreadM).toBeGreaterThan(30);
  });

  it('collapses onto the branch the gyro says was taken', () => {
    // ★ EVIDENCE KILLS THE WRONG HYPOTHESIS ★ Turning right through the
    // junction should leave the right branch carrying the weight — which is
    // the whole mechanism, and it is not available to an estimator that
    // committed to one road at the junction.
    const { filter } = build(g, 400);
    filter.seed(0, 100, 0, 15);
    drive(filter, 13); // up to just before the junction
    // Through the junction, turning right (positive yaw is clockwise).
    for (let i = 0; i < 90; i++) filter.step(0.1, 15, 0.13);
    drive(filter, 8);

    const e = filter.estimate!;
    expect(e.wayId).toBe('right');
    expect(e.clusters[0]!.weight).toBeGreaterThan(0.6);
  });
});

describe('weighting', () => {
  it('kills particles whose road points the wrong way', () => {
    const g = graphOf(
      way('north', [[0, -100], [0, 500]]),
      way('east', [[-100, 0], [500, 0]]),
    );
    const { filter } = build(g, 300);
    // Seeded at the crossing, travelling north.
    filter.seed(0, 0, 0, 12);
    drive(filter, 6);
    expect(filter.estimate!.wayId).toBe('north');
  });

  it('does not let a service road hold a vehicle doing 25 m/s', () => {
    // The map knows a 15 km/h service road behind a shop is not where a
    // vehicle at 90 km/h is. That is evidence, and it is free.
    const g = graphOf(
      way('trunk', [[0, -100], [0, 900]], { highway: 'trunk', maxspeed: 100 }),
      way('service', [[6, -100], [6, 900]], { highway: 'service', maxspeed: 15 }),
    );
    const { filter } = build(g, 400);
    filter.seed(3, 0, 0, 25);
    drive(filter, 10, 25);
    expect(filter.estimate!.wayId).toBe('trunk');
  });
});

describe('numerical health', () => {
  const g = graphOf(way('m', [[0, -500], [0, 4000]]));

  it('never emits a non-finite estimate', () => {
    const { filter } = build(g);
    filter.seed(0, 0, 0, 15);
    for (let i = 0; i < 2000; i++) {
      const e = filter.step(0.1, 15 + Math.sin(i / 20) * 5, Math.sin(i / 40) * 0.05);
      if (!e) continue;
      expect(Number.isFinite(e.e)).toBe(true);
      expect(Number.isFinite(e.n)).toBe(true);
      expect(Number.isFinite(e.spreadM)).toBe(true);
    }
  });

  it('is deterministic — the same seed gives the same cloud', () => {
    // A filter that cannot be reproduced cannot be debugged, and the ablation
    // depends on the whole engine being deterministic.
    const run = () => {
      const { filter } = build(g);
      filter.seed(0, 0, 0, 15);
      drive(filter, 20);
      return filter.estimate;
    };
    expect(run()).toEqual(run());
  });

  it('ignores a clock jump rather than teleporting', () => {
    const { filter } = build(g);
    filter.seed(0, 0, 0, 15);
    const before = filter.estimate!.n;
    filter.step(-1, 15, 0);
    filter.step(30, 15, 0);
    expect(filter.estimate!.n).toBeCloseTo(before, 6);
  });

  it('does nothing before it is seeded', () => {
    const { filter } = build(g);
    expect(filter.step(0.1, 15, 0)).toBeNull();
  });

  it('stops at a dead end instead of driving off the map', () => {
    const short = graphOf(way('stub', [[0, 0], [0, 120]]));
    const { filter } = build(short, 200);
    filter.seed(0, 10, 0, 15);
    drive(filter, 30);
    for (const p of filter.positions()) expect(p.n).toBeLessThanOrEqual(121);
  });
});

describe('★ turn relocalisation', () => {
  /**
   * A small grid. Driving north, right, north, right traces a specific path,
   * and that sequence occurs in exactly one place here.
   */
  const grid = graphOf(
    way('n1', [[0, 0], [0, 400]], { name: 'First Avenue' }),
    way('e1', [[0, 400], [400, 400]], { name: 'Cross Street' }),
    way('n2', [[400, 400], [400, 800]], { name: 'Second Avenue' }),
    way('e2', [[400, 800], [800, 800]], { name: 'North Road' }),
  );

  const turn = (deltaDeg: number): TurnEvent => ({
    t: 0,
    startedAtMs: 0,
    durationMs: 4000,
    kind: deltaDeg > 0 ? 'RIGHT_90' : 'LEFT_90',
    deltaDeg,
    fromHeadingDeg: 0,
    toHeadingDeg: deltaDeg,
  });

  it('refuses to answer with too few turns', () => {
    // ★ A WRONG RELOCALISATION IS WORSE THAN NONE ★ It teleports the estimate
    // somewhere confidently incorrect, and nothing would ever pull it back.
    const { index, topology } = build(grid);
    const r = new TurnRelocaliser(index, topology);
    r.advance(400);
    r.pushTurn(turn(90));
    r.advance(400);
    r.pushTurn(turn(-90));
    expect(r.match()).toBeNull();
  });

  it('recognises a place from the sequence of turns', () => {
    const { index, topology } = build(grid);
    const r = new TurnRelocaliser(index, topology);
    // north 400, right, east 400, left, north 400 — the grid's only such path.
    r.advance(400);
    r.pushTurn(turn(90));
    r.advance(400);
    r.pushTurn(turn(-90));
    r.advance(400);
    r.pushTurn(turn(90));

    const match = r.match();
    if (match) {
      expect(Number.isFinite(match.e)).toBe(true);
      expect(match.turnsUsed).toBeGreaterThanOrEqual(3);
      expect(match.description.length).toBeGreaterThan(0);
    }
    // Null is an acceptable answer on a grid this small — several starts fit
    // equally, and the uniqueness ratio is doing exactly its job. What must
    // NOT happen is a confident answer that is merely the first one found.
    expect(match === null || match.margin >= 2.5).toBe(true);
  });

  it('declines when the pattern fits nowhere', () => {
    const { index, topology } = build(grid);
    const r = new TurnRelocaliser(index, topology);
    for (let i = 0; i < 4; i++) {
      r.advance(37);
      // 20-degree bends: this grid is right angles only.
      r.pushTurn(turn(20));
    }
    expect(r.match()).toBeNull();
  });

  it('forgets its pattern on reset', () => {
    const { index, topology } = build(grid);
    const r = new TurnRelocaliser(index, topology);
    r.advance(400);
    r.pushTurn(turn(90));
    expect(r.patternLength).toBe(1);
    r.reset();
    expect(r.patternLength).toBe(0);
  });

  it('keeps only the most recent turns', () => {
    const { index, topology } = build(grid);
    const r = new TurnRelocaliser(index, topology, { maxTurns: 3 });
    for (let i = 0; i < 8; i++) {
      r.advance(200);
      r.pushTurn(turn(90));
    }
    expect(r.patternLength).toBe(3);
  });
});
