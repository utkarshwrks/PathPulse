/**
 * TIER F — our own phone, our own vehicle, our own roads.
 *
 * Run with:  pnpm eval:tier-f
 *
 * ★ THE TIER THIS PROJECT HAS BEEN MISSING SINCE IT STARTED ★
 *
 * MASTER.md §22 has carried the same admission since it was written: "what we
 * have never measured: a drive with our own phone, in our own vehicle, through
 * a real tunnel, against surveyed ground truth. That is Tier F, it does not
 * exist." Every dead-reckoning decision has therefore been arbitrated by Tier S
 * — a physics simulator with no flyovers, no dense grids, no two-wheeler
 * vibration and no mounted-phone ambiguity — and it has already been wrong
 * once, preferring a configuration that measured worse on real sensors.
 *
 * The blocker was never the harness. It was that `pnpm eval:record` runs on a
 * laptop and nobody rides with one. `lib/sensorRecorder.ts` fixed that; this
 * scores what it produces.
 *
 * ★ TWO KINDS OF OUTAGE, AND ONLY ONE OF THEM CAN BE SCORED ★
 *
 * A Tier F log contains something no other tier has: a REAL outage, where the
 * rider actually switched the receiver off. That is the honest article — real
 * multipath on the way in, a real cold reacquisition on the way out — and it
 * cannot be scored the way drift is scored, because during it there is no
 * ground truth to compare against. What it can report is the RECOVERY: how far
 * the estimate had to jump when the fixes came back, over how far it thought
 * it had travelled. That number is the field report's own metric.
 *
 * So both are reported, separately and labelled:
 *
 *   SYNTHETIC — GNSS withheld over windows where the log actually has it, so
 *               the recorded fixes are the truth. Comparable with Tier S and
 *               Tier R, and the only rows that carry a drift percentage.
 *   REAL      — the outages the rider created. Recovery error only, and it is
 *               the number that matches what was on the HUD.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SensorSample } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { listLogs, loadConfig, loadGraphFor, ROOT } from './paths.js';

const DURATION_MS = 60_000;
/** Ignore a gap shorter than this: a slow receiver is not an outage. */
const REAL_OUTAGE_MIN_MS = 15_000;

function stats(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
    median: s[Math.floor(s.length / 2)] ?? Number.NaN,
    p90: s[Math.floor(s.length * 0.9)] ?? Number.NaN,
    best: s[0] ?? Number.NaN,
    worst: s[s.length - 1] ?? Number.NaN,
  };
}

const METRES_PER_DEG_LAT = 111_132;
function metresBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * METRES_PER_DEG_LAT);
}

interface Gap {
  startMs: number;
  endMs: number;
  /** Straight-line distance the vehicle actually covered across the gap, m. */
  truthSpanM: number;
}

/**
 * Stretches where the log carries no fix at all.
 *
 * ★ THIS IS WHAT THE RIDER DID, NOT WHAT WE ASKED FOR ★ Airplane mode, a
 * tunnel, a multi-storey — whatever it was, the receiver stopped and the
 * estimator was on its own. Found rather than configured, because the point of
 * a field log is that we did not choose the conditions.
 */
function realGaps(samples: readonly SensorSample[]): Gap[] {
  const fixes = samples.filter((s) => s.gnss);
  const gaps: Gap[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!;
    const b = fixes[i]!;
    const dt = b.t - a.t;
    if (dt < REAL_OUTAGE_MIN_MS) continue;
    gaps.push({
      startMs: a.t,
      endMs: b.t,
      truthSpanM: metresBetween(a.gnss!, b.gnss!),
    });
  }
  return gaps;
}

/**
 * Windows where the log has CONTINUOUS fixes, so withholding them leaves a
 * truth track to score against.
 *
 * A window straddling a real gap would be scored against a truth that does not
 * exist for part of it, which is how a Tier F table would quietly become
 * fiction.
 */
function syntheticWindows(samples: readonly SensorSample[], gaps: readonly Gap[]): number[] {
  // ★ A HANDSET LOG DOES NOT START AT ZERO ★ Android timestamps are milliseconds
  // since boot, so this file opens at t = 98,990,141 — twenty-seven hours in.
  // Windows have to be placed relative to the log's own beginning, or every one
  // of them lands before the first sample and the table comes out empty.
  const first = samples[0]!.t;
  const last = samples[samples.length - 1]!.t;
  const out: number[] = [];
  for (let t = first + 20_000; t + DURATION_MS < last - 15_000; t += 30_000) {
    const clash = gaps.some((g) => t < g.endMs && t + DURATION_MS > g.startMs);
    if (!clash) out.push(t);
  }
  return out;
}

