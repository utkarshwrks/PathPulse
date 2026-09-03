import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SensorSample } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { ROOT, listLogs, loadConfig, loadGraphFor, parseArgs, readLog } from './paths.js';

/**
 * Phase 12 — what a crooked phone costs, and how much of it alignment recovers.
 *
 *   pnpm eval:alignment
 *
 * ★ WHY THIS EXISTS INSTEAD OF AN ABLATION ROW ★
 *
 * `pnpm ablation` cannot evaluate automatic alignment, and adding a row for it
 * would be worse than useless — it would be actively misleading. Every
 * recorded log was made with the phone square to the vehicle, so the true
 * mount offset is zero. On those logs an alignment engine has nothing to find
 * and every degree it estimates is pure error: the row would show a cost, no
 * benefit, and invite exactly the wrong conclusion.
 *
 * The question the ablation cannot ask is the only one that matters: what
 * happens when the phone ISN'T square? So this rotates the IMU of the same
 * logs by a known angle about the device vertical — which is precisely what
 * propping the handset at an angle in a holder does — and re-runs the same
 * harness, with alignment on and off, over the same outage windows.
 *
 * The rotation is applied to the raw accelerometer and gyroscope before the
 * engine sees anything, so the engine has no way to know it happened. Ground
 * truth is untouched: the vehicle drove where it drove.
 */

/** Rotate the device frame about its own vertical — a phone turned in its mount. */
function rotateMount(samples: readonly SensorSample[], deg: number): SensorSample[] {
  if (deg === 0) return samples as SensorSample[];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return samples.map((sample) => {
    if (!sample.imu) return sample;
    const { ax, ay, gx, gy } = sample.imu;
    return {
      ...sample,
      imu: {
        ...sample.imu,
        // ★ R(-deg), NOT R(+deg) ★ Turning the HANDSET by +deg expresses every
        // world vector in a frame that has itself turned by +deg, so the
        // components transform by the INVERSE rotation. Getting this backwards
        // rotates the phone the other way, and the first version of this table
        // duly reported an estimation error of exactly twice the mount angle
        // at every angle — the estimator was right and the test rig was wrong.
        ax: ax * c + ay * s,
        ay: -ax * s + ay * c,
        // The gyroscope lives in the same frame and must turn with it. Rotating
        // only the accelerometer would be a physically impossible handset and
        // would flatter the result.
        gx: gx * c + gy * s,
        gy: -gx * s + gy * c,
      },
    };
  });
}

const WINDOWS = [
  { startMs: 30_000, durationMs: 60_000 },
  { startMs: 60_000, durationMs: 45_000 },
  { startMs: 45_000, durationMs: 90_000 },
] as const;

const MOUNT_ANGLES = [0, 15, 30, 45, 60, 90];

interface Cell {
  deg: number;
  autoAlign: boolean;
  meanDriftPct: number;
  p90DriftPct: number;
  runs: number;
  /** Mean absolute error of the estimated mount angle, degrees. */
  alignErrDeg: number | null;
}

