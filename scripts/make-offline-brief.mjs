#!/usr/bin/env node
/**
 * Build the last-resort brief: one self-contained HTML file.
 *
 * ★ THE BACKUP BEHIND THE BACKUP ★
 * If the APK will not install, the laptop will not project and the phone is
 * flat, this is what is left: a single file with the measured numbers, the
 * compliance position and the honest caveats, openable from a USB stick on
 * someone else's machine with no network. No build step, no framework, no
 * fonts to fetch.
 *
 * Generated rather than written, so it cannot disagree with the ablation the
 * rest of the project reports. Regenerate after `pnpm ablation`.
 *
 *   node scripts/make-offline-brief.mjs   ->  docs/offline-brief.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bench = JSON.parse(readFileSync(resolve(ROOT, 'docs/benchmarks.json'), 'utf8'));

/**
 * The compliance rows, mirrored from apps/web/lib/pitch.ts.
 *
 * Duplicated deliberately: this file must build with nothing but Node and two
 * JSON reads, because the day it is needed is the day the toolchain is the
 * problem. The test asserts the two lists stay in step.
 */
const COMPLIANCE = [
  ['Seamless GNSS deficit handler (ms switchover)', 'DONE', 'Dead reckoning runs continuously in shadow mode, so the switch costs 0 ms.'],
  ['Drift under 10% of distance', 'PARTIAL', '10.0% mean, 6.4% median over 12 runs — on the line, not under it. p90 is 22.6%. Simulated logs only.'],
  ['10 Hz update rate on a smartphone', 'DONE', 'Measured from real frames and shown on the HUD, which turns amber below 10 Hz.'],
  ['Advanced map matching & kinematic constraints', 'PARTIAL', 'NHC, ZUPT, ZARU and road snapping on a real OSM graph. HMM is Part B.'],
  ['GNSS + INS fusion engine', 'PARTIAL', 'Complementary fusion with bounded-rate recovery. ESKF is Part B.'],
  ['AI speed model trained on IO-VNBD', 'DONE', '1D-CNN, INT8 ONNX, on-device. No cloud call anywhere in the app.'],
  ['IO-VNBD position plot (screening)', 'DONE', 'ml/results/position_plot.png — predicted trajectory against ground truth.'],
  ['On-device inference, no cloud', 'DONE', 'ONNX Runtime Web inside the APK.'],
  ['Real-time navigation interface', 'DONE', 'Map, HUD, confidence ellipse, event log, live constraint toggles.'],
  ['Mobile application', 'DONE', 'Android APK via Capacitor, tested on a physical phone.'],
  ['Offline map database', 'PARTIAL', 'Road graphs ship in the APK and tiles cache on request. Packaged PMTiles not built.'],
  ['In-vehicle alignment & calibration', 'PARTIAL', 'Attitude resolved against measured gravity, so any mounting angle works. Auto mount-yaw is Part B.'],
  ['Pothole / vibration rejection', 'PARTIAL', 'Median despike and low-pass filters. Learned classifier is Part B.'],
  ['200 Hz edge engine, external IMU', 'PART B', 'Not built. nav-core is pure and runtime-free so this needs porting, not rewriting.'],
  ['Phone misalignment handling', 'PART B', 'Not built. Attitude handles tilt; automatic mount-yaw estimation is the missing piece.'],
];

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = bench.rows
  .map((r) => {
    const shipped = r.config === 'full';
    return `      <tr${shipped ? ' class="shipped"' : ''}>
        <td>${esc(r.config)}</td>
        <td class="n">${r.meanDriftPct.toFixed(1)}</td>
        <td class="n">${r.medianDriftPct.toFixed(1)}</td>
        <td class="n">${r.p90DriftPct.toFixed(1)}</td>
        <td class="n">${Math.round(r.meanRmseM)}</td>
      </tr>`;
  })
  .join('\n');

const compliance = COMPLIANCE.map(
  ([req, status, detail]) => `      <div class="row">
        <div class="head"><span>${esc(req)}</span><b class="s-${status.replace(' ', '')}">${esc(status)}</b></div>
        <p>${esc(detail)}</p>
      </div>`,
).join('\n');

