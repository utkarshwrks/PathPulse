/**
 * Trail quality on live GNSS — the report behind the smoother and the gain.
 *
 * Everything asserted in `trail/index.ts` and in `gnssGainFor` was measured
 * here. Re-run it after touching either: `pnpm trail`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driveTrail, type TrailQuality } from './trailquality.js';
import { ROOT } from './paths.js';
import type { EngineConfig } from '@pathpulse/nav-core';
import { DEFAULT_TRAIL_SMOOTH_HALF_WINDOW } from '@pathpulse/nav-core';

const route = JSON.parse(readFileSync(join(ROOT, 'data/routes/route_city.json'), 'utf8'));
const graph = JSON.parse(readFileSync(join(ROOT, 'data/maps/road_graph_city.json'), 'utf8'));

/**
 * ★ THE CONDITIONS ARE THE POINT ★
 * The simulator defaults to a far better receiver than a phone in a city
 * street has. A handset delivers a fix around 1 Hz with 5-15 m of horizontal
 * error, and it is exactly there that the line was reported as messy — so
 * these are the phone, not the bench.
 */
const ACCURACIES = [3, 8, 15];
const SECONDS = 240;
/** One noise realisation is a story, not a measurement. */
const SEEDS = [1337, 7, 99];

function mean(qs: TrailQuality[], k: keyof TrailQuality): number {
  return qs.reduce((s, q) => s + (q[k] as number), 0) / qs.length;
}

function run(
  accM: number,
  smoothHalfWindow: number,
  config?: Partial<EngineConfig>,
): TrailQuality {
  const qs = SEEDS.map(
    (seed) =>
      driveTrail({
        route,
        graph,
        seconds: SECONDS,
        seed,
        gnssAccuracyM: accM,
        gnssRateHz: 1,
        smoothHalfWindow,
        ...(config ? { config } : {}),
      }).quality,
  );
  return {
    tortuosity: mean(qs, 'tortuosity'),
    reversalFraction: mean(qs, 'reversalFraction'),
    meanTurnDeg: mean(qs, 'meanTurnDeg'),
    crossTrackRmsM: mean(qs, 'crossTrackRmsM'),
    crossTrackP90M: mean(qs, 'crossTrackP90M'),
    alongTrackMeanM: mean(qs, 'alongTrackMeanM'),
    points: Math.round(mean(qs, 'points')),
    truthDistanceM: mean(qs, 'truthDistanceM'),
  };
}

function head(label: string): void {
  console.log(
    '\n' +
      label.padEnd(26) +
      'tortuosity'.padStart(11) +
      'reversals'.padStart(11) +
      'xtrackRMS'.padStart(11) +
      'p90'.padStart(8) +
      'along'.padStart(8),
  );
}

function row(name: string, q: TrailQuality): void {
  console.log(
    name.padEnd(26) +
      q.tortuosity.toFixed(3).padStart(11) +
      (q.reversalFraction * 100).toFixed(1).padStart(10) +
      '%' +
      q.crossTrackRmsM.toFixed(2).padStart(11) +
      q.crossTrackP90M.toFixed(2).padStart(8) +
      q.alongTrackMeanM.toFixed(1).padStart(8),
  );
}

console.log('PathPulse — trail quality on live GNSS');
console.log(`city route, ${SECONDS}s, 1 Hz fixes, ${SEEDS.length} seeds averaged`);
console.log(
  '\ntortuosity = drawn length / true length. 1.00 is a line as long as the road.',
);
console.log('reversals  = vertices turning more than 90 degrees. Roads have none.');

// 1. The smoother. Half-window swept against both things it could break.
for (const accM of ACCURACIES) {
  head(`smoothing, GNSS ${accM} m`);
  for (const half of [0, 1, 2, 4, 7, 12]) {
    row(
      half === 0
        ? 'raw buffer'
        : `+/- ${half}${half === DEFAULT_TRAIL_SMOOTH_HALF_WINDOW ? '  (shipped)' : ''}`,
      run(accM, half),
    );
  }
}

// 2. The gain, with the smoother active so the two are not confounded.
for (const accM of ACCURACIES) {
  head(`GNSS position gain, ${accM} m`);
  row('adaptive  (shipped)', run(accM, DEFAULT_TRAIL_SMOOTH_HALF_WINDOW));
  for (const g of [0.05, 0.1, 0.15, 0.25, 0.4, 1]) {
    row(
      `fixed ${g.toFixed(2)}`,
      run(accM, DEFAULT_TRAIL_SMOOTH_HALF_WINDOW, {
        adaptiveGnssGain: false,
        gnssPositionGain: g,
      }),
    );
  }
}
