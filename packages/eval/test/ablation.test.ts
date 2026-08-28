import { beforeAll, describe, expect, it } from 'vitest';
import { parseJsonl, runEval } from '../src/harness.js';
import { ABLATION_ORDER, listLogs, loadConfig, loadGraphFor, readLog } from '../src/paths.js';
import type { SensorSample } from '@pathpulse/nav-core';

/**
 * The ablation, as a regression guard.
 *
 * ★ ONE IMPLEMENTATION, ONE NUMBER ★
 * This runs the SAME harness that `pnpm ablation` publishes, over the same
 * committed logs. An earlier version of this guard lived in sensor-sources with
 * its own scoring code, and the two quietly disagreed — 9.6% there against
 * 10.0% here, because that one snapped to the nearest truth fix while this one
 * interpolates. Two numbers for the same claim is worse than one imperfect
 * number, so the duplicate was deleted rather than reconciled.
 *
 * Everything here is committed and deterministic, so it needs no network, no
 * phone, and reproduces exactly on any machine.
 */

const WINDOWS = [
  { startMs: 30_000, durationMs: 60_000 },
  { startMs: 60_000, durationMs: 45_000 },
  { startMs: 45_000, durationMs: 90_000 },
] as const;

interface Row {
  name: string;
  runs: number;
  mean: number;
  p90: number;
  max: number;
}

const rows = new Map<string, Row>();

function meanDrift(configName: string, parsed: Map<string, SensorSample[]>): Row {
  const config = loadConfig(configName);
  const drifts: number[] = [];

  for (const [logName, samples] of parsed) {
    const firstFix = samples.find((s) => s.gnss)?.gnss;
    if (!firstFix) continue;
    const found =
      config.engine.roadSnap !== false ? loadGraphFor(firstFix.lat, firstFix.lon) : null;

    for (const w of WINDOWS) {
      const { metrics } = runEval(samples, {
        configName: config.name,
        logName,
        engineConfig: config.engine,
        outageStartMs: w.startMs,
        outageDurationMs: w.durationMs,
        roadGraph: found?.graph ?? null,
      });
      if (Number.isFinite(metrics.driftPercent)) drifts.push(metrics.driftPercent);
    }
  }

  const sorted = [...drifts].sort((a, b) => a - b);
  return {
    name: configName,
    runs: drifts.length,
    mean: drifts.reduce((a, b) => a + b, 0) / drifts.length,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!,
    max: sorted[sorted.length - 1]!,
  };
}

describe('ablation over the committed logs', () => {
  beforeAll(() => {
    const logs = listLogs();
    expect(logs.length, 'run `pnpm eval:record` to generate data/replay/').toBeGreaterThan(0);
    const parsed = new Map(logs.map((l) => [l, parseJsonl(readLog(l))]));
    for (const name of ABLATION_ORDER) rows.set(name, meanDrift(name, parsed));
  }, 300_000);

  const get = (n: string) => rows.get(n)!;

  it('scores every configuration over every scenario', () => {
    for (const name of ABLATION_ORDER) {
      expect(get(name).runs, name).toBeGreaterThan(0);
    }
    // Every config must see exactly the same drives, or the table is comparing
    // constraint sets against each other on different problems.
    const counts = new Set(ABLATION_ORDER.map((n) => get(n).runs));
    expect(counts.size).toBe(1);
  });

  it('beats naive integration by a wide margin', () => {
    expect(get('full').mean).toBeLessThan(get('naive').mean * 0.5);
  });

  it('improves, or holds, at every shipped step', () => {
    // A constraint that does not measurably help should be off, not shipped as
    // a row implying it does. forwardBias is excluded — it is a documented
    // negative result, asserted separately below.
    const shipped = ABLATION_ORDER.filter((n) => n !== 'full_forwardbias');
    for (let i = 1; i < shipped.length; i++) {
      const prev = get(shipped[i - 1]!);
      const cur = get(shipped[i]!);
      expect(cur.mean, `${cur.name} (${cur.mean.toFixed(1)}%) vs ${prev.name} (${prev.mean.toFixed(1)}%)`)
        .toBeLessThanOrEqual(prev.mean * 1.02);
    }
  });

  it('records the forward-bias negative result rather than hiding it', () => {
    // It was a clear win when it was the only thing removing the acceleration
    // runaway. The high-pass now does that job better, and stacking both is
    // worse than the high-pass alone — so it ships disabled, and this test
    // exists so the decision is revisited deliberately if that ever changes.
    expect(get('full_forwardbias').mean).toBeGreaterThan(get('full').mean);
  });

  it('does not regress past the figure published in docs/benchmarks.md', () => {
    // A guard, not a target. Published: 10.0% mean, 22.6% p90.
    expect(get('full').mean).toBeLessThan(13);
    // The tail matters more than the mean — it is what someone finds by
    // picking the one drive that went wrong.
    expect(get('full').p90).toBeLessThan(30);
  });
});
