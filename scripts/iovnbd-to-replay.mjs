#!/usr/bin/env node
/**
 * IO-VNBD -> data/replay/iovnbd_*.jsonl
 *
 * ★ WHY THIS EXISTS ★
 *
 * Every number this project publishes comes from logs its own simulator wrote,
 * and `ml/check_sim_transfer.py` proves those logs are not a substitute for
 * real sensors: models scoring 2.93 m/s on real driving degrade to 8-20 m/s on
 * the synthetic IMU. So anything judged on simulated logs — a matcher, a model,
 * turn geometry — is being judged against a physics model rather than a road.
 *
 * The repository already downloads IO-VNBD for training: real smartphone IMU,
 * recorded in a real car, with the vehicle's own CAN bus alongside it. It had
 * never been turned into a replay log. Converting it means `pnpm eval`,
 * `pnpm ablation` and `pnpm eval:offroad` all run against real sensors with no
 * change to the estimator at all — which is the whole point of having a log
 * format rather than a special case.
 *
 * ★ WHAT THIS IS NOT ★
 *
 * It is not a field drive. A different phone, a different car, a different
 * country, 10 Hz instead of 50, no barometer and no per-satellite data. It is
 * strong evidence the estimator works on real sensors and NO evidence about our
 * handset on our roads. Logs are named `iovnbd_*` so a reader can never mistake
 * one for a `drive_*`. See data/replay/README.md.
 *
 * ★ WHY NODE AND NOT PYTHON ★
 * The output is consumed entirely by the JS toolchain, `data/replay/` is JS
 * territory, and the repository's other data tooling — make-demo-log.mjs,
 * build-road-graph.mjs — is already Node. Putting it here means regenerating
 * the logs needs no Python environment. The one thing Python was genuinely
 * better at, deriving the axis mapping below, was a one-off analysis whose
 * ANSWER is recorded here rather than its code.
 *
 * Usage:
 *   node scripts/iovnbd-to-replay.mjs                 # every sequence that passes
 *   node scripts/iovnbd-to-replay.mjs --seq S1 --seq S3c
 *   node scripts/iovnbd-to-replay.mjs --report        # screen only, write nothing
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RAW = join(ROOT, 'ml/data/raw');
const OUT = join(ROOT, 'data/replay');

/*
 * ★ COLUMN INDICES, VERIFIED AGAINST THE FILES — NOT AGAINST THE HEADERS ★
 * Zero-based, matching ml/data/preprocess_motion.py so the two cannot drift.
 */
const PHONE = {
  lat: 0,
  lon: 1,
  /**
   * ★ THE HEADER SAYS "GPS SPEED (Kmh)" AND IT IS METRES PER SECOND ★
   *
   * A sixth thing in this dataset whose label is wrong. Taken at face value the
   * whole drive reads as a crawl: S1's 37.16 km in 86 minutes is a 7.2 m/s
   * average, and the column's own median came out at 2.1 m/s with a maximum of
   * 5.2 — 19 km/h, for a car on a trunk road.
   *
   * Measured against the vehicle's own CAN speed, over samples where the car is
   * moving faster than 5 km/h:
   *
   *     median( CAN km/h / this column ) = 3.659 (S1)   3.633 (S3c)
   *
   * Which is 3.6, to within the noise of two different speed sensors. The
   * column is m/s. Divided by 3.6 as the header invites, every Doppler speed
   * handed to the engine was 3.6x too small — and because the estimator trusts
   * Doppler above everything else, that is not a small error: it is a
   * confident, precise, wrong speed.
   */
  speedMps: 3,
  accuracyM: 4,
  headingDeg: 5,
  t: 7,
  acc: [9, 10, 11],
  grav: [12, 13, 14],
  gyr: [15, 16, 17], // labelled Yaw, Pitch, Roll — Euler rates, see below
};
const VEH = { yawRateDeg: 14, speedKmh: 15 };

/** Index within PHONE.gyr of the column carrying the vertical rate. */
const GYR_PITCH = 1;