const configName = process.argv.includes('--config')
  ? String(process.argv[process.argv.indexOf('--config') + 1])
  : 'full';
const cfg = loadConfig(configName);

const logs = listLogs('F');
if (logs.length === 0) {
  console.log(
    '\n  No Tier F logs. Record one on the handset — Events tab, "Record ride" —\n' +
      '  and drop the drive_*.jsonl into data/replay/.\n',
  );
  process.exit(0);
}

console.log(`\n  TIER F — our own phone, our own vehicle\n`);
console.log(`  config: ${configName}   ${DURATION_MS / 1000}s synthetic outages\n`);

const allDrift: number[] = [];
const perLog: Array<{
  name: string;
  s: ReturnType<typeof stats>;
  gaps: Array<{ seconds: number; truthSpanM: number; recoveryM: number; percent: number }>;
  minutes: number;
  fixes: number;
}> = [];

for (const logName of logs) {
  const file = join(ROOT, 'data/replay', logName);
  const samples = parseJsonl(readFileSync(file, 'utf8'));
  if (samples.length < 100) continue;
  const first = samples.find((s) => s.gnss);
  if (!first?.gnss) {
    console.log(`  ${logName}: no fixes at all, skipped`);
    continue;
  }
  const picked = loadGraphFor(first.gnss.lat, first.gnss.lon);
  const graph = picked?.graph ?? null;
  const gaps = realGaps(samples);
  const windows = syntheticWindows(samples, gaps);
  const minutes = (samples[samples.length - 1]!.t - samples[0]!.t) / 60_000;
  const fixes = samples.filter((s) => s.gnss).length;

  console.log(
    `  ${logName}  ${minutes.toFixed(1)} min · ${samples.length.toLocaleString()} samples · ` +
      `${fixes} fixes · graph ${picked?.name ?? 'NONE'}`,
  );

  const drifts: number[] = [];
  for (const w of windows) {
    const res = runEval(samples, {
      configName,
      logName,
      engineConfig: cfg.engine as never,
      outageStartMs: w,
      outageDurationMs: DURATION_MS,
      roadGraph: graph,
      // Tier F is our own handset, which runs the speed model. Withholding it
      // here would measure a configuration nobody ships.
      speedModel: true,
    });
    const d = res.metrics.driftPercent;
    if (Number.isFinite(d)) {
      drifts.push(d);
      allDrift.push(d);
    }
    // ★ A DRIFT PERCENTAGE OVER A SHORT WINDOW IS MOSTLY ITS DENOMINATOR ★
    // City stop-go means a 60 s window can cover 20 m, and 15 m of error over
    // 20 m is 75 % that says almost nothing about the estimator. The distance
    // has to be on the row or the table cannot be read honestly.
    if (process.argv.includes('--windows')) {
      console.log(
        `      +${((w - samples[0]!.t) / 1000).toFixed(0).padStart(4)}s  ` +
          `truth ${res.metrics.distanceTravelledM.toFixed(0).padStart(5)} m  ` +
          `drift ${Number.isFinite(d) ? d.toFixed(1).padStart(6) : '     —'} %  ` +
          `err ${(((d / 100) * res.metrics.distanceTravelledM) || 0).toFixed(1).padStart(6)} m`,
      );
    }
  }

  // The real outages, scored on recovery rather than on drift.
  const scoredGaps = gaps.map((g) => {
    const res = runEval(samples, {
      configName,
      logName,
      engineConfig: cfg.engine as never,
      // Nothing withheld: the log already has the hole in it.
      outageStartMs: g.endMs + 1,
      outageDurationMs: 1,
      roadGraph: graph,
      speedModel: true,
    });
    // Where the estimate was when the fixes came back, against where the
    // receiver said it was.
    const at = res.states.reduce((best, s) =>
      Math.abs(s.t - g.endMs) < Math.abs(best.t - g.endMs) ? s : best,
    );
    const truth = samples.find((s) => s.t >= g.endMs && s.gnss)?.gnss;
    const recoveryM = truth ? metresBetween(at.position, truth) : Number.NaN;
    return {
      seconds: (g.endMs - g.startMs) / 1000,
      truthSpanM: g.truthSpanM,
      recoveryM,
      percent: g.truthSpanM > 1 ? (recoveryM / g.truthSpanM) * 100 : Number.NaN,
    };
  });

  perLog.push({ name: logName, s: stats(drifts), gaps: scoredGaps, minutes, fixes });
}

