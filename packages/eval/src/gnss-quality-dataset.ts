import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GNSS_QUALITY_CLASSES, GNSS_QUALITY_FEATURES, GnssQualityTracker } from '@pathpulse/nav-core';
import { parseJsonl } from './harness.js';
import { ROOT, listLogs, parseArgs, readLog } from './paths.js';

/**
 * Write the training set for Phase 13's GNSS quality classifier (Model 4).
 *
 *   pnpm eval:gnss-dataset
 *
 * ★ WHERE THE LABELS COME FROM, AND WHY THAT IS DEFENSIBLE ★
 *
 * There is no dataset of labelled multipath. Nobody drives an urban canyon with
 * a second receiver calling out "that fix was reflected" — and the ones that
 * exist are survey-grade rigs whose failure modes are not a phone's.
 *
 * So the labels are made rather than found, and the honesty is in HOW. Each row
 * starts as a REAL fix from a recorded log. A corruption is then applied whose
 * physics is known, which makes the label exact by construction rather than
 * asserted:
 *
 *   GOOD       the fix untouched.
 *   MULTIPATH  the signal has bounced off a building before arriving. That
 *              lengthens the path, so the position moves by tens of metres,
 *              the receiver's own accuracy estimate inflates, the satellite
 *              count falls as some are lost behind the building, and C/N0
 *              drops — a reflected signal is an attenuated one.
 *   SPOOFED    a transmitter overriding the real constellation. The giveaway
 *              is the opposite of multipath: the fix looks TOO good. Accuracy
 *              and C/N0 are excellent and steady, and the position disagrees
 *              with the IMU, because the spoofer does not know what the
 *              vehicle is doing.
 *   LOST       satellites collapse, accuracy blows out, C/N0 falls to nothing.
 *
 * ★ AND THE CAVEAT, WHICH IS THE SAME ONE AS EVERYWHERE ELSE ★
 * These are MODELS of four failure modes, not recordings of them. The model
 * learns to separate the four as modelled. Whether real multipath looks like
 * this one is an open question that only a drive through a real urban canyon
 * with a recording running can answer — and `pnpm eval:record` is how that
 * data gets made when somebody does it.
 */

const CLASS_INDEX = Object.fromEntries(GNSS_QUALITY_CLASSES.map((c, i) => [c, i]));

/** Deterministic noise. A dataset that changes every run is not a dataset. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Fix {
  t: number;
  lat: number;
  lon: number;
  accuracyM: number;
  satCount: number;
  meanCn0: number;
  cn0Spread: number;
  hdop: number;
  drSpeedMps: number;
}

/**
 * A plausible open-sky fix, filled in where the log is silent.
 *
 * The simulator does not synthesise C/N0 or DOP. Rather than drop those
 * features — they are two of the five the problem statement names — they are
 * modelled here, and the corruptions below move them in the directions the
 * physics says they move. A feature that is constant in training teaches the
 * model nothing and costs nothing; one that moves correctly teaches it the
 * relationship that matters.
 */
function baseFix(
  raw: { t: number; lat: number; lon: number; accuracyM: number; satCount?: number; speedMps?: number },
  r: () => number,
): Fix {
  return {
    t: raw.t,
    lat: raw.lat,
    lon: raw.lon,
    accuracyM: raw.accuracyM,
    satCount: raw.satCount ?? 9 + Math.floor(r() * 5),
    meanCn0: 36 + r() * 6,
    cn0Spread: 3 + r() * 2,
    hdop: 0.8 + r() * 0.5,
    drSpeedMps: raw.speedMps ?? 0,
  };
}

const M_PER_DEG = 111_320;

/**
 * Apply a modelled corruption at a given severity.
 *
 * ★ SEVERITY IS THE WHOLE POINT, AND THE FIRST VERSION HAD NONE ★
 *
 * Without it every corruption was applied at full strength, and the four
 * classes separated perfectly: the model scored 1.000 macro-F1 in both
 * directions of the log-disjoint split. That is not a good result, it is a
 * broken benchmark. A classifier told that MULTIPATH always means "accuracy
 * over 2.5x, C/N0 under 30, six satellites" has learned four disjoint boxes,
 * and the number it scores says nothing about a real urban canyon.
 *
 * Real failure modes are graded. Multipath off a single low building barely
 * moves the fix; a crude spoofer is not perfectly clean; a receiver losing
 * lock does it over seconds, not instantly. So severity is drawn uniformly and
 * every corruption is interpolated from "barely there" to "severe" — which
 * makes the classes OVERLAP near zero severity, exactly as they do in life,
 * and makes the resulting score mean something.
 */
