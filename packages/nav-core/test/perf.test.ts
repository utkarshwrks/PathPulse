import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  appendTrailPoint,
  buildTrailSegments,
  DEFAULT_TRAIL_OPTIONS,
  findRoadMatch,
  RoadIndex,
  type RoadGraph,
  type TrailPoint,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url).pathname;

/**
 * Performance budget for on-device map matching.
 *
 * Road snapping runs on every sample inside a 10 Hz output budget, against a
 * graph that ships inside the APK — 9462 ways and 66k segments for a 12 km
 * square of Jabalpur. If a query ever became linear in the number of segments,
 * nothing would fail: the app would just quietly stutter on a phone, which is
 * the kind of regression a correctness test cannot see.
 *
 * The bounds are deliberately loose — roughly 50x the measured figures — so
 * this catches an algorithmic regression rather than machine-to-machine
 * variation. Measured on a dev laptop: parse 17 ms, index 103 ms, and 0.007 ms
 * per query.
 */
describe('road matching stays inside its budget', () => {
  const raw = readFileSync(`${ROOT}data/maps/road_graph_jabalpur.json`, 'utf8');

  it('builds an index over a city-sized graph once, quickly enough', () => {
    const graph = JSON.parse(raw) as RoadGraph;
    const t0 = performance.now();
    const idx = new RoadIndex(graph, 23.1685, 79.9339);
    const buildMs = performance.now() - t0;

    expect(idx.wayCount).toBeGreaterThan(9000);
    expect(idx.size).toBeGreaterThan(60_000);
    // One-time, on the first fix. A phone is several times slower than this
    // machine, so the real cost is a brief hitch, not an ongoing one.
    expect(buildMs).toBeLessThan(5000);
  }, 60_000);

  it('answers a match query far inside one sample period', () => {
    const idx = new RoadIndex(JSON.parse(raw) as RoadGraph, 23.1685, 79.9339);
    const queries = 5000;
    const t0 = performance.now();
    for (let i = 0; i < queries; i++) {
      findRoadMatch({ e: (i % 2000) - 1000, n: (i % 1700) - 850 }, i % 360, idx, null);
    }
    const perQueryMs = (performance.now() - t0) / queries;
    // 20 ms is one sample period at 50 Hz, and matching is only part of it.
    expect(perQueryMs).toBeLessThan(1);
  }, 60_000);
});

describe('the trail stays inside its budget at the larger cap', () => {
  /**
   * The buffer went from 500 to 5000 points so the export outlives the outage
   * (see trail/index.ts). Both append and segment-building are linear in the
   * buffer, and both run at the 10 Hz UI rate — so a tenfold buffer is a
   * tenfold cost on a path that has 100 ms to spend. Worth a number rather
   * than an assumption.
   *
   * Bounds are loose, as elsewhere here: this catches an algorithmic
   * regression, not machine variation.
   */
  it('appends and rebuilds segments far inside one UI frame', () => {
    let trail: TrailPoint[] = [];
    // Fill to capacity first: appending to a full ring is the expensive case.
    for (let i = 0; i < DEFAULT_TRAIL_OPTIONS.maxPoints; i++) {
      trail = appendTrailPoint(trail, {
        lat: 23.18 + i * 0.00002,
        lon: 79.98 + i * 0.00002,
        mode: i % 400 < 300 ? 'GNSS' : 'DEAD_RECKONING',
        t: i * 100,
      });
    }
    expect(trail).toHaveLength(DEFAULT_TRAIL_OPTIONS.maxPoints);

    // One UI frame's work: one append plus one full segment rebuild.
    const frames = 100;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      trail = appendTrailPoint(trail, {
        lat: 23.3 + i * 0.00002,
        lon: 80.1 + i * 0.00002,
        mode: 'GNSS',
        t: 1_000_000 + i * 100,
      });
      buildTrailSegments(trail);
    }
    const perFrameMs = (performance.now() - t0) / frames;

    // The UI budget is 100 ms per frame at 10 Hz. Measured around 0.3 ms.
    expect(perFrameMs).toBeLessThan(20);
  });
});
