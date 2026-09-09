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
    // a row implying it does. Two rows are excluded because they are NOT
    // shipped steps — they are alternatives that are off by default, each with
    // its own assertion below: forwardBias (a documented negative result) and
    // eskf (Phase 11's filter, which wins on the tail and loses on the mean)
    // hmm (Phase 14's matcher, whose value these routes cannot show) and
    // particle (Phase 17's filter, which helps in the city and hurts on the
    // highway — asserted separately, because the average of those two is the
    // least informative number available).
    const notShipped = new Set(['full_forwardbias', 'eskf', 'greedy', 'particle']);
    const shipped = ABLATION_ORDER.filter((n) => !notShipped.has(n));
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

  it('records the ESKF result as measured, and it no longer trades', () => {
    // ★ PHASE 11, REPORTED HONESTLY — AND THE REPORT HAS CHANGED ★
    //
    // This used to assert a trade in both directions: the filter worse in the
    // middle of the distribution (mean) and better at the end of it (p90), on
    // the reasoning that the hand-tuned chain is very good on the runs it was
    // tuned against while the filter's covariance bookkeeping is what stops
    // the bad runs getting as bad. That was true and it is not true any more.
    //
    // The road heading aid took `full`'s p90 from 22.6 % to 15.1 % — it closes
    // the same failure the filter's bookkeeping was closing, and closes it
    // harder, because a road is a measurement of heading and a covariance is
    // only an opinion about one. The tail the ESKF used to win is gone, and
    // at 15.7 % against 15.1 % it now loses on both halves.
    //
    // Asserted rather than deleted: the filter is still the more principled
    // estimator and the day it wins again, this is what will notice.
    // ★ AND THE COMPARISON FLIPPED WHEN TIER F ARRIVED ★
    //
    // `full` now carries two guards Tier F asked for — `outageSpeedCeiling`
    // and a trust gate that withholds the speed model until GNSS has scored
    // it — and both cost simulated drift while cutting the real-ride figure
    // from 52.6 % to 39.9 %. On this corpus the ESKF arm is therefore now the
    // BETTER of the two, which is a statement about the corpus rather than
    // about the filter: Tier S contains none of the geometry those guards
    // exist for. §24.13 still has the filter off, on its own measured grounds.
    //
    // Asserted in whichever direction it lands, because the point is that the
    // relationship stays recorded rather than that it stays fixed.
    const eskf = get('eskf');
    const full = get('full');
    expect(Math.abs(eskf.mean - full.mean)).toBeLessThan(full.mean * 0.5);
    // Neither may diverge — that is not a trade-off, it is a bug, and it was
    // one twice while this was written.
    expect(eskf.mean).toBeLessThan(25);
    expect(full.mean).toBeLessThan(25);
  });

  it('records the HMM result as measured, including that it did not help here', () => {
    // ★ PHASE 14, REPORTED HONESTLY ★
    // The HMM's advantage over nearest-road-plus-continuity is structural: it
    // can express that a road is CLOSE BUT UNREACHABLE, which is what
    // distinguishes a parallel service road, the opposite carriageway, and the
    // road under a flyover. None of those geometries occur on these routes at
    // the moments that matter, so the extra machinery only adds variance and
    // the measured drift is slightly worse.
    //
    // The capability is demonstrated by nav-core/test/hmm.test.ts, which
    // constructs each of those geometries directly. This assertion exists so
    // that "it did not help on these logs" stays a recorded measurement rather
    // than becoming a forgotten disappointment.
    //
    // ★ THE GAP WIDENED, AND THAT IS ALSO A MEASUREMENT ★ It used to be 10.5 %
    // against 9.2 %. The heading gate in roadsnap.ts — a road pointing more
    // than 60 degrees away from the direction of travel is not a candidate —
    // took the shipped chain to 6.9 % and left the HMM untouched at 10.5 %,
    // because `hmmMatch` replaces that greedy matcher rather than feeding it.
    // The tolerance below is against an absolute figure now, not a multiple of
    // a moving baseline, or an improvement to the shipped chain would keep
    // failing this test for the wrong reason.
    // ★ AND THE ROW FLIPPED WHEN THE HMM STARTED SHIPPING ★ `full` now
    // includes `hmmMatch`, so the comparison is against `greedy` — the
    // nearest-road-plus-continuity matcher it replaced. Same measurement,
    // opposite sign: the greedy matcher is still the better of the two on
    // these logs, and that stays on the record rather than disappearing
    // because the default moved.
    const greedy = get('greedy');
    expect(greedy.mean).toBeLessThan(get('full').mean);
    // But both must stay in the same league. A matcher that diverges is a bug.
    expect(get('full').mean).toBeLessThan(22);
  });

  it('★ records where the particle filter helps and where it does not', () => {
    // ★ PHASE 17, AND THE MOST INTERESTING RESULT IN THE TABLE ★
    //
    // Averaged over everything it looks like a small regression: 10.4 % mean
    // against 9.2 %. Split by route type it is not one number at all:
    //
    //     city      15.1 % -> 13.3 %    it helps
    //     highway    3.2 % ->  7.4 %    it hurts
    //
    // Which is exactly what the mechanism predicts. The filter exists to carry
    // both futures through a junction whose choice cannot yet be known, and a
    // city is made of those. A motorway has few junctions, most of them
    // grade-separated, the shipped chain is already at 3.2 %, and five hundred
    // hypotheses about a road with no alternatives is machinery that can only
    // add variance.
    //
    // The overall mean is asserted only to keep the filter in the same league.
    // The per-route numbers are the finding, and they are in docs/benchmarks.md.
    //
    // Same note as the HMM above: the shipped chain's heading gate took it to
    // 6.9 % and did not move the filter, which reads its own hypotheses rather
    // than the greedy match. Bounded absolutely for the same reason.
    const particle = get('particle');
    expect(particle.mean).toBeLessThan(22);
    // And it must not be the catastrophe it was before the divergence guard:
    // an unguarded cloud that had collectively taken a wrong slip road
    // reported itself unimodal, with a two-metre spread, a kilometre from the
    // vehicle. 134 % drift. Self-consistency is not evidence.
    expect(particle.max).toBeLessThan(60);
  });

  it('does not regress past the figure published in docs/benchmarks.md', () => {
    // A guard, not a target.
    //
    // ★ THE NUMBER MOVED, AND ON PURPOSE ★ 6.1 % when Tier S was the arbiter;
    // 15.3 % now that Tier F is. Two guards were added on the strength of a
    // real ride — see §24.15 — and both cost simulated drift while taking the
    // real-ride figure from 52.6 % to 39.9 %. The standing rule is that when
    // the tiers disagree the real one wins, and this is the bill for it.
    //
    // The guard stays, at the level the simulator now measures, because its
    // job is to catch a DIVERGENCE rather than to defend a headline.
    expect(get('full').mean).toBeLessThan(22);
    // The tail matters more than the mean — it is what someone finds by
    // picking the one drive that went wrong.
    expect(get('full').p90).toBeLessThan(60);
  });
});
