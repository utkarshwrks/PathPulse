import type { EvalMetrics } from './metrics.js';

/**
 * Aggregation and report rendering for the ablation.
 *
 * Split out from the runner so it can be tested. A table generator that has
 * never been asserted will happily emit a row with the wrong number of columns,
 * a CSV whose header does not match its body, or an SVG that does not parse —
 * and nobody finds out until the file is open in front of a judge.
 */

/** Three windows per log: an early outage, a late one, and a long one. */
export const WINDOWS = [
  { startMs: 30_000, durationMs: 60_000 },
  { startMs: 60_000, durationMs: 45_000 },
  { startMs: 45_000, durationMs: 90_000 },
] as const;

export interface Aggregate {
  config: string;
  description: string;
  runs: number;
  meanDriftPct: number;
  medianDriftPct: number;
  p90DriftPct: number;
  maxDriftPct: number;
  meanRmseM: number;
  meanAlongM: number;
  meanCrossM: number;
  meanCep95M: number;
  meanRecoveryS: number;
  meanUpdateHz: number;
  totalZupt: number;
  roadSnapPct: number;
  positionResets: number;
  /** Non-finite samples dropped across every run. Should be zero. */
  discardedSamples: number;
}

export function stat(values: readonly number[]): {
  mean: number;
  median: number;
  p90: number;
  max: number;
} {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { mean: NaN, median: NaN, p90: NaN, max: NaN };
  const s = [...finite].sort((a, b) => a - b);
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: s[Math.floor(s.length / 2)]!,
    p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!,
    max: s[s.length - 1]!,
  };
}

export function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
}

/** Format a possibly-absent number. Never prints "NaN" into a report. */
export function f(v: number, d = 1): string {
  return Number.isFinite(v) ? v.toFixed(d) : 'n/a';
}

/** Collapse many runs of one configuration into a single table row. */
export function aggregate(
  config: { name: string; description?: string },
  results: readonly EvalMetrics[],
): Aggregate {
  const d = stat(results.map((r) => r.driftPercent));
  return {
    config: config.name,
    description: config.description ?? '',
    runs: results.length,
    meanDriftPct: d.mean,
    medianDriftPct: d.median,
    p90DriftPct: d.p90,
    maxDriftPct: d.max,
    meanRmseM: mean(results.map((r) => r.rmseM)),
    // Absolute, because along/cross are signed and a symmetric error would
    // otherwise average to a flattering zero.
    meanAlongM: mean(results.map((r) => Math.abs(r.alongTrackRmseM))),
    meanCrossM: mean(results.map((r) => Math.abs(r.crossTrackRmseM))),
    meanCep95M: mean(results.map((r) => r.cep95M)),
    meanRecoveryS: mean(
      results.map((r) => r.recoveryTimeS).filter((v): v is number => v !== null),
    ),
    meanUpdateHz: mean(results.map((r) => r.meanUpdateHz)),
    totalZupt: results.reduce((s, r) => s + r.zuptTriggers, 0),
    roadSnapPct: mean(results.map((r) => r.roadSnapAppliedPct)),
    positionResets: results.reduce((s, r) => s + r.positionResets, 0),
    discardedSamples: results.reduce((s, r) => s + r.discardedSamples, 0),
  };
}

