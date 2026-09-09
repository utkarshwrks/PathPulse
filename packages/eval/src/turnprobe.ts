import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoadGraph } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { loadConfig, ROOT } from './paths.js';
const cfg = loadConfig('full');
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
    const st = res.states.filter((s) => s.t >= w && s.t <= w + 60_000);
    // Distinct lastTurn timestamps inside the outage = turns that fired in DR.
    const inDr = new Set(st.filter((s) => s.lastTurn && s.lastTurn.t >= w).map((s) => s.lastTurn!.t));
    // Truth heading change through the window, as a count of real corners.
    const tr = res.truth.filter((p) => p.t >= w && p.t <= w + 60_000);
    let realTurns = 0, acc = 0;
    for (let i = 2; i < tr.length; i++) {
      const h = (a: typeof tr[0], b: typeof tr[0]) => {
        const mLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
        return (Math.atan2((b.lon - a.lon) * mLon, (b.lat - a.lat) * 111_132) * 180) / Math.PI;
      };
      const d = ((h(tr[i - 1]!, tr[i]!) - h(tr[i - 2]!, tr[i - 1]!) + 540) % 360) - 180;
      if (Number.isFinite(d)) acc += d;
      if (Math.abs(acc) > 60) { realTurns++; acc = 0; }
    }
    console.log(`${r.log.replace('iovnbd_','').replace('.jsonl','')} @${w/1000}s  turns fired in DR: ${inDr.size}   real corners in truth: ~${realTurns}`);
  }
}
