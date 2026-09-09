/** ESKF reset rate on real handset data, with the filter newly live. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoadGraph } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { loadConfig, ROOT } from './paths.js';
const cfg = loadConfig('full');
let totalResets = 0;
let totalMin = 0;
for (const r of [
  { log: 'iovnbd_S1.jsonl', graph: 'road_graph_iovnbd_s1.json' },
  { log: 'iovnbd_S3c.jsonl', graph: 'road_graph_iovnbd_s3c.json' },
]) {
  const file = join(ROOT, 'data/replay', r.log);
  if (!existsSync(file)) continue;
  const samples = parseJsonl(readFileSync(file, 'utf8'));
  const gp = join(ROOT, 'data/maps', r.graph);
  const graph = existsSync(gp) ? (JSON.parse(readFileSync(gp, 'utf8')) as RoadGraph) : null;
  for (const w of [900_000, 1_800_000, 2_400_000, 3_000_000]) {
    const res = runEval(samples, {
      configName: 'full', logName: r.log, engineConfig: cfg.engine as never,
      outageStartMs: w, outageDurationMs: 60_000, roadGraph: graph, speedModel: true,
    });
    const n = res.eskfResets;
    const mins = samples[samples.length - 1]!.t / 60_000;
    totalResets += n;
    totalMin += mins;
    console.log(`  ${r.log.replace('iovnbd_','').replace('.jsonl','')} @${w/1000}s  ESKF resets ${n}`);
  }
}
console.log(`\n  TOTAL ${totalResets} resets over ${totalMin.toFixed(0)} log-minutes\n`);
