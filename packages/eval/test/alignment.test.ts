import { beforeAll, describe, expect, it } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from '../src/harness.js';
import { listLogs, loadConfig, loadGraphFor, readLog } from '../src/paths.js';

/**
 * Phase 12, as a regression guard.
 *
 * The claim is narrow and testable: with automatic alignment on, drift stops
 * depending on how the phone was mounted. Without it, drift climbs with the
 * mount angle until the system is useless. Both halves are asserted, because
 * the second is what makes the first worth having.
 *
 * Same logs, same harness, same windows as the ablation — the only thing that
 * changes is that the raw IMU is rotated about the device vertical first.
 */

const WINDOWS = [
  { startMs: 30_000, durationMs: 60_000 },
  { startMs: 60_000, durationMs: 45_000 },
] as const;

/**
 * Turn the handset by `deg` in its mount.
 *
 * R(-deg), not R(+deg): rotating the DEVICE expresses every world vector in a
 * frame that has itself turned, so the components transform by the inverse.
 */
function rotateMount(samples: readonly SensorSample[], deg: number): SensorSample[] {
  if (deg === 0) return samples as SensorSample[];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return samples.map((sample) =>
    sample.imu
      ? {
          ...sample,
          imu: {
            ...sample.imu,
            ax: sample.imu.ax * c + sample.imu.ay * s,
            ay: -sample.imu.ax * s + sample.imu.ay * c,
            gx: sample.imu.gx * c + sample.imu.gy * s,
            gy: -sample.imu.gx * s + sample.imu.gy * c,
          },
        }
      : sample,
  );
}

interface Row {
  meanDriftPct: number;
  meanAlignErrDeg: number | null;
}

const results = new Map<string, Row>();
const key = (deg: number, autoAlign: boolean) => `${deg}:${autoAlign}`;

describe('Phase 12 — alignment against a rotated mount', () => {
  beforeAll(() => {
    const logs = listLogs();
    expect(logs.length, 'run `pnpm eval:record` first').toBeGreaterThan(0);
    const base = loadConfig('full');
    const parsed = new Map(logs.map((l) => [l, parseJsonl(readLog(l))]));

    for (const deg of [0, 45, 90]) {
      for (const autoAlign of [false, true]) {
        const drifts: number[] = [];
        const errs: number[] = [];

        for (const logName of logs) {
          const samples = rotateMount(parsed.get(logName)!, deg);
          const firstFix = samples.find((s) => s.gnss)?.gnss;
          if (!firstFix) continue;
          const found = loadGraphFor(firstFix.lat, firstFix.lon);

          for (const w of WINDOWS) {
            const run = runEval(samples, {
              configName: `mount${deg}`,
              logName,
              engineConfig: { ...base.engine, autoAlign },
              outageStartMs: w.startMs,
              outageDurationMs: w.durationMs,
              roadGraph: found?.graph ?? null,
            });
            if (Number.isFinite(run.metrics.driftPercent)) drifts.push(run.metrics.driftPercent);
            if (autoAlign && run.alignmentDeg !== null) {
              let d = run.alignmentDeg - deg;
              while (d > 180) d -= 360;
              while (d < -180) d += 360;
              errs.push(Math.abs(d));
            }
          }
        }

        results.set(key(deg, autoAlign), {
          meanDriftPct: drifts.reduce((a, b) => a + b, 0) / Math.max(1, drifts.length),
          meanAlignErrDeg: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
        });
      }
    }
  }, 600_000);

  const get = (deg: number, autoAlign: boolean) => results.get(key(deg, autoAlign))!;

  it('a crooked phone genuinely wrecks dead reckoning when nothing corrects it', () => {
    // Without this half the other half proves nothing.
    expect(get(90, false).meanDriftPct).toBeGreaterThan(get(0, false).meanDriftPct * 2);
  });

  it('finds the mount angle to within a few degrees, at every angle', () => {
    for (const deg of [0, 45, 90]) {
      const err = get(deg, true).meanAlignErrDeg;
      expect(err, `${deg}° mount`).not.toBeNull();
      expect(err!, `${deg}° mount`).toBeLessThan(10);
    }
  });

  it('makes drift independent of how the phone was mounted', () => {
    // ★ THE CLAIM OF THE PHASE ★ Not "better" — INDEPENDENT. A 90 degree mount
    // should cost about what a perfect one costs.
    const flat = get(0, true).meanDriftPct;
    for (const deg of [45, 90]) {
      expect(get(deg, true).meanDriftPct, `${deg}° mount`).toBeLessThan(flat * 1.3);
    }
  });

  it('costs little on a phone that was mounted perfectly anyway', () => {
    // The price of measuring something instead of assuming it. Assuming it is
    // free and correct exactly once: when the assumption happens to be true.
    expect(get(0, true).meanDriftPct).toBeLessThan(get(0, false).meanDriftPct + 1);
  });
});
