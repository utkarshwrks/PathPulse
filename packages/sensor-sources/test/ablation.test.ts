import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NavigationEngine, haversineDistance, type NavigationState } from '@pathpulse/nav-core';
import { SimulationSource, type RouteGeoJson } from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const city = JSON.parse(readFileSync(ROOT + 'data/routes/route_city.json', 'utf8')) as RouteGeoJson;

/**
 * A miniature ablation, run in CI rather than by hand.
 *
 * Ground truth is the GNSS the simulator withheld: drive with good GNSS,
 * record, then delete it in software over the outage window. Honest and
 * reproducible — the same methodology Phase 7 formalises.
 */
function drive(config: Record<string, boolean>) {
  const truthSim = new SimulationSource({ route: city, seed: 4242 });
  const truth = new Map<number, { lat: number; lon: number }>();
  for (const s of truthSim.advance(180_000)) if (s.gnss) truth.set(s.t, { lat: s.gnss.lat, lon: s.gnss.lon });

  const sim = new SimulationSource({ route: city, seed: 4242 });
  sim.simulateGnssOutage(30_000, 60_000);
  const engine = new NavigationEngine(config as never);
  const states: NavigationState[] = [];
  for (const s of sim.advance(180_000)) states.push(engine.update(s));

  // Error at the end of the outage, against the withheld truth.
  let finalErrorM = 0, distanceM = 0;
  const dr = states.filter((s) => s.mode === 'DEAD_RECKONING');
  if (dr.length) {
    const last = dr[dr.length - 1]!, first = dr[0]!;
    const t = truth.get(last.t) ?? [...truth.entries()].reduce((b, e) => Math.abs(e[0] - last.t) < Math.abs(b[0] - last.t) ? e : b)[1];
    finalErrorM = haversineDistance(t.lat, t.lon, last.position.lat, last.position.lon);
    distanceM = last.distanceTravelledM - first.distanceTravelledM;
  }
  return { finalErrorM, distanceM, driftPct: distanceM > 0 ? (finalErrorM / distanceM) * 100 : NaN };
}

describe('ablation — 60 s outage on the city route', () => {
  const ALL_OFF = { nhc: false, zupt: false, zaru: false, speedClamp: false, lowPass: false, medianFilter: false, forwardBias: false };
  it('prints the table', () => {
    const rows: Array<[string, Record<string, boolean>]> = [
      ['naive (no constraints)', ALL_OFF],
      ['+ filters', { ...ALL_OFF, lowPass: true, medianFilter: true }],
      ['+ ZARU', { ...ALL_OFF, lowPass: true, medianFilter: true, zaru: true }],
      ['+ ZUPT', { ...ALL_OFF, lowPass: true, medianFilter: true, zaru: true, zupt: true }],
      ['+ NHC', { ...ALL_OFF, lowPass: true, medianFilter: true, zaru: true, zupt: true, nhc: true }],
      ['+ forward-bias', { ...ALL_OFF, lowPass: true, medianFilter: true, zaru: true, zupt: true, nhc: true, forwardBias: true }],
      ['full', {}],
    ];
    console.log('\n| Configuration | Final error (m) | DR distance (m) | Drift % |');
    console.log('|---|---|---|---|');
    for (const [name, cfg] of rows) {
      const r = drive(cfg);
      console.log(`| ${name} | ${r.finalErrorM.toFixed(1)} | ${r.distanceM.toFixed(0)} | ${r.driftPct.toFixed(2)} |`);
    }
    expect(drive({}).finalErrorM).toBeLessThan(drive(ALL_OFF).finalErrorM);
  });
});