console.log(
  `\n    ${'log'.padEnd(28)} ${'n'.padStart(3)} ${'mean'.padStart(7)} ${'median'.padStart(7)} ` +
    `${'p90'.padStart(7)} ${'best'.padStart(7)} ${'worst'.padStart(7)}`,
);
for (const r of perLog) {
  const s = r.s;
  console.log(
    `    ${r.name.padEnd(28)} ${String(s.n).padStart(3)} ${s.mean.toFixed(1).padStart(7)} ` +
      `${s.median.toFixed(1).padStart(7)} ${s.p90.toFixed(1).padStart(7)} ` +
      `${s.best.toFixed(1).padStart(7)} ${s.worst.toFixed(1).padStart(7)}`,
  );
}
const overall = stats(allDrift);
if (allDrift.length) {
  console.log(
    `    ${'OVERALL'.padEnd(28)} ${String(overall.n).padStart(3)} ` +
      `${overall.mean.toFixed(1).padStart(7)} ${overall.median.toFixed(1).padStart(7)} ` +
      `${overall.p90.toFixed(1).padStart(7)} ${overall.best.toFixed(1).padStart(7)} ` +
      `${overall.worst.toFixed(1).padStart(7)}`,
  );
}

const anyGaps = perLog.some((r) => r.gaps.length > 0);
if (anyGaps) {
  console.log(`\n  REAL outages the rider created — recovery error, not drift\n`);
  for (const r of perLog) {
    for (const g of r.gaps) {
      console.log(
        `    ${r.name.padEnd(28)} ${g.seconds.toFixed(0).padStart(4)}s  ` +
          `moved ${g.truthSpanM.toFixed(0).padStart(5)} m  ` +
          `recovery ${g.recoveryM.toFixed(1).padStart(7)} m  ` +
          `${Number.isFinite(g.percent) ? `${g.percent.toFixed(1)}%` : '—'}`,
      );
    }
  }
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const doc = `# PathPulse — TIER F benchmarks

**Generated by \`pnpm eval:tier-f\`. Do not edit by hand — rerun it.**

Our own handset, our own vehicle, our own roads, recorded by the app itself
(Events tab → *Record ride*) and dropped into \`data/replay/\` as
\`drive_*.jsonl\`.

> This is the tier MASTER.md §22 said did not exist. Every dead-reckoning
> decision before it was arbitrated by Tier S — a physics simulator containing
> no flyovers, no dense grids, no two-wheeler vibration and no mounted-phone
> ambiguity. **When Tier S and Tier F disagree, Tier F wins.**

## Synthetic outages

GNSS withheld over ${DURATION_MS / 1000} s windows where the log actually has
continuous fixes, so the recorded fixes are the ground truth. Windows that would
straddle a real outage are skipped — there is no truth to score against inside
one. These are the only rows carrying a drift percentage, and they are
comparable with the other tiers.

| log | n | mean % | median % | p90 % | best % | worst % |
|---|---|---|---|---|---|---|
${perLog
  .map(
    (r) =>
      `| \`${r.name}\` | ${r.s.n} | ${f(r.s.mean)} | ${f(r.s.median)} | ${f(r.s.p90)} | ${f(r.s.best)} | ${f(r.s.worst)} |`,
  )
  .join('\n')}
${allDrift.length ? `| **OVERALL** | ${overall.n} | **${f(overall.mean)}** | **${f(overall.median)}** | ${f(overall.p90)} | ${f(overall.best)} | ${f(overall.worst)} |` : ''}

## Real outages

The receiver actually switched off. There is no ground truth during one, so
these are scored on **recovery** — how far the estimate had to jump when the
fixes returned, over how far the vehicle actually moved. This is the number that
was on the HUD.

| log | duration | vehicle moved | recovery error | % |
|---|---|---|---|---|
${perLog
  .flatMap((r) =>
    r.gaps.map(
      (g) =>
        `| \`${r.name}\` | ${g.seconds.toFixed(0)} s | ${g.truthSpanM.toFixed(0)} m | ${f(g.recoveryM)} m | ${f(g.percent)} |`,
    ),
  )
  .join('\n') || '| — | — | — | — | — |'}

## Logs

| log | minutes | samples | fixes |
|---|---|---|---|
${perLog.map((r) => `| \`${r.name}\` | ${r.minutes.toFixed(1)} | — | ${r.fixes} |`).join('\n')}
`;

writeFileSync(join(ROOT, 'docs/benchmarks-tier-f.md'), doc);
console.log(`\n  wrote docs/benchmarks-tier-f.md\n`);
if (!existsSync(join(ROOT, 'docs/benchmarks-tier-f.md'))) process.exit(1);
