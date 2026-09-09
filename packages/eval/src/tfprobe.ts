/**
 * What the engine believed, second by second, through a Tier F window.
 *
 * Drives NavigationEngine directly rather than through runEval, because the
 * question is about `diagnostics` — the motion context and the speed source —
 * and the harness only returns emitted state.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NavigationEngine } from '@pathpulse/nav-core';
import { loadSpeedModel, parseJsonl } from './harness.js';
import { loadConfig, loadGraphFor, ROOT } from './paths.js';

const cfg = loadConfig('full');
const log = 'drive_20260909_1942.jsonl';
const samples = parseJsonl(readFileSync(join(ROOT, 'data/replay', log), 'utf8'));
const first = samples.find((s) => s.gnss)!;
const graph = loadGraphFor(first.gnss!.lat, first.gnss!.lon)?.graph ?? null;
const base = samples[0]!.t;

for (const rel of [20, 80, 140]) {
  const w = base + rel * 1000;
  const engine = new NavigationEngine(cfg.engine as never);
  try {
    engine.setSpeedPredictor(...loadSpeedModel());
  } catch {
    /* model optional */
  }
  if (graph) engine.setRoadGraph(graph);

  console.log(`\n  === window +${rel}s ===`);
  console.log(
    `  ${'t'.padStart(4)} ${'mode'.padEnd(14)} ${'context'.padEnd(11)} ${'src'.padEnd(10)} ` +
      `${'km/h'.padStart(6)} ${'dist'.padStart(6)} ${'latch'.padStart(6)} ${'ceil'.padStart(6)}`,
  );
  let nextPrint = w;
  for (const s of samples) {
    const inOutage = s.t >= w && s.t < w + 60_000;
    const fed = inOutage && s.gnss ? { ...s, gnss: undefined } : s;
    const st = engine.update(fed as never);
    if (s.t >= w && s.t <= w + 60_000 && s.t >= nextPrint) {
      nextPrint = s.t + 5000;
      const d = engine.diagnostics;
      console.log(
        `  ${((s.t - w) / 1000).toFixed(0).padStart(4)} ${st.mode.padEnd(14)} ` +
          `${d.motionContext.padEnd(11)} ${(d.speedSource ?? '—').padEnd(10)} ` +
          `${(st.velocityMps * 3.6).toFixed(1).padStart(6)} ` +
          `${st.distanceTravelledM.toFixed(0).padStart(6)} ` +
          `${(d.contextLatched ? 'held' : 'open').padStart(6)} ` +
          `${(d.roadSpeedCeilingMps === undefined ? '—' : (d.roadSpeedCeilingMps * 3.6).toFixed(0)).padStart(6)}`,
      );
    }
    if (s.t > w + 60_000) break;
  }
}
