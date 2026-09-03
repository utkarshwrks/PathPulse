import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoadIndex, latLonToEnu, type NavigationState, type SensorSample } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { ROOT, listLogs, loadConfig, loadGraphFor, parseArgs, readLog } from './paths.js';

/**
 * How far the DRAWN marker is from the nearest road while dead reckoning.
 *
 *   pnpm eval:offroad
 *
 * ★ WHY THIS METRIC EXISTS ★
 *
 * Drift percentage — the number the ablation publishes and the problem
 * statement sets a target for — is the distance between the estimate and the
 * truth. It is the right headline and it is blind to the thing a person
 * actually notices. A marker 30 m along the road from where the vehicle really
 * is looks perfect. A marker 30 m to the SIDE of the road is sitting in
 * somebody's plot, and no drift figure distinguishes the two.
 *
 * The field report was exactly that: "when it goes to dead reckoning it goes
 * off the road, into the plots" — on a build whose measured drift was 10 %.
 * Both statements were true at once, because nothing was measuring this.
 *
 * Ground truth here is the road network itself, which is the point: the claim
 * being tested is not "close to where it was" but "on a road at all".
 */

const WINDOWS = [
  { startMs: 30_000, durationMs: 60_000 },
  { startMs: 60_000, durationMs: 45_000 },
  { startMs: 45_000, durationMs: 90_000 },
] as const;

/**
 * Distance to the nearest road, searching far wider than the snapper does.
 *
 * Deliberately unbounded-ish: a metric that gave up at the same radius the
 * thing being measured gives up at would report its worst failures as zero.
 */
export function distanceToNearestRoadM(index: RoadIndex, e: number, n: number): number {
  let best = Infinity;
  for (const seg of index.nearbySegments(e, n, 800)) {
    const dx = seg.e2 - seg.e1;
    const dy = seg.n2 - seg.n1;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((e - seg.e1) * dx + (n - seg.n1) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(e - (seg.e1 + dx * t), n - (seg.n1 + dy * t)));
  }
  return best;
}

export interface OffRoadStats {
  samples: number;
  meanM: number;
  medianM: number;
  p90M: number;
  maxM: number;
  /** Fraction of drawn dead-reckoning samples more than 10 m from any road. */
  beyond10M: number;
  beyond25M: number;
}

function summarise(d: number[]): OffRoadStats {
  const sorted = [...d].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
  return {
    samples: d.length,
    meanM: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length),
    medianM: at(0.5),
    p90M: at(0.9),
    maxM: at(1),
    beyond10M: d.filter((x) => x > 10).length / Math.max(1, d.length),
    beyond25M: d.filter((x) => x > 25).length / Math.max(1, d.length),
  };
}

/** Run one config over every log and window, scoring only what was DRAWN. */
export function measureOffRoad(configName = 'full'): OffRoadStats {
  const config = loadConfig(configName);
  const distances: number[] = [];

  for (const logName of listLogs()) {
    const samples = parseJsonl(readLog(logName));
    const firstFix = samples.find((s: SensorSample) => s.gnss)?.gnss;
    if (!firstFix) continue;
    const found = loadGraphFor(firstFix.lat, firstFix.lon);
    if (!found) continue;
    const index = new RoadIndex(found.graph, firstFix.lat, firstFix.lon);

    for (const w of WINDOWS) {
      const { states } = runEval(samples, {
        configName,
        logName,
        engineConfig: config.engine,
        outageStartMs: w.startMs,
        outageDurationMs: w.durationMs,
        roadGraph: found.graph,
      });

      for (const st of states as NavigationState[]) {
        if (st.mode !== 'DEAD_RECKONING') continue;
        if (!Number.isFinite(st.position.lat) || !Number.isFinite(st.position.lon)) continue;
        const p = latLonToEnu(st.position.lat, st.position.lon, firstFix.lat, firstFix.lon);
        const d = distanceToNearestRoadM(index, p.e, p.n);
        if (Number.isFinite(d)) distances.push(d);
      }
    }
  }

  return summarise(distances);
}

function main(): void {
  const args = parseArgs(process.argv);
  const configs = args.config ? [String(args.config)] : ['full', 'highpass'];

  console.log('\n  Distance from the DRAWN marker to the nearest road, dead reckoning only\n');
  console.log('  config       n      mean    median     p90      max    >10m    >25m');
  console.log('  ─────────────────────────────────────────────────────────────────────');

  const rows: Array<{ config: string; stats: OffRoadStats }> = [];
  for (const c of configs) {
    const stats = measureOffRoad(c);
    rows.push({ config: c, stats });
    console.log(
      `  ${c.padEnd(11)} ${String(stats.samples).padStart(6)} ` +
        `${stats.meanM.toFixed(1).padStart(7)}m ${stats.medianM.toFixed(1).padStart(7)}m ` +
        `${stats.p90M.toFixed(1).padStart(7)}m ${stats.maxM.toFixed(1).padStart(7)}m ` +
        `${(stats.beyond10M * 100).toFixed(1).padStart(6)}% ${(stats.beyond25M * 100).toFixed(1).padStart(6)}%`,
    );
  }

  const docs = join(ROOT, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, 'offroad.md'),
    `# Is the marker on a road?

Generated by \`pnpm eval:offroad\`. Do not edit by hand.

Drift percentage measures the distance between the estimate and the truth. It
is the right headline and it is blind to what a person actually notices: a
marker 30 m *along* the road looks perfect, and a marker 30 m *to the side* of
it is sitting in somebody's plot. Same drift, completely different demo.

This measures the second thing. Ground truth is the road network itself, and
only samples the engine drew while \`DEAD_RECKONING\` are counted.

| Config | samples | mean | median | p90 | max | >10 m | >25 m |
|---|---|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.config} | ${r.stats.samples} | ${r.stats.meanM.toFixed(1)} m | ${r.stats.medianM.toFixed(1)} m | ${r.stats.p90M.toFixed(1)} m | ${r.stats.maxM.toFixed(1)} m | ${(r.stats.beyond10M * 100).toFixed(1)} % | ${(r.stats.beyond25M * 100).toFixed(1)} % |`,
  )
  .join('\n')}

\`highpass\` is the same estimator with road snapping switched off, so the gap
between the rows is what snapping is worth — measured on the axis it exists to
improve rather than on the one it was previously judged by.
`,
  );
  console.log('\n  wrote docs/offroad.md\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`\n  ✖ ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