function main(): void {
  const args = parseArgs(process.argv);
  const logs = args.log ? [String(args.log)] : listLogs();
  if (logs.length === 0) throw new Error('no logs in data/replay/ — run `pnpm eval:record` first');

  const base = loadConfig('full');
  const parsed = new Map(logs.map((l) => [l, parseJsonl(readLog(l))]));

  console.log(
    `\n  ${logs.length} logs x ${WINDOWS.length} windows x ${MOUNT_ANGLES.length} mount angles x 2\n`,
  );

  const cells: Cell[] = [];

  for (const deg of MOUNT_ANGLES) {
    for (const autoAlign of [false, true]) {
      const drifts: number[] = [];
      const alignErrors: number[] = [];

      for (const logName of logs) {
        const samples = rotateMount(parsed.get(logName)!, deg);
        const firstFix = samples.find((s) => s.gnss)?.gnss;
        if (!firstFix) continue;
        const found = loadGraphFor(firstFix.lat, firstFix.lon);

        for (const w of WINDOWS) {
          const { metrics } = runEval(samples, {
            configName: `mount${deg}${autoAlign ? '+auto' : ''}`,
            logName,
            engineConfig: { ...base.engine, autoAlign },
            outageStartMs: w.startMs,
            outageDurationMs: w.durationMs,
            roadGraph: found?.graph ?? null,
          });
          if (Number.isFinite(metrics.driftPercent)) drifts.push(metrics.driftPercent);
        }

        if (autoAlign) {
          // What did the engine conclude the mount was? Read from a run with
          // no outage, so the whole drive is available to align against.
          const probe = runEval(samples, {
            configName: 'alignment-probe',
            logName,
            engineConfig: { ...base.engine, autoAlign: true },
            outageStartMs: Number.MAX_SAFE_INTEGER,
            outageDurationMs: 1,
            roadGraph: found?.graph ?? null,
          });
          if (probe.alignmentDeg !== null) {
            alignErrors.push(Math.abs(shortestAngleDeg(probe.alignmentDeg - deg)));
          }
        }
      }

      const sorted = [...drifts].sort((a, b) => a - b);
      cells.push({
        deg,
        autoAlign,
        runs: drifts.length,
        meanDriftPct: drifts.reduce((a, b) => a + b, 0) / Math.max(1, drifts.length),
        p90DriftPct: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? NaN,
        alignErrDeg: alignErrors.length
          ? alignErrors.reduce((a, b) => a + b, 0) / alignErrors.length
          : null,
      });
    }
  }

  print(cells);
  const docs = join(ROOT, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'alignment.md'), markdown(cells, logs));
  console.log('  wrote docs/alignment.md\n');
}

const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '—');

function shortestAngleDeg(d: number): number {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function print(cells: Cell[]): void {
  console.log('  mount    alignment OFF        alignment ON      est. error   recovered');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  for (const deg of MOUNT_ANGLES) {
    const off = cells.find((c) => c.deg === deg && !c.autoAlign)!;
    const on = cells.find((c) => c.deg === deg && c.autoAlign)!;
    const recovered =
      off.meanDriftPct > on.meanDriftPct
        ? `${(((off.meanDriftPct - on.meanDriftPct) / Math.max(1e-9, off.meanDriftPct)) * 100).toFixed(0)}%`
        : '—';
    const err = on.alignErrDeg === null ? '  —' : `${f(on.alignErrDeg)}°`;
    console.log(
      `  ${String(deg).padStart(3)}°     ${f(off.meanDriftPct).padStart(6)}% mean       ` +
        `${f(on.meanDriftPct).padStart(6)}% mean      ${err.padStart(7)}      ${recovered.padStart(5)}`,
    );
  }
  console.log('');
}

function markdown(cells: Cell[], logs: string[]): string {
  const rows = MOUNT_ANGLES.map((deg) => {
    const off = cells.find((c) => c.deg === deg && !c.autoAlign)!;
    const on = cells.find((c) => c.deg === deg && c.autoAlign)!;
    return `| ${deg}° | ${f(off.meanDriftPct)} | ${f(off.p90DriftPct)} | ${f(on.meanDriftPct)} | ${f(on.p90DriftPct)} |`;
  }).join('\n');

  return `# Phase 12 — the cost of a crooked phone

Generated by \`pnpm eval:alignment\`. Do not edit by hand.

The same logs as [benchmarks.md](./benchmarks.md), with the raw accelerometer
and gyroscope rotated about the device vertical by a known angle before the
engine sees them — which is exactly what propping the handset at an angle in a
holder does. Ground truth is untouched: the vehicle drove where it drove.

**Why this is not a row in the ablation table.** Every recorded log was made
with the phone square to the vehicle, so on those logs the true mount offset is
zero, an alignment engine has nothing to find, and every degree it estimates is
pure error. The ablation would show a cost and no benefit, and invite exactly
the wrong conclusion. The question worth asking is what happens when the phone
*isn't* square, and that question needs this table.

Logs: ${logs.join(', ')}. ${WINDOWS.length} outage windows each.

| Mount offset | OFF mean % | OFF p90 % | ON mean % | ON p90 % |
|---|---|---|---|---|
${rows}

0° is the control: there the alignment engine can only cost, and the size of
that cost is the price paid for the rest of the column.
`;
}

try {
  main();
} catch (err) {
  console.error(`\n  ✖ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