function corrupt(fix: Fix, label: string, r: () => number): Fix {
  const out = { ...fix };
  const jitter = () => (r() - 0.5) * 2;
  // Uniform on [0,1]: mild cases are as common as severe ones, so the model
  // cannot succeed by only learning the easy end.
  const sev = r();
  const lerp = (mild: number, severe: number): number => mild + (severe - mild) * sev;

  switch (label) {
    case 'MULTIPATH': {
      // A reflected path is a longer path: the fix moves, by tens of metres,
      // in a direction the building decides.
      // Mild: a single low building, a couple of metres. Severe: a canyon.
      const offsetM = lerp(2, 60);
      const bearing = r() * 2 * Math.PI;
      out.lat += (offsetM * Math.cos(bearing)) / M_PER_DEG;
      out.lon +=
        (offsetM * Math.sin(bearing)) / (M_PER_DEG * Math.cos((fix.lat * Math.PI) / 180));
      out.accuracyM = fix.accuracyM * lerp(1.1, 5.5);
      out.satCount = Math.max(4, Math.round(fix.satCount - lerp(0, 6)));
      out.meanCn0 = lerp(35, 22) + jitter();
      // The tell: one reflected satellite is far weaker than its neighbours,
      // so the SPREAD widens even as the mean falls.
      out.cn0Spread = lerp(3.5, 12) + jitter() * 0.5;
      out.hdop = lerp(1.0, 3.8);
      break;
    }
    case 'SPOOFED': {
      // ★ THE GIVEAWAY IS THAT IT LOOKS TOO GOOD ★ A spoofer transmits a
      // clean, strong, consistent signal — and does not know what the vehicle
      // is actually doing, so the position it asserts disagrees with the IMU.
      // Mild: a crude spoofer barely dragging the fix, and not very clean.
      // Severe: a good one — suspiciously perfect, and far from the truth.
      const dragM = lerp(5, 90);
      const bearing = r() * 2 * Math.PI;
      out.lat += (dragM * Math.cos(bearing)) / M_PER_DEG;
      out.lon += (dragM * Math.sin(bearing)) / (M_PER_DEG * Math.cos((fix.lat * Math.PI) / 180));
      out.accuracyM = lerp(fix.accuracyM, 1.4);
      out.satCount = Math.round(lerp(fix.satCount, 15));
      out.meanCn0 = lerp(38, 48) + jitter();
      out.cn0Spread = lerp(3, 0.4);
      out.hdop = lerp(1.0, 0.6);
      break;
    }
    case 'LOST': {
      // Mild: lock slipping, four satellites and a poor fix. Severe: gone.
      out.accuracyM = lerp(25, 190);
      out.satCount = Math.max(0, Math.round(lerp(5, 0)));
      out.meanCn0 = lerp(26, 8) + jitter();
      out.cn0Spread = lerp(4, 2);
      out.hdop = lerp(3, 15);
      const wander = lerp(4, 40);
      out.lat += (jitter() * wander) / M_PER_DEG;
      out.lon += (jitter() * wander) / (M_PER_DEG * Math.cos((fix.lat * Math.PI) / 180));
      break;
    }
    default:
      // GOOD is not "untouched": a real open-sky fix has its own variation,
      // and a class with no spread at all is one the model separates by
      // finding the constant rather than by understanding it.
      out.accuracyM = fix.accuracyM * lerp(0.9, 1.6);
      out.satCount = Math.max(5, Math.round(fix.satCount - lerp(0, 2)));
      out.meanCn0 = lerp(40, 33) + jitter();
      out.cn0Spread = lerp(2.5, 4.5);
      out.hdop = lerp(0.7, 1.4);
      break;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  const logs = args.log ? [String(args.log)] : listLogs();
  if (logs.length === 0) throw new Error('no logs in data/replay/ — run `pnpm eval:record` first');

  const header = ['log', 'label', ...GNSS_QUALITY_FEATURES];
  const lines: string[] = [header.join(',')];
  const counts: Record<string, number> = {};

  for (const logName of logs) {
    const samples = parseJsonl(readLog(logName));
    const fixes = samples
      .filter((s) => s.gnss)
      .map((s) => ({ ...s.gnss!, t: s.t }))
      .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));
    if (fixes.length < 20) continue;

    // ★ EVERY PASS TRANSITIONS OUT OF GOOD, AND THE FIRST VERSION DID NOT ★
    //
    // Originally each label got a pass in which the WHOLE log was that class.
    // The tracker's baselines then adapted to the corruption — a log that is
    // LOST throughout has a baseline satellite count of one and a baseline
    // accuracy of 150 m, so `satDropFromBaseline` is zero and `accuracyRatio`
    // is one. The model learned that LOST means "everything is terrible AND
    // has always been terrible".
    //
    // At inference the baselines carry a healthy history and then a sudden
    // collapse, which is the opposite feature vector. The unit test caught it
    // exactly as it should: an obviously dead receiver was classified SPOOFED.
    //
    // So every pass now drives good for the first stretch and degrades for the
    // rest, and only the degraded stretch carries the label. The baselines see
    // what they will see in the field: a transition.
    for (const label of GNSS_QUALITY_CLASSES) {
      const r = rng(1337 + CLASS_INDEX[label]!);
      const tracker = new GnssQualityTracker();
      // Vary where the degradation begins, so the model cannot key on "row 80".
      const onsetAt = Math.floor(fixes.length * (0.35 + r() * 0.3));

      for (let i = 0; i < fixes.length; i++) {
        const degraded = label !== 'GOOD' && i >= onsetAt;
        const fix = corrupt(baseFix(fixes[i]!, r), degraded ? label : 'GOOD', r);
        const features = tracker.push(fix);
        if (!features) continue;
        // GOOD rows come only from the GOOD pass. Emitting the healthy prefix
        // of every pass as well would quadruple that class and teach the model
        // the prior rather than the physics.
        if (label !== 'GOOD' && !degraded) continue;
        lines.push([logName, label, ...Array.from(features).map((v) => v.toFixed(5))].join(','));
        counts[label] = (counts[label] ?? 0) + 1;
      }
    }

    console.log(`  ${logName.padEnd(24)} ${fixes.length} fixes x ${GNSS_QUALITY_CLASSES.length}`);
  }

  const dir = join(ROOT, 'ml', 'data', 'processed');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'gnss_quality_rows.csv');
  writeFileSync(out, `${lines.join('\n')}\n`);

  console.log('\n  class balance');
  for (const c of GNSS_QUALITY_CLASSES) {
    console.log(`    ${c.padEnd(12)} ${counts[c] ?? 0}`);
  }
  console.log(`\n  wrote ${out}\n`);
}

try {
  main();
} catch (err) {
  console.error(`\n  ✖ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
