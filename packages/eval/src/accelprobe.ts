/**
 * ★ IS THE FORWARD-ACCELERATION CHANNEL CARRYING A REAL ACCELERATION? ★
 *
 * §24.20: the rider was stopped at a signal when the receiver went and pulled
 * away during the outage. The vehicle covered 114 m in 19 s and the estimate
 * drew 6, with every bound correctly silent — the floor anchored on a measured
 * zero, the model withheld, ZUPT not firing. What is left is integration, and
 * integration reported 0.0 km/h for nineteen seconds.
 *
 * Pulling away at even 1 m/s^2 for ten seconds is 10 m/s. So either the raw
 * accelerometer does not contain that acceleration — which would be a sensor
 * or a mounting problem — or it does and the chain is removing it.
 *
 * This asks the raw data directly, before the engine touches it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl } from './harness.js';
import { ROOT } from './paths.js';

const samples = parseJsonl(
  readFileSync(join(ROOT, 'data/replay/drive_20260909_2229.jsonl'), 'utf8'),
);
const fixes = samples.filter((s) => s.gnss);

// The gap the field failure lives in: the 19 s one.
let gap: { a: number; b: number } | null = null;
for (let i = 1; i < fixes.length; i++) {
  const dt = fixes[i]!.t - fixes[i - 1]!.t;
  if (dt >= 15_000 && dt < 30_000) {
    gap = { a: fixes[i - 1]!.t, b: fixes[i]!.t };
    break;
  }
}
if (!gap) throw new Error('no 19 s gap found');

const before = fixes.filter((s) => s.t <= gap!.a).slice(-4);
const after = fixes.filter((s) => s.t >= gap!.b).slice(0, 4);
console.log('\n  fixes around the gap:');
for (const s of [...before, ...after]) {
  console.log(
    `    t${((s.t - gap.a) / 1000).toFixed(1).padStart(7)}s  ` +
      `speed ${(s.gnss!.speedMps ?? Number.NaN).toFixed(2).padStart(6)} m/s  ` +
      `acc ${s.gnss!.accuracyM.toFixed(1)}`,
  );
}

// ★ THE RAW MAGNITUDE, WITH GRAVITY STILL IN IT ★
// The engine resolves acceleration into the vehicle frame using an attitude
// estimate and a learned mount yaw. If either is wrong the forward component
// is wrong. |a| - g needs neither, so it answers the narrower question: does
// the handset feel ANY sustained acceleration here?
const g = 9.80665;
console.log('\n  raw |a| - g through the gap, 2 s means:');
let bucket: number[] = [];
let bucketStart = gap.a;
for (const s of samples) {
  if (s.t < gap.a || s.t > gap.b || !s.imu) continue;
  bucket.push(Math.hypot(s.imu.ax, s.imu.ay, s.imu.az) - g);
  if (s.t - bucketStart >= 2000) {
    const mean = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    const sd = Math.sqrt(
      bucket.reduce((a, b) => a + (b - mean) ** 2, 0) / bucket.length,
    );
    console.log(
      `    +${((bucketStart - gap.a) / 1000).toFixed(0).padStart(3)}s  ` +
        `mean ${mean.toFixed(3).padStart(7)}  sd ${sd.toFixed(3).padStart(6)}  n ${bucket.length}`,
    );
    bucket = [];
    bucketStart = s.t;
  }
}

// What the vehicle actually did, from the fixes either side.
const v0 = before[before.length - 1]!.gnss!.speedMps ?? 0;
const v1 = after[0]!.gnss!.speedMps ?? 0;
const dt = (gap.b - gap.a) / 1000;
console.log(
  `\n  truth: ${v0.toFixed(2)} -> ${v1.toFixed(2)} m/s over ${dt.toFixed(1)}s ` +
    `= mean accel ${((v1 - v0) / dt).toFixed(3)} m/s^2\n`,
);
