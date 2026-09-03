import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRIFT_FEATURES } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { ROOT, listLogs, loadConfig, loadGraphFor, parseArgs, readLog } from './paths.js';

/**
 * Write the training set for Phase 13's drift-residual model.
 *
 *   pnpm eval:drift-dataset
 *
 * ★ THE GROUND TRUTH IS THE SAME TRICK THE WHOLE PROJECT RUNS ON ★
 * Drive somewhere with good GNSS, record everything, then delete GNSS from a
 * window of the recording in software. The estimator sees exactly what it
 * would see in a tunnel; we still hold the positions it cannot. So at every
 * dead-reckoning sample the ACTUAL error is known, decomposed along and across
 * the direction of travel — which is precisely the label a residual model
 * needs and precisely what no real drive can supply.
 *
 * Many outage windows per log, not the three the ablation uses: the model has
 * to see outages beginning at different speeds, on different parts of the
 * route, and lasting different lengths, or it learns one outage.
 *
 * ★ AND THE HONEST CAVEAT, WHICH IS LARGE ★
 * Every committed log is SIMULATED. A model trained on them has learned this
 * simulator's error, and the only claim available is whether that
 * generalises from one route type to another — which is what
 * ml/train_residual.py measures by holding out a whole route category. Real
 * recorded drives replace these logs and the model must be retrained on them
 * before any of this is claimed on a slide.
 */

const OUTAGE_STARTS_MS = [20_000, 35_000, 50_000, 65_000, 80_000, 95_000];
const OUTAGE_DURATIONS_MS = [30_000, 60_000, 90_000];

function main(): void {
  const args = parseArgs(process.argv);
  const logs = args.log ? [String(args.log)] : listLogs();
  if (logs.length === 0) throw new Error('no logs in data/replay/ — run `pnpm eval:record` first');

  const config = loadConfig('full');
  const header = ['log', 't', ...DRIFT_FEATURES, 'alongM', 'crossM'];
  const lines: string[] = [header.join(',')];
  let runs = 0;

  for (const logName of logs) {
    const samples = parseJsonl(readLog(logName));
    const firstFix = samples.find((s) => s.gnss)?.gnss;
    if (!firstFix) continue;
    const found = loadGraphFor(firstFix.lat, firstFix.lon);

    let rows = 0;
    for (const startMs of OUTAGE_STARTS_MS) {
      for (const durationMs of OUTAGE_DURATIONS_MS) {
        const run = runEval(samples, {
          configName: 'full',
          logName,
          engineConfig: config.engine,
          outageStartMs: startMs,
          outageDurationMs: durationMs,
          roadGraph: found?.graph ?? null,
          collectDriftRows: true,
        });
        runs++;
        for (const r of run.driftRows) {
          lines.push(
            [
              logName,
              r.t,
              ...r.features.map((v) => v.toFixed(5)),
              r.alongM.toFixed(4),
              r.crossM.toFixed(4),
            ].join(','),
          );
          rows++;
        }
      }
    }
    console.log(`  ${logName.padEnd(24)} ${rows.toString().padStart(7)} rows`);
  }

  const dir = join(ROOT, 'ml', 'data', 'processed');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'drift_rows.csv');
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`\n  ${runs} outage runs -> ${lines.length - 1} rows`);
  console.log(`  wrote ${out}\n`);
}

try {
  main();
} catch (err) {
  console.error(`\n  ✖ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
