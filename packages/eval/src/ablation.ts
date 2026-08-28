import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl, runEval } from './harness.js';
import type { EvalMetrics } from './metrics.js';
import { WINDOWS, aggregate, csv, f, markdown, svgChart, type Aggregate } from './report.js';
import { ABLATION_ORDER, ROOT, listLogs, loadConfig, loadGraphFor, parseArgs, readLog } from './paths.js';

/**
 * Run every config over every log and write the ablation table.
 *
 *   pnpm ablation
 *
 * Writes docs/benchmarks.md, docs/benchmarks.csv, docs/benchmarks.json and
 * docs/ablation.svg, and prints the table.
 *
 * ★ EVERY CONFIG SEES EXACTLY THE SAME DRIVES ★
 * Same logs, same outage windows, same order. The only thing that varies is the
 * constraint set, which is the only way the table means what it says. The
 * engine is deterministic — asserted in nav-core's invariant tests — so a rerun
 * on another machine reproduces these numbers exactly.
 */

function main(): void {
  const args = parseArgs(process.argv);
  const logs = args.log ? [String(args.log)] : listLogs();
  if (logs.length === 0) {
    throw new Error('no logs in data/replay/ — run `pnpm eval:record` first');
  }

  const configNames = args.config ? [String(args.config)] : ABLATION_ORDER;
  const graphNames = new Set<string>();
  const rows: Aggregate[] = [];

  console.log(`\n  ${logs.length} logs × ${WINDOWS.length} windows × ${configNames.length} configs\n`);

  // Parse each log once and reuse it: parsing dominates the runtime otherwise.
  const parsed = new Map(logs.map((l) => [l, parseJsonl(readLog(l))]));

  for (const configName of configNames) {
    const config = loadConfig(configName);
    const results: EvalMetrics[] = [];

    for (const logName of logs) {
      const samples = parsed.get(logName)!;
      const firstFix = samples.find((s) => s.gnss)?.gnss;
      if (!firstFix) continue;

      const wantsGraph = config.engine.roadSnap !== false;
      const found = wantsGraph ? loadGraphFor(firstFix.lat, firstFix.lon) : null;
      if (found) graphNames.add(found.name);

      for (const w of WINDOWS) {
        const { metrics } = runEval(samples, {
          configName: config.name,
          logName,
          engineConfig: config.engine,
          outageStartMs: w.startMs,
          outageDurationMs: w.durationMs,
          roadGraph: found?.graph ?? null,
        });
        results.push(metrics);
      }
    }

    const row = aggregate(config, results);
    rows.push(row);

    console.log(
      `  ${row.config.padEnd(18)} drift ${f(row.meanDriftPct).padStart(6)}%   ` +
        `median ${f(row.medianDriftPct).padStart(6)}%   p90 ${f(row.p90DriftPct).padStart(6)}%   ` +
        `max ${f(row.maxDriftPct).padStart(6)}%` +
        (row.discardedSamples > 0 ? `   ⚠ ${row.discardedSamples} discarded` : ''),
    );
  }

  const docs = join(ROOT, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'benchmarks.md'), markdown(rows, logs, graphNames));
  writeFileSync(join(docs, 'benchmarks.csv'), csv(rows));
  writeFileSync(join(docs, 'ablation.svg'), svgChart(rows));
  writeFileSync(
    join(docs, 'benchmarks.json'),
    `${JSON.stringify({ generatedFrom: logs, windows: WINDOWS, rows }, null, 2)}\n`,
  );
  // The in-app Benchmarks screen reads this copy.
  const publicDocs = join(ROOT, 'apps', 'web', 'public', 'benchmarks');
  mkdirSync(publicDocs, { recursive: true });
  writeFileSync(
    join(publicDocs, 'benchmarks.json'),
    `${JSON.stringify({ generatedFrom: logs, windows: WINDOWS, rows }, null, 2)}\n`,
  );

  console.log('\n  wrote docs/benchmarks.md, .csv, .json and ablation.svg');
  console.log('  wrote apps/web/public/benchmarks/benchmarks.json for the in-app screen\n');

  const full = rows.find((r) => r.config === 'full');
  if (full && Number.isFinite(full.meanDriftPct)) {
    const verdict = full.meanDriftPct < 10 ? 'inside' : 'ABOVE';
    console.log(
      `  full: ${f(full.meanDriftPct)}% mean drift — ${verdict} the problem statement's <10% target`,
    );
    console.log(`  p90 is ${f(full.p90DriftPct)}% — quote the mean and someone will find the tail.\n`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\n  ✖ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