/**
 * ★ THE GYRO COLUMNS ARE NOT BODY AXES AT ALL ★
 *
 * nav-core resolves yaw by projecting the gyro vector onto measured gravity —
 * `-(omega . up)` — which needs omega expressed in the SAME frame as the
 * accelerometer. IO-VNBD's gyro columns are not, and the reason is in their
 * names: they are labelled Yaw, Pitch and Roll, not X, Y and Z. Those are EULER
 * ANGLE RATES, and Euler rates are not the components of the body angular
 * velocity vector. No permutation of them is.
 *
 * That was established the long way. Every one of the 24 proper-rotation
 * mappings of the three columns onto the three accelerometer axes was scored:
 *
 *   - against CAN yaw rate: the best reached +0.963 (S1) and +0.954 (S3c),
 *     which looked like a solved problem;
 *   - against GPS heading change, which is what the estimator actually
 *     integrates: slope 1.002 and 0.9 deg mean error over 106 real turns.
 *
 * Both agree on ONE channel and neither can separate the other two, because
 * projecting onto gravity constrains only the component along gravity. Feeding
 * the two unconstrained columns in as body x and y then corrupts the attitude
 * filter, and the damage is not subtle: the horizontal specific force came out
 * at 6.5 m/s^2 on a car holding a constant 8.5 m/s, which is impossible — the
 * total was 9.95 and gravity is 9.81, so the horizontal part cannot exceed
 * 1.7. Gravity was leaking in through an attitude roughly 40 degrees wrong.
 *
 * Measured, over 19 outage windows on the two sequences:
 *
 *     best signed permutation of all three columns ....  74.5 % mean drift
 *     the two horizontal columns zeroed ...............  38.5 % mean drift
 *
 * ★ SO ONLY THE CHANNEL THAT WAS MEASURED IS EMITTED ★
 *
 * The vertical rate is known: `-(Pitch column)` is the yaw rate in the compass
 * sense the estimator uses, verified against a real 90-degree turn (91.9 deg of
 * GPS heading change against 92.1 deg integrated). The other two rates are not
 * known, and the honest representation of "not known" is a gyro vector that
 * makes no claim about them:
 *
 *     omega = yawRateCompass * (-up)        so that  -(omega . up) = yawRate
 *
 * built against the file's OWN gravity columns, so it stays correct if the
 * handset is not level. For the level, rigidly-mounted phones that survive the
 * screen this reduces to putting the rate on device Z, which is where it
 * physically is.
 *
 * What this costs: the attitude filter gets no gyro contribution in pitch and
 * roll, so those come from the accelerometer anchor alone. For a phone bolted
 * into a car that is exactly right, and it is why the number improves rather
 * than degrades. What it would cost on a handheld phone is real, and is one
 * more reason Tier R is not a substitute for a drive log of our own (W0).
 */

/** Correlation below this and the phone was not rigidly mounted. */
const RIGID_MIN_CORR = 0.5;
/** Median fix accuracy above this and the log's ground truth is not usable. */
const MAX_MEDIAN_ACCURACY_M = 20;
/** Fraction of fixes worse than 20 m above which the log is rejected. */
const MAX_BAD_FIX_FRACTION = 0.1;
/** A turn, for the purposes of scoring the mount. rad/s. */
const TURNING_RATE = 0.02;
/**
 * Largest believable angular rate, rad/s.
 *
 * ★ A PHYSICAL PLAUSIBILITY SCREEN, ADDED BECAUSE ONE SEQUENCE FAILED IT ★
 * A car's yaw rate peaks near 0.5 rad/s; a phone being picked up might reach 3.
 * S3b contains 20.0 rad/s — 1,146 degrees per second — which is not a vehicle
 * manoeuvre and not a mounting artefact, it is corrupt data. That sequence also
 * has a clock that repeats (6,813 rows collapse to 2,043 usable samples), so
 * the two faults are probably the same fault.
 *
 * It passed the rigid-mount and GNSS screens, which is the point: those check
 * whether the recording is USEFUL, and this checks whether it is POSSIBLE.
 */
const MAX_GYRO_RAD_S = 6;

async function readCsv(path) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    if (line.trim() === '') continue;
    rows.push(line.split(','));
  }
  return rows;
}

const num = (row, i) => {
  const v = Number(row[i]);
  return Number.isFinite(v) ? v : Number.NaN;
};

/**
 * Build a device-frame angular rate carrying only the channel we measured.
 *
 * @param gyr    the three raw columns, [Yaw, Pitch, Roll]
 * @param grav   the file's own gravity vector, accelerometer frame
 */
function gyroFromMeasuredYaw(gyr, grav) {
  const gmag = Math.hypot(grav[0], grav[1], grav[2]);
  // Without a gravity reading there is no vertical to put the rate about. A
  // zero vector is the correct claim: we know nothing about this sample's
  // rotation. It is rare enough not to matter and wrong enough to matter if
  // it were guessed.
  if (!(gmag > 1)) return [0, 0, 0];
  const up = [grav[0] / gmag, grav[1] / gmag, grav[2] / gmag];
  // Compass-sense yaw rate: verified against GPS heading change, slope 1.002.
  const yawRate = -gyr[GYR_PITCH];
  // omega = -yawRate * up  =>  -(omega . up) = yawRate, exactly.
  return [-yawRate * up[0], -yawRate * up[1], -yawRate * up[2]];
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : Number.NaN;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
}

