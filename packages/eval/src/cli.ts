import { parseJsonl, runEval } from './harness.js';
import { loadConfig, loadGraphFor, parseArgs, readLog } from './paths.js';

/**
 * Evaluate one log against one config.
 *
 *   pnpm eval -- --log sim_city_4242.jsonl --config full
 *   pnpm eval -- --log sim_city_4242.jsonl --config naive \
 *                --outage-start 30000 --outage-duration 60000
 *   pnpm eval -- --log sim_city_4242.jsonl --config full --json
 *
 * Ground truth is the log's own recorded GNSS, withheld from the estimator over
 * the outage window. See harness.ts for why that is honest.
 */

const USAGE = `
pnpm eval -- --log <file.jsonl> --config <name> [options]

  --log                a file in data/replay/, or a path
  --config             a name in configs/ (naive, filtered, zupt, nhc, full...)
  --outage-start       ms into the log, default 30000
  --outage-duration    ms, default 60000
  --no-road-graph      evaluate without map matching even where a graph exists
  --json               emit only the metrics JSON, for piping

Available logs:   pnpm eval -- --list
`;

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function main(): void {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    console.log(USAGE);
    return;
  }

  if (!args.log || !args.config) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const logName = String(args.log);
  const config = loadConfig(String(args.config));
  const outageStartMs = Number(args['outage-start'] ?? 30_000);
  const outageDurationMs = Number(args['outage-duration'] ?? 60_000);

  const samples = parseJsonl(readLog(logName));
  if (samples.length === 0) throw new Error(`log "${logName}" contains no usable samples`);

  const firstFix = samples.find((s) => s.gnss)?.gnss;
  if (!firstFix) throw new Error(`log "${logName}" has no GNSS, so there is no ground truth`);

  const wantsGraph = config.engine.roadSnap !== false && !args['no-road-graph'];
  const found = wantsGraph ? loadGraphFor(firstFix.lat, firstFix.lon) : null;

  const { metrics } = runEval(samples, {
    configName: config.name,
    logName,
    engineConfig: config.engine,
    outageStartMs,
    outageDurationMs,
    roadGraph: found?.graph ?? null,
  });

  if (args.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  const graphNote = wantsGraph
    ? found
      ? `road graph: ${found.name}`
      : 'road graph: NONE COVERS THIS AREA — snapping did not engage'
    : 'road graph: disabled';

  console.log(`\n  ${config.name}  ·  ${logName}`);
  if (config.description) console.log(`  ${config.description}`);
  console.log(
    `  outage ${outageStartMs / 1000}s .. ${(outageStartMs + outageDurationMs) / 1000}s  ·  ${graphNote}\n`,
  );

  const rows: Array<[string, string]> = [
    ['distance travelled', `${fmt(metrics.distanceTravelledM)} m`],
    ['final error', `${fmt(metrics.finalErrorM)} m`],
    ['DRIFT', `${fmt(metrics.driftPercent, 2)} %`],
    ['RMSE', `${fmt(metrics.rmseM)} m`],
    ['MAE', `${fmt(metrics.maeM)} m`],
    ['max error', `${fmt(metrics.maxErrorM)} m`],
    ['along-track RMSE', `${fmt(metrics.alongTrackRmseM)} m`],
    ['cross-track RMSE', `${fmt(metrics.crossTrackRmseM)} m`],
    ['CEP95', `${fmt(metrics.cep95M)} m`],
    [
      'recovery time',
      metrics.recoveryTimeS === null ? 'never recovered' : `${fmt(metrics.recoveryTimeS, 2)} s`,
    ],
    ['mean update rate', `${fmt(metrics.meanUpdateHz)} Hz`],
    ['ZUPT / ZARU', `${metrics.zuptTriggers} / ${metrics.zaruTriggers}`],
    ['road snap applied', `${fmt(metrics.roadSnapAppliedPct)} %`],
    ['position resets', String(metrics.positionResets)],
    ['samples scored', String(metrics.samples)],
  ];
  if (metrics.discardedSamples > 0) {
    // Never silent. nav-core asserts it cannot emit a non-finite state, so a
    // non-zero count here means something upstream is broken.
    rows.push(['⚠ DISCARDED', `${metrics.discardedSamples} non-finite`]);
  }

  for (const [k, v] of rows) {
    console.log(`  ${k.padEnd(20)} ${v.padStart(16)}`);
  }
  console.log('');
}

try {
  const args = parseArgs(process.argv);
  if (args.list) {
    const { listLogs } = await import('./paths.js');
    const logs = listLogs();
    console.log(logs.length ? `\n  ${logs.join('\n  ')}\n` : '\n  no logs in data/replay/\n');
  } else {
    main();
  }
} catch (err) {
  console.error(`\n  ✖ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
