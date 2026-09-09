/**
 * Decompose dead-reckoning error into the things that can cause it.
 *
 * Run with:  pnpm eval:heading      (add --fast for a four-window subset)
 *
 * ★ WHY THIS EXISTS ALONGSIDE THE DRIFT NUMBER ★
 *
 * Drift % is final position error over distance travelled, and it is the
 * problem statement's own metric — but it is nearly blind to the failure a
 * rider actually sees. Road snapping holds the marker on *a* road, so
 * cross-track error stays small and the percentage stays respectable while the
 * estimate is confidently driving down the wrong street.
 *
 * Field report: "it is not just about speed it is about the correct prediction
 * in dead reckoning it goes anywhere". Measured here, the shipped configuration
 * carries a mean HEADING error of 27 degrees through a 60 s outage — a number
 * no other eval in this repo reports, and the one that explains the pictures.
 *
 * Two columns, because there are two independent ways to be wrong:
 *
 *   spdBias   mean estimated speed minus mean true speed over the window.
 *             This is what drift % mostly measures.
 *   hdgErr    mean |estimated heading - truth course|, over samples where the
 *             vehicle is actually moving (below 3 m/s a truth course computed
 *             from two positions is noise, so those are excluded rather than
 *             averaged in).
 *
 * `--set key=value` overrides any engine config, which is how the negative
 * results in MASTER.md §24.11 were measured.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoadGraph } from '@pathpulse/nav-core';
import { parseJsonl, runEval } from './harness.js';
import { loadConfig, loadGraphFor, ROOT } from './paths.js';

// `--log <name>` scores one file instead, which is how a Tier F ride is
// decomposed: its graph is chosen from its own first fix rather than named.
const ONE = process.argv.includes('--log')
  ? String(process.argv[process.argv.indexOf('--log') + 1])
  : null;
const RUNS = ONE
  ? [{ log: ONE, graph: '' }]
  : [
      { log: 'iovnbd_S1.jsonl', graph: 'road_graph_iovnbd_s1.json' },
      { log: 'iovnbd_S3c.jsonl', graph: 'road_graph_iovnbd_s3c.json' },
    ];
const FAST = process.argv.includes('--fast');
const WINDOWS = (FAST ? [900, 1800, 2400, 3000] : [300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000]).map(
  (s) => s * 1000,
);
const DURATION_MS = 60_000;

const configName = process.argv.includes('--config')
  ? String(process.argv[process.argv.indexOf('--config') + 1])
  : 'full';
const cfg = loadConfig(configName);
// Ad-hoc engine overrides: --set key=value (numbers and booleans only).
const overrides: Record<string, unknown> = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--set') continue;
  const [k, v] = String(process.argv[i + 1] ?? '').split('=');
  if (!k) continue;
  overrides[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}
const engineConfig = { ...(cfg.engine as Record<string, unknown>), ...overrides };
if (Object.keys(overrides).length) console.log('  overrides:', overrides);

console.log(`\n  DR error decomposition — config ${configName}\n`);
console.log(
  `  ${'log'.padEnd(18)} ${'win'.padStart(5)} ${'drift%'.padStart(7)} ` +
    `${'spdErr'.padStart(7)} ${'spdBias'.padStart(7)} ${'hdgErr'.padStart(7)} ` +
    `${'trueD'.padStart(7)} ${'estD'.padStart(7)}`,
);

const agg = { spdBias: [] as number[], hdg: [] as number[] };

for (const r of RUNS) {
  const file = join(ROOT, 'data/replay', r.log);
  if (!existsSync(file)) continue;
  const samples = parseJsonl(readFileSync(file, 'utf8'));
  let graph: RoadGraph | null = null;
  if (r.graph) {
    const gp = join(ROOT, 'data/maps', r.graph);
    graph = existsSync(gp) ? (JSON.parse(readFileSync(gp, 'utf8')) as RoadGraph) : null;
  } else {
    // A Tier F log names no graph: it is chosen from the ride's own first fix,
    // the same way the handset chooses one.
    const f = samples.find((x) => x.gnss);
    graph = f?.gnss ? loadGraphFor(f.gnss.lat, f.gnss.lon)?.graph ?? null : null;
  }
  const span = samples[samples.length - 1]!.t;

  // ★ A HANDSET LOG DOES NOT START AT ZERO ★ Android timestamps are ms since
  // boot, so windows are placed relative to the log's own beginning.
  const base = ONE ? samples[0]!.t : 0;
  const relWindows = ONE ? [20, 50, 80, 110, 140, 170, 200].map((x) => x * 1000) : WINDOWS;
  for (const rw of relWindows) {
    const w = base + rw;
    if (w + DURATION_MS > span - 15_000) continue;
    const res = runEval(samples, {
      configName,
      logName: r.log,
      engineConfig: engineConfig as never,
      outageStartMs: w,
      outageDurationMs: DURATION_MS,
      roadGraph: graph,
      speedModel: true,
    });
    const end = w + DURATION_MS;

    // Truth speed and heading through the window, from the truth track itself.
    const tr = res.truth.filter((p) => p.t >= w && p.t <= end);
    if (tr.length < 3) continue;
    let trueDist = 0;
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1]!;
      const b = tr[i]!;
      const mPerLat = 111_132;
      const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
      trueDist += Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * mPerLat);
    }
    const durS = (tr[tr.length - 1]!.t - tr[0]!.t) / 1000;
    const trueMeanSpeed = trueDist / Math.max(1e-6, durS);

    // What the estimator believed, over the same window.
    const st = res.states.filter((s) => s.t >= w && s.t <= end);
    if (st.length < 3) continue;
    const estMeanSpeed =
      st.reduce((a, s) => a + (Number.isFinite(s.velocityMps) ? s.velocityMps : 0), 0) / st.length;
    // Path length the estimate drew.
    let estDist = 0;
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1]!.position;
      const b = st[i]!.position;
      const mPerLon2 = 111_320 * Math.cos((a.lat * Math.PI) / 180);
      estDist += Math.hypot((b.lon - a.lon) * mPerLon2, (b.lat - a.lat) * 111_132);
    }

    // ★ HEADING ERROR, MEASURED WHERE IT MEANS ANYTHING ★
    // A truth course taken from three points of a vehicle that is crawling is
    // noise, so the comparison is restricted to samples where the vehicle is
    // genuinely moving, and averaged over the window rather than read off its
    // last instant.
    const mPerLat = 111_132;
    const errs: number[] = [];
    for (let i = 2; i < tr.length; i++) {
      const a = tr[i - 2]!;
      const b = tr[i]!;
      const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
      const de = (b.lon - a.lon) * mPerLon;
      const dn = (b.lat - a.lat) * mPerLat;
      const step = Math.hypot(de, dn);
      const dtS = (b.t - a.t) / 1000;
      if (dtS <= 0 || step / dtS < 3) continue; // crawling: no usable course
      const truthHdg = (Math.atan2(de, dn) * 180) / Math.PI;
      const near = st.reduce((best, x) =>
        Math.abs(x.t - b.t) < Math.abs(best.t - b.t) ? x : best,
      );
      errs.push(Math.abs(((near.headingDeg - truthHdg + 540) % 360) - 180));
    }
    const hdgErr = errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : NaN;

    const spdBias = estMeanSpeed - trueMeanSpeed;
    agg.spdBias.push(spdBias);
    agg.hdg.push(Math.abs(hdgErr));

    if (!process.argv.includes('--quiet')) console.log(
      `  ${r.log.replace('iovnbd_', '').replace('.jsonl', '').padEnd(18)} ` +
        `${String(w / 1000).padStart(5)} ` +
        `${res.metrics.driftPercent.toFixed(1).padStart(7)} ` +
        `${(estMeanSpeed - trueMeanSpeed).toFixed(2).padStart(7)} ` +
        `${((estMeanSpeed / Math.max(0.1, trueMeanSpeed)) * 100 - 100).toFixed(0).padStart(6)}% ` +
        `${hdgErr.toFixed(1).padStart(7)} ` +
        `${trueDist.toFixed(0).padStart(7)} ` +
        `${estDist.toFixed(0).padStart(7)}`,
    );
  }
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
console.log(
  `\n  MEAN  speed bias ${mean(agg.spdBias).toFixed(2)} m/s   ` +
    `|heading err| ${mean(agg.hdg).toFixed(1)} deg\n`,
);