/** Load one sequence and compute everything needed to judge and convert it. */
export async function loadSequence(name) {
  const dir = join(RAW, name);
  const [phone, vehicle] = await Promise.all([
    readCsv(join(dir, 'phone.csv')),
    readCsv(join(dir, 'vehicle.csv')),
  ]);
  const n = Math.min(phone.length, vehicle.length);

  const samples = [];
  const yawTruth = [];
  const yawFromGyro = [];
  const accuracies = [];
  let lastT = -Infinity;
  let lastFixKey = '';
  let stationaryAccelMag = [];
  let worstGyro = 0;

  for (let i = 0; i < n; i++) {
    const p = phone[i];
    const v = vehicle[i];
    const t = num(p, PHONE.t);
    const ax = num(p, PHONE.acc[0]);
    const ay = num(p, PHONE.acc[1]);
    const az = num(p, PHONE.acc[2]);
    const g = [num(p, PHONE.gyr[0]), num(p, PHONE.gyr[1]), num(p, PHONE.gyr[2])];
    if (!Number.isFinite(t) || ![ax, ay, az, ...g].every(Number.isFinite)) continue;
    // ★ STRICTLY INCREASING ★ The engine's step-1 guard drops any sample whose
    // timestamp does not advance, and a log full of silently-dropped samples
    // scores as a much shorter drive than it was.
    if (t <= lastT) continue;
    lastT = t;

    const grav = [num(p, PHONE.grav[0]), num(p, PHONE.grav[1]), num(p, PHONE.grav[2])];
    const [gx, gy, gz] = gyroFromMeasuredYaw(g, grav);
    worstGyro = Math.max(worstGyro, Math.abs(gx), Math.abs(gy), Math.abs(gz));
    const sample = { t: Math.round(t), imu: { ax, ay, az, gx, gy, gz } };

    // Ground-truth channels, used for screening only — never emitted.
    const yawRate = (num(v, VEH.yawRateDeg) * Math.PI) / 180;
    const gmag = Math.hypot(grav[0], grav[1], grav[2]);
    if (Number.isFinite(yawRate) && gmag > 1 && Math.abs(yawRate) > TURNING_RATE) {
      const up = [grav[0] / gmag, grav[1] / gmag, grav[2] / gmag];
      yawFromGyro.push(-(gx * up[0] + gy * up[1] + gz * up[2]));
      yawTruth.push(yawRate);
    }

    const vehSpeed = num(v, VEH.speedKmh) / 3.6;
    if (Number.isFinite(vehSpeed) && vehSpeed < 0.5) {
      stationaryAccelMag.push(Math.hypot(ax, ay, az));
    }

    const lat = num(p, PHONE.lat);
    const lon = num(p, PHONE.lon);
    const accuracyM = num(p, PHONE.accuracyM);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(accuracyM)) {
      /*
       * ★ ATTACH A FIX ONCE, NOT ON EVERY ROW ★
       * The GPS columns are repeated on all ten rows of each second, because
       * the receiver fixes at 1 Hz and the file is 10 Hz. Emitting a fix on
       * every row would tell the engine it has a 10 Hz receiver: the adaptive
       * timeout, the Doppler hold and every "no fix for Ns" figure downstream
       * would be computed from a fiction. SensorLoopService.java has the same
       * rule for the same reason.
       */
      const key = `${lat},${lon}`;
      if (key !== lastFixKey && (lat !== 0 || lon !== 0)) {
        lastFixKey = key;
        accuracies.push(accuracyM);
        const gnss = { lat, lon, accuracyM };
        const speedMps = num(p, PHONE.speedMps);
        // Already m/s — see the note on PHONE.speedMps. No conversion.
        if (Number.isFinite(speedMps)) gnss.speedMps = speedMps;
        const heading = num(p, PHONE.headingDeg);
        if (Number.isFinite(heading) && heading !== 0) gnss.headingDeg = heading;
        sample.gnss = gnss;
      }
    }
    samples.push(sample);
  }

  const sortedAcc = [...accuracies].sort((a, b) => a - b);
  const dtList = [];
  for (let i = 1; i < samples.length; i++) dtList.push(samples[i].t - samples[i - 1].t);
  dtList.sort((a, b) => a - b);
  const stationarySorted = stationaryAccelMag.sort((a, b) => a - b);

  return {
    name,
    samples,
    fixes: accuracies.length,
    rigidCorr: Math.abs(pearson(yawFromGyro, yawTruth)),
    medianDtMs: percentile(dtList, 50),
    medianAccuracyM: percentile(sortedAcc, 50),
    p90AccuracyM: percentile(sortedAcc, 90),
    badFixFraction: accuracies.length
      ? accuracies.filter((a) => a > MAX_MEDIAN_ACCURACY_M).length / accuracies.length
      : 1,
    stationaryAccelMedian: percentile(stationarySorted, 50),
    worstGyro,
    durationMin: samples.length ? (samples[samples.length - 1].t - samples[0].t) / 60000 : 0,
  };
}