export function svgChart(rows: readonly Aggregate[]): string {
  const W = 900;
  const barH = 30;
  const gap = 10;
  const left = 210;
  const top = 56;
  const H = top + rows.length * (barH + gap) + 46;
  const values = rows.map((r) => (Number.isFinite(r.meanDriftPct) ? r.meanDriftPct : 0));
  const maxVal = Math.max(...values, 1);
  const scale = (W - left - 90) / maxVal;

  const bars = rows
    .map((r, i) => {
      const y = top + i * (barH + gap);
      const v = Number.isFinite(r.meanDriftPct) ? r.meanDriftPct : 0;
      const w = Math.max(1, v * scale);
      // Green once inside the problem statement's <10% target, amber otherwise.
      const fill = v < 10 ? '#22c55e' : v < 30 ? '#eab308' : '#f97316';
      return `  <text x="${left - 12}" y="${y + barH * 0.68}" text-anchor="end" font-size="13" fill="#cbd5e1">${escapeXml(r.config)}</text>
  <rect x="${left}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${fill}" />
  <text x="${(left + w + 10).toFixed(1)}" y="${y + barH * 0.68}" font-size="13" fill="#e2e8f0">${f(r.meanDriftPct, 1)}%</text>`;
    })
    .join('\n');

  const targetX = left + 10 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#0a0e14" />
  <text x="24" y="30" font-size="16" fill="#f1f5f9" font-weight="600">PathPulse — mean drift by constraint set</text>
  <text x="24" y="48" font-size="12" fill="#64748b">${rows[0]?.runs ?? 0} runs per configuration · lower is better · dashed line is the &lt;10% target</text>
${bars}
  <line x1="${targetX.toFixed(1)}" y1="${top - 8}" x2="${targetX.toFixed(1)}" y2="${H - 34}" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 4" />
  <text x="${(targetX + 6).toFixed(1)}" y="${H - 20}" font-size="11" fill="#38bdf8">10% target</text>
</svg>
`;
}

/** XML-escape a config name, so a stray `&` cannot produce an unparseable SVG. */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );
}

export function markdown(
  rows: readonly Aggregate[],
  logs: readonly string[],
  graphNames: ReadonlySet<string>,
): string {
  // `every` on an empty array is true, which would silently drop the warning
  // from a report generated with no logs at all.
  const simulated = logs.length > 0 && logs.every((l) => l.startsWith('sim_'));
  const discarded = rows.reduce((s, r) => s + r.discardedSamples, 0);

  return `# PathPulse benchmarks

**Generated by \`pnpm ablation\`. Do not edit by hand — rerun it.**

${rows[0]?.runs ?? 0} runs per configuration: ${logs.length} logs × ${WINDOWS.length} outage windows.
Ground truth is each log's own recorded GNSS, withheld from the estimator over
the outage window. Road graphs used: ${graphNames.size ? [...graphNames].join(', ') : 'none'}.

${
  simulated
    ? '> ⚠️ **Every log here is SIMULATED** (`sim_*.jsonl`), not driven. These numbers\n> measure the estimator against a physics model, not against a road. Real drive\n> logs belong alongside them as `drive_*.jsonl`; until then, do not present any\n> figure in this file as a road result.'
    : '> Includes real drive logs (`drive_*.jsonl`).'
}
${discarded > 0 ? `\n> ⚠️ **${discarded} samples were discarded as non-finite.** That should never\n> happen — nav-core asserts it cannot emit one. Investigate before trusting\n> anything below.\n` : ''}
## Drift

| Configuration | Mean % | Median % | p90 % | Max % | RMSE m | Along m | Cross m | CEP95 m |
|---|---|---|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.config} | **${f(r.meanDriftPct)}** | ${f(r.medianDriftPct)} | ${f(r.p90DriftPct)} | ${f(r.maxDriftPct)} | ${f(r.meanRmseM)} | ${f(r.meanAlongM)} | ${f(r.meanCrossM)} | ${f(r.meanCep95M)} |`,
  )
  .join('\n')}

![drift by configuration](./ablation.svg)

## Behaviour

| Configuration | Recovery s | Update Hz | ZUPT | Road snap % | Resets |
|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.config} | ${f(r.meanRecoveryS, 2)} | ${f(r.meanUpdateHz)} | ${r.totalZupt} | ${f(r.roadSnapPct)} | ${r.positionResets} |`,
  )
  .join('\n')}

## What each row is

${rows.map((r) => `- **${r.config}** — ${r.description}`).join('\n')}

## Reading this table

**Along-track and cross-track are separated on purpose.** A single error figure
says how wrong the estimate is; the split says *how* it is wrong, and the two
have different causes and different fixes. Cross-track error is what puts the
marker inside a building, and road geometry bounds it. Along-track error leaves
the marker on the right road at the wrong point along it, comes from speed
error, and road snapping deliberately does nothing about it.

**Drift % is final error over distance actually travelled**, taken from ground
truth rather than from the estimate's own idea of how far it went — otherwise a
configuration that under-estimates its speed would flatter itself twice.

**The p90 and max columns matter more than the mean.** A good mean hiding a bad
tail is exactly what someone finds by picking the one drive that went wrong.

## Reproducing

\`\`\`bash
pnpm eval:record     # regenerate the simulated logs (deterministic)
pnpm ablation        # rerun every configuration over every log
pnpm eval -- --log sim_city_4242.jsonl --config full   # one run, in detail
\`\`\`

The engine is deterministic — the same samples in produce byte-identical states
out, which nav-core's invariant tests assert — so these numbers reproduce
exactly on any machine.
`;
}

const CSV_COLUMNS = [
  'config',
  'runs',
  'mean_drift_pct',
  'median_drift_pct',
  'p90_drift_pct',
  'max_drift_pct',
  'mean_rmse_m',
  'mean_along_m',
  'mean_cross_m',
  'mean_cep95_m',
  'mean_recovery_s',
  'mean_update_hz',
  'zupt_triggers',
  'road_snap_pct',
  'position_resets',
  'discarded_samples',
] as const;

export function csv(rows: readonly Aggregate[]): string {
  const body = rows
    .map((r) =>
      [
        r.config,
        r.runs,
        f(r.meanDriftPct, 3),
        f(r.medianDriftPct, 3),
        f(r.p90DriftPct, 3),
        f(r.maxDriftPct, 3),
        f(r.meanRmseM, 3),
        f(r.meanAlongM, 3),
        f(r.meanCrossM, 3),
        f(r.meanCep95M, 3),
        f(r.meanRecoveryS, 3),
        f(r.meanUpdateHz, 3),
        r.totalZupt,
        f(r.roadSnapPct, 3),
        r.positionResets,
        r.discardedSamples,
      ].join(','),
    )
    .join('\n');
  return `${CSV_COLUMNS.join(',')}\n${body}\n`;
}

export const CSV_HEADER = CSV_COLUMNS;
