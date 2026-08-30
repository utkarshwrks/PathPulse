#!/usr/bin/env node
/**
 * Build the backup demo log.
 *
 * ★ WHY A CANNED LOG WHEN THE SIMULATOR IS ALREADY DETERMINISTIC ★
 * The simulator runs from a fixed seed, so it reproduces exactly — which makes
 * it a fine demo and a poor *backup*. A backup has to survive the thing it is
 * backing up: a bad merge in the vehicle model, a route file that fails to
 * parse, a regression in the sensor pipeline. This log is a flat file of
 * numbers. Nothing in `packages/sensor-sources` has to work for it to play.
 *
 * The outage is baked in — GNSS is deleted from the window rather than zeroed
 * or faked, which is the shape a real outage has and the one the state machine
 * distinguishes. So the log plays the whole demo on its own, with no scripting
 * and no button to press at the right moment.
 *
 *   node scripts/make-demo-log.mjs
 *
 * Reads data/replay/sim_city_1337.jsonl and writes
 * apps/web/public/replay/demo.jsonl.
 *
 * ★ IT MUST NOT LAND IN data/replay/ ★
 * That directory is the evaluation corpus: `listLogs()` enumerates every
 * .jsonl in it and the ablation punches its own outage windows into each one.
 * A log that already has a 60 s hole in it then gets a second hole punched on
 * top, and the scores are meaningless. Writing this file there once moved the
 * headline from 10.0% mean / 22.6% p90 to 19.0% / 53.7% — a number that would
 * have gone onto a slide. The corpus holds continuous-GNSS recordings only,
 * and a test in packages/eval now enforces that.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE = resolve(ROOT, 'data/replay/sim_city_1337.jsonl');
/** Matches lib/demoScript.ts. Kept in step by the test, not by memory. */
const OUTAGE_START_MS = 15_000;
const OUTAGE_END_MS = 75_000;
/** Trimmed to the script's length plus a little tail to settle. */
const END_MS = 95_000;

const lines = readFileSync(SOURCE, 'utf8').split('\n');
const out = [];
let kept = 0;
let stripped = 0;

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let sample;
  try {
    sample = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (typeof sample.t !== 'number' || sample.t > END_MS) continue;

  if (sample.gnss && sample.t >= OUTAGE_START_MS && sample.t < OUTAGE_END_MS) {
    // Delete the fix outright. Zeroing it would be a different signal, and the
    // state machine tells the two apart.
    delete sample.gnss;
    stripped++;
  }
  out.push(JSON.stringify(sample));
  kept++;
}

const text = `${out.join('\n')}\n`;
const targets = [resolve(ROOT, 'apps/web/public/replay/demo.jsonl')];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const kb = Math.round(text.length / 1024);
console.log(`  demo log: ${kept} samples, ${stripped} fixes removed, ${kb} kB`);
console.log(`  outage ${OUTAGE_START_MS / 1000}s .. ${OUTAGE_END_MS / 1000}s, ends at ${END_MS / 1000}s`);
for (const t of targets) console.log(`  wrote ${t.replace(`${ROOT}/`, '')}`);