/** Why a sequence may not be emitted, or null if it may. */
export function rejectionReason(s) {
  if (s.samples.length < 1000) return 'too short';
  if (!(s.rigidCorr >= RIGID_MIN_CORR)) {
    // ★ THE SCREEN THAT COSTS MOST OF THE DATASET AND IS NOT OPTIONAL ★
    // The phone gyro tracks the car's yaw in only a few sequences; in the rest
    // the handset was loose on a seat, measuring its own motion. Survivable for
    // a speed model, fatal for anything about turn geometry — which is exactly
    // what these logs are for.
    return `phone not rigidly mounted (corr ${s.rigidCorr.toFixed(3)} < ${RIGID_MIN_CORR})`;
  }
  if (!(s.medianAccuracyM <= MAX_MEDIAN_ACCURACY_M)) {
    // The recorded GNSS IS the ground truth the harness withholds during an
    // artificial outage. A log with poor fixes measures the estimator against a
    // bad reference and tells you nothing — the same reason a field drive
    // recorded in an urban canyon would be rejected.
    return `fixes too coarse (median ${s.medianAccuracyM.toFixed(1)} m)`;
  }
  if (s.badFixFraction >= MAX_BAD_FIX_FRACTION) {
    return `${(s.badFixFraction * 100).toFixed(0)} % of fixes worse than ${MAX_MEDIAN_ACCURACY_M} m`;
  }
  if (s.worstGyro > MAX_GYRO_RAD_S) {
    return `impossible angular rate (${s.worstGyro.toFixed(1)} rad/s) — corrupt`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const only = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seq' && args[i + 1]) only.push(args[++i]);
  }
  const reportOnly = args.includes('--report');

  if (!existsSync(RAW)) {
    console.error(`\n  IO-VNBD is not downloaded. Run:  python ml/data/download.py\n`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  const names = (only.length ? only : readdirSync(RAW))
    .filter((n) => existsSync(join(RAW, n, 'phone.csv')))
    .sort();

  console.log('\n  IO-VNBD -> replay logs   (TIER R: real sensors, not our device)\n');
  console.log(
    `    ${'sequence'.padEnd(10)} ${'samples'.padStart(8)} ${'min'.padStart(6)} ${'rigid'.padStart(6)} ` +
      `${'dt'.padStart(5)} ${'|a|'.padStart(6)} ${'fixes'.padStart(6)} ${'accM'.padStart(5)}  verdict`,
  );

  let emitted = 0;
  for (const name of names) {
    let s;
    try {
      s = await loadSequence(name);
    } catch (err) {
      console.log(`    ${name.padEnd(10)} ${String(err.message).slice(0, 60)}`);
      continue;
    }
    const reason = rejectionReason(s);
    const verdict = reason ? `drop — ${reason}` : 'KEEP';
    console.log(
      `    ${name.padEnd(10)} ${String(s.samples.length).padStart(8)} ${s.durationMin.toFixed(1).padStart(6)} ` +
        `${s.rigidCorr.toFixed(3).padStart(6)} ${String(s.medianDtMs).padStart(5)} ` +
        `${s.stationaryAccelMedian.toFixed(2).padStart(6)} ${String(s.fixes).padStart(6)} ` +
        `${s.medianAccuracyM.toFixed(0).padStart(5)}  ${verdict}`,
    );
    if (reason || reportOnly) continue;

    const file = join(OUT, `iovnbd_${name}.jsonl`);
    writeFileSync(file, s.samples.map((x) => JSON.stringify(x)).join('\n') + '\n');
    emitted++;
  }

  console.log(
    `\n  ${emitted} log(s) written to data/replay/.` +
      `\n  These are TIER R — real vehicle sensors from a public dataset, NOT our` +
      `\n  device on our roads. Never average them with sim_* rows.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
