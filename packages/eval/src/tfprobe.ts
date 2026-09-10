/** What the engine believed through a real outage in a Tier F log. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NavigationEngine } from '@pathpulse/nav-core';
import { loadSpeedModel, parseJsonl } from './harness.js';
import { loadConfig, loadGraphFor, ROOT } from './paths.js';

const cfg = loadConfig('full');
const log = process.argv[2] ?? 'drive_20260909_2229.jsonl';
const samples = parseJsonl(readFileSync(join(ROOT, 'data/replay', log), 'utf8'));
const first = samples.find((s) => s.gnss)!;
const graph = loadGraphFor(first.gnss!.lat, first.gnss!.lon)?.graph ?? null;

// Find the real gaps: no fix for 15 s or more.
const fixes = samples.filter((s) => s.gnss);
const gaps: Array<{ a: number; b: number }> = [];
for (let i = 1; i < fixes.length; i++) {
  if (fixes[i]!.t - fixes[i - 1]!.t >= 15_000) gaps.push({ a: fixes[i - 1]!.t, b: fixes[i]!.t });
}

const engine = new NavigationEngine(cfg.engine as never);
try {
  engine.setSpeedPredictor(...loadSpeedModel());
} catch {
  /* optional */
}
if (graph) engine.setRoadGraph(graph);

let g = 0;
let nextPrint = -1;
console.log(
  `\n  ${'t'.padStart(6)} ${'mode'.padEnd(14)} ${'context'.padEnd(11)} ${'src'.padEnd(10)} ` +
    `${'km/h'.padStart(6)} ${'dist'.padStart(7)} ${'latch'.padStart(5)} ${'ceil'.padStart(5)} ${'hdg'.padStart(7)}`,
);
for (const s of samples) {
  const st = engine.update(s);
  const gap = gaps[g];
  if (!gap) continue;
  if (s.t >= gap.a && s.t <= gap.b) {
    if (nextPrint < 0) {
      nextPrint = gap.a;
      console.log(`  --- outage ${g + 1}: ${((gap.b - gap.a) / 1000).toFixed(0)}s ---`);
    }
    if (s.t >= nextPrint) {
      nextPrint = s.t + 15_000;
      const d = engine.diagnostics;
      console.log(
        `  ${((s.t - gap.a) / 1000).toFixed(0).padStart(6)} ${st.mode.padEnd(14)} ` +
          `${d.motionContext.padEnd(11)} ${(d.speedSource ?? '-').padEnd(10)} ` +
          `${(st.velocityMps * 3.6).toFixed(1).padStart(6)} ` +
          `${st.distanceTravelledM.toFixed(0).padStart(7)} ` +
          `${(d.contextLatched ? 'held' : 'open').padStart(5)} ` +
          `${(d.roadSpeedCeilingMps === undefined ? '-' : (d.roadSpeedCeilingMps * 3.6).toFixed(0)).padStart(5)} ` +
          `${st.headingDeg.toFixed(0).padStart(4)}deg lean ${(d.leanDeg ?? 0).toFixed(0).padStart(3)}`,
      );
    }
  } else if (s.t > gap.b) {
    g++;
    nextPrint = -1;
  }
}
