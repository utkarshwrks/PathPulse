import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  appendTrailPoint,
  buildTrailSegments,
  DEFAULT_TRAIL_OPTIONS,
  findRoadMatch,
  NavigationEngine,
  RoadIndex,
  type RoadGraph,
  type SensorSample,
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

describe('the engine sustains its rate with every Phase 9 feature running', () => {
  /**
   * ★ NOBODY MEASURED WHAT PHASE 9 COST THE HOT PATH ★
   * Phase 9 added three things that run on every single sample: the turn
   * detector, the GNSS anomaly detector, and the covariance growth behind the
   * confidence ellipse. Each is cheap on its own and none has a test that says
   * so. The problem statement requires 10 Hz output from a 50 Hz input on a
   * phone several times slower than this machine — so "cheap" needs a number.
   *
   * Bounds are loose, as elsewhere in this file: this catches an algorithmic
   * regression, not machine-to-machine variation.
   */
  function drive(seconds: number, hz: number): SensorSample[] {
    const dtMs = 1000 / hz;
    const out: SensorSample[] = [];
    let nextGnssMs = 0;
    for (let t = 0; t <= seconds * 1000; t += dtMs) {
      const phase = (t / 1000) * 2 * Math.PI * 20;
      const turning = Math.floor(t / 20_000) % 2 === 1;
      const s: SensorSample = {
        t,
        imu: {
          ax: 0.8 * Math.sin(phase),
          ay: 0.8 * Math.sin(phase * 1.31),
          az: 9.80665 + 0.8 * Math.sin(phase * 0.77),
          gx: 0,
          gy: 0,
          // Alternate straight stretches and turns so the turn detector is
          // actually working rather than short-circuiting on a constant.
          gz: turning ? -0.35 : 0,
        },
      };
      if (t >= nextGnssMs) {
        nextGnssMs += 1000;
        s.gnss = {
          lat: 23.1815 + (14 * (t / 1000)) / 111_320,
          lon: 79.9864,
          accuracyM: 4,
          speedMps: 14,
          headingDeg: 0,
          satCount: 9,
          meanCn0: 38,
        };
      }
      out.push(s);
    }
    return out;
  }

  it('processes a 50 Hz stream far inside real time', () => {
    const samples = drive(120, 50);
    const engine = new NavigationEngine();
    const t0 = performance.now();
    for (const s of samples) engine.update(s);
    const elapsedMs = performance.now() - t0;
    const perSampleMs = elapsedMs / samples.length;

    // 50 Hz means a 20 ms budget per sample. Measured well under 0.05 ms on a
    // dev laptop; 2 ms still leaves a phone an order of magnitude of headroom.
    expect(perSampleMs).toBeLessThan(2);
    // And the whole two-minute drive must process in far less than two minutes.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  it('does not slow down as the session grows', () => {
    // Anything accumulating per-sample — an unbounded buffer, a growing event
    // log — shows up as the second half costing more than the first.
    const samples = drive(200, 50);
    const engine = new NavigationEngine();
    const half = Math.floor(samples.length / 2);

    const t0 = performance.now();
    for (let i = 0; i < half; i++) engine.update(samples[i]!);
    const firstMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = half; i < samples.length; i++) engine.update(samples[i]!);
    const secondMs = performance.now() - t1;

    // Generous: catches linear growth, not jitter.
    expect(secondMs).toBeLessThan(firstMs * 3 + 50);
  }, 60_000);
});