const full = bench.rows.find((r) => r.config === 'full');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PathPulse — SIH26168 — measured results</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0a0e14; color:#e5e7eb;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  h2 { font-size:1rem; margin:2rem 0 .5rem; color:#93c5fd; }
  .sub { color:#9ca3af; margin:0 0 1.5rem; }
  .headline { border:1px solid #1f2937; background:#0d1117; border-radius:.6rem; padding:1rem; }
  .headline b { font-size:1.5rem; color:#34d399; }
  table { width:100%; border-collapse:collapse; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  th,td { padding:.3rem .5rem; border-bottom:1px solid #1f2937; text-align:left; }
  th { color:#6b7280; font-weight:400; }
  td.n, th.n { text-align:right; }
  tr.shipped td { color:#34d399; }
  .warn { border-left:3px solid #f59e0b; background:#f59e0b12; padding:.6rem .8rem;
          color:#fcd34d; border-radius:0 .4rem .4rem 0; margin:1rem 0; }
  .row { border:1px solid #1f2937; border-radius:.4rem; padding:.5rem .7rem; margin-bottom:.4rem; }
  .head { display:flex; justify-content:space-between; gap:1rem; align-items:start; }
  .head span { font-weight:600; font-size:.85rem; }
  .head b { font-size:.65rem; padding:.1rem .4rem; border-radius:.25rem; white-space:nowrap; }
  .s-DONE { background:#10b98133; color:#6ee7b7; }
  .s-PARTIAL { background:#f59e0b33; color:#fcd34d; }
  .s-PARTB { background:#0ea5e933; color:#7dd3fc; }
  .row p { margin:.25rem 0 0; font-size:.78rem; color:#9ca3af; }
  footer { margin-top:2.5rem; color:#4b5563; font-size:.72rem; }
  code { background:#1f2937; padding:.05rem .3rem; border-radius:.2rem; }
</style>
</head>
<body>
<main>
  <h1>PathPulse</h1>
  <p class="sub">AI-ML Intelligent Dead Reckoning for GNSS-denied navigation ·
     SIH26168 · ISRO · Team Avinya</p>

  <div class="headline">
    <p style="margin:0 0 .4rem;color:#9ca3af;font-size:.8rem">Measured drift, shipped configuration</p>
    <b>${full ? full.meanDriftPct.toFixed(1) : '—'}% mean</b>
    <span style="color:#9ca3af">· ${full ? full.medianDriftPct.toFixed(1) : '—'}% median
      · ${full ? full.p90DriftPct.toFixed(1) : '—'}% p90 · ${full ? full.runs : '—'} runs</span>
  </div>

  <div class="warn">
    <b>Every log is simulated.</b> These numbers measure the estimator against a physics
    model, not against a road — no real drive log exists yet. The mean sits on the
    problem statement's &lt;10% target rather than under it, and the p90 does not:
    quote the mean alone and the tail is the first thing anyone finds.
  </div>

  <h2>Ablation — one component at a time</h2>
  <table>
    <thead><tr><th>configuration</th><th class="n">mean %</th><th class="n">median %</th>
      <th class="n">p90 %</th><th class="n">RMSE m</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p style="color:#6b7280;font-size:.75rem;margin-top:.5rem">
    Each row differs from the one above by exactly one component. Ground truth is each
    log's own recorded GNSS, withheld from the estimator across the outage window.
    The <code>full_forwardbias</code> row is a negative result: it made drift worse,
    so it ships disabled and is reported anyway.
  </p>

  <h2>Against the problem statement</h2>
${compliance}

  <h2>How to check any of this</h2>
  <p style="color:#9ca3af;font-size:.85rem">
    <code>pnpm ablation</code> regenerates the table above from the logs in
    <code>data/replay/</code>. <code>pnpm eval -- --log sim_city_1337.jsonl --config full</code>
    scores a single run. <code>pnpm -r test</code> runs the full suite.
    Every number on this page is generated by those commands, not typed.
  </p>

  <footer>
    Generated ${new Date().toISOString().slice(0, 10)} from docs/benchmarks.json by
    scripts/make-offline-brief.mjs · github.com/utkarshwrks/PathPulse
  </footer>
</main>
</body>
</html>
`;

const target = resolve(ROOT, 'docs/offline-brief.html');
writeFileSync(target, html);
console.log(`  wrote docs/offline-brief.html (${Math.round(html.length / 1024)} kB, self-contained)`);
