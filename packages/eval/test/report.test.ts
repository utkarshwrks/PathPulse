import { describe, expect, it } from 'vitest';
import type { EvalMetrics } from '../src/metrics.js';
import { CSV_HEADER, aggregate, csv, f, markdown, mean, stat, svgChart, type Aggregate } from '../src/report.js';

/**
 * The report generator.
 *
 * Everything here ends up in front of a judge — docs/benchmarks.md, the CSV a
 * chart gets built from, the SVG on the slide. A generator that emits a row
 * with the wrong column count, a header that does not match its body, or an
 * SVG that does not parse fails silently until the moment it matters.
 */

function metrics(patch: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    configName: 'c',
    log: 'l.jsonl',
    outageStartMs: 30_000,
    outageDurationS: 60,
    samples: 3000,
    discardedSamples: 0,
    distanceTravelledM: 800,
    driftPercent: 10,
    finalErrorM: 80,
    rmseM: 40,
    maeM: 30,
    maxErrorM: 80,
    alongTrackRmseM: 30,
    crossTrackRmseM: 20,
    cep95M: 70,
    recoveryTimeS: 2,
    meanUpdateHz: 50,
    zuptTriggers: 3,
    zaruTriggers: 7,
    roadSnapAppliedPct: 90,
    positionResets: 0,
    ...patch,
  };
}

function agg(config: string, driftPcts: number[]): Aggregate {
  return aggregate(
    { name: config, description: `${config} desc` },
    driftPcts.map((d) => metrics({ driftPercent: d })),
  );
}

describe('stat and mean', () => {
  it('computes mean, median, p90 and max', () => {
    const s = stat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.mean).toBeCloseTo(5.5, 6);
    expect(s.median).toBe(6);
    expect(s.max).toBe(10);
    expect(s.p90).toBeGreaterThanOrEqual(s.median);
  });

  it('ignores non-finite values rather than propagating them', () => {
    // A single unusable run must not turn a whole configuration into n/a.
    const s = stat([1, Number.NaN, 3, Infinity]);
    expect(s.mean).toBeCloseTo(2, 6);
    expect(s.max).toBe(3);
  });

  it('is honestly absent for no data at all', () => {
    const s = stat([]);
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.p90)).toBe(true);
    expect(Number.isNaN(mean([]))).toBe(true);
  });

  it('handles a single value', () => {
    const s = stat([7]);
    expect(s.mean).toBe(7);
    expect(s.median).toBe(7);
    expect(s.p90).toBe(7);
    expect(s.max).toBe(7);
  });

  it('never indexes past the end for p90', () => {
    for (let n = 1; n <= 25; n++) {
      const s = stat(Array.from({ length: n }, (_, i) => i));
      expect(Number.isFinite(s.p90)).toBe(true);
      expect(s.p90).toBeLessThanOrEqual(s.max);
    }
  });
});

describe('f — formatting', () => {
  it('never prints NaN or Infinity into a report', () => {
    // "n/a" gets investigated; "NaN" in a table gets screenshotted.
    expect(f(Number.NaN)).toBe('n/a');
    expect(f(Infinity)).toBe('n/a');
    expect(f(-Infinity)).toBe('n/a');
  });

  it('respects the requested precision', () => {
    expect(f(1.23456, 3)).toBe('1.235');
    expect(f(10)).toBe('10.0');
  });
});

describe('aggregate', () => {
  it('collapses many runs into one row', () => {
    const a = agg('full', [8, 10, 12]);
    expect(a.runs).toBe(3);
    expect(a.meanDriftPct).toBeCloseTo(10, 6);
    expect(a.config).toBe('full');
    expect(a.description).toBe('full desc');
  });

  it('excludes unusable runs from the drift statistics but still counts them', () => {
    // runs is how many were attempted; the statistics are over what could be
    // scored. Conflating the two would let a config quietly skip its hard runs.
    const a = aggregate({ name: 'x' }, [
      metrics({ driftPercent: 10 }),
      metrics({ driftPercent: Number.NaN }),
    ]);
    expect(a.runs).toBe(2);
    expect(a.meanDriftPct).toBeCloseTo(10, 6);
  });

  it('sums discarded samples across runs so they cannot hide', () => {
    const a = aggregate({ name: 'x' }, [
      metrics({ discardedSamples: 2 }),
      metrics({ discardedSamples: 5 }),
    ]);
    expect(a.discardedSamples).toBe(7);
  });

  it('takes the magnitude of the signed along/cross figures', () => {
    // They are signed, so a symmetric error would otherwise average to a
    // flattering zero.
    const a = aggregate({ name: 'x' }, [
      metrics({ alongTrackRmseM: 30, crossTrackRmseM: -20 }),
      metrics({ alongTrackRmseM: -30, crossTrackRmseM: 20 }),
    ]);
    expect(a.meanAlongM).toBeCloseTo(30, 6);
    expect(a.meanCrossM).toBeCloseTo(20, 6);
  });

  it('ignores runs that never recovered when averaging recovery time', () => {
    const a = aggregate({ name: 'x' }, [
      metrics({ recoveryTimeS: 2 }),
      metrics({ recoveryTimeS: null }),
      metrics({ recoveryTimeS: 4 }),
    ]);
    expect(a.meanRecoveryS).toBeCloseTo(3, 6);
  });

  it('survives having no runs at all', () => {
    const a = aggregate({ name: 'x' }, []);
    expect(a.runs).toBe(0);
    expect(Number.isNaN(a.meanDriftPct)).toBe(true);
  });
});

describe('csv', () => {
  const rows = [agg('naive', [61]), agg('full', [10])];

  it('has a header matching every row exactly', () => {
    // ★ A header that drifts from its body silently mislabels every column of
    // whatever chart gets built from it.
    const lines = csv(rows).trim().split('\n');
    const cols = lines[0]!.split(',').length;
    expect(cols).toBe(CSV_HEADER.length);
    for (const line of lines.slice(1)) {
      expect(line.split(',').length).toBe(cols);
    }
  });

  it('has one row per configuration', () => {
    expect(csv(rows).trim().split('\n')).toHaveLength(rows.length + 1);
  });

  it('writes n/a rather than NaN', () => {
    const out = csv([aggregate({ name: 'empty' }, [])]);
    expect(out).toContain('n/a');
    expect(out).not.toContain('NaN');
  });

  it('ends with a newline, so appending does not corrupt the last row', () => {
    expect(csv(rows).endsWith('\n')).toBe(true);
  });
});

describe('svgChart', () => {
  const rows = [agg('naive', [61]), agg('highpass', [13.6]), agg('full', [10])];

  it('produces parseable XML', () => {
    const svg = svgChart(rows);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // Balanced tags: a broken SVG renders as nothing at all in a browser.
    expect((svg.match(/<rect/g) ?? []).length).toBe(rows.length + 1);
  });

  it('draws one bar per configuration, with its label and value', () => {
    const svg = svgChart(rows);
    for (const r of rows) expect(svg).toContain(r.config);
    expect(svg).toContain('61.0%');
    expect(svg).toContain('10.0%');
  });

  it('colours a passing configuration differently from a failing one', () => {
    const svg = svgChart([agg('good', [8]), agg('naive', [61])]);
    expect(svg).toContain('#22c55e'); // 8%, genuinely under the target
    expect(svg).toContain('#f97316'); // 61%, nowhere near
  });

  it('does not colour exactly 10.0% as passing', () => {
    // ★ This is not pedantry — `full` currently sits at exactly 10.0%. ★
    // The target is "<10%", so 10.0 does not meet it, and the chart must not
    // paint it green. A boundary that rounds in our favour is how a benchmark
    // starts flattering itself.
    const svg = svgChart([agg('full', [10])]);
    expect(svg).not.toContain('#22c55e');
    expect(svg).toContain('#eab308');
  });

  it('marks the 10% target line', () => {
    expect(svgChart(rows)).toContain('10% target');
  });

  it('escapes a config name that would otherwise break the XML', () => {
    // Config names come from files on disk; one containing & would produce an
    // SVG that silently fails to render.
    const svg = svgChart([agg('a&b<c>', [10])]);
    expect(svg).toContain('a&amp;b&lt;c&gt;');
  });

  it('does not divide by zero when every value is zero', () => {
    const svg = svgChart([agg('perfect', [0])]);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });

  it('survives a configuration with no usable runs', () => {
    const svg = svgChart([aggregate({ name: 'empty' }, [])]);
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('n/a');
  });
});

describe('markdown', () => {
  const rows = [agg('naive', [61]), agg('full', [10])];

  it('renders a table row per configuration', () => {
    const md = markdown(rows, ['sim_a.jsonl'], new Set(['city']));
    for (const r of rows) expect(md).toContain(`| ${r.config} |`);
  });

  it('warns loudly when every log is simulated', () => {
    const md = markdown(rows, ['sim_a.jsonl', 'sim_b.jsonl'], new Set());
    expect(md).toMatch(/SIMULATED/);
    // Matched with the markdown line breaks stripped: the previous version of
    // this assertion encoded where the sentence happened to wrap, so rewording
    // the banner broke it for no reason connected to what it is guarding.
    const flat = md.replace(/\n>\s*/g, ' ');
    expect(flat).toMatch(/do not present any figure in this file as a road result/i);
  });

  it('★ points at the Tier R numbers rather than hiding behind the simulated ones', () => {
    // The banner used to say only "these are simulated". It now has to say what
    // the real-sensor figure is, because a reader who stops at this file would
    // otherwise take 6.9 % as the estimator's accuracy — and it is 41.3 % on
    // real sensors. A generated file is the only place that stays true, since
    // `pnpm ablation` overwrites anything added by hand.
    const md = markdown(rows, ['sim_a.jsonl', 'sim_b.jsonl'], new Set());
    expect(md).toMatch(/benchmarks-tier-r\.md/);
    expect(md).toMatch(/never average a row here with a Tier R row/i);
  });

  it('drops the warning once a real drive log is included', () => {
    const md = markdown(rows, ['sim_a.jsonl', 'drive_real.jsonl'], new Set());
    expect(md).not.toMatch(/Every log here is SIMULATED/);
    expect(md).toMatch(/real drive logs/i);
  });

  it('does not claim simulated when there are no logs at all', () => {
    // `every` on an empty array is true, which would have produced a confident
    // warning about a report containing nothing.
    const md = markdown(rows, [], new Set());
    expect(md).not.toMatch(/Every log here is SIMULATED/);
  });

  it('surfaces discarded samples at the top rather than in a column', () => {
    const bad = aggregate({ name: 'x', description: 'd' }, [metrics({ discardedSamples: 4 })]);
    const md = markdown([bad], ['sim_a.jsonl'], new Set());
    expect(md).toMatch(/4 samples were discarded as non-finite/);
    expect(md).toMatch(/Investigate before trusting/);
  });

  it('says nothing about discards when there are none', () => {
    expect(markdown(rows, ['sim_a.jsonl'], new Set())).not.toMatch(/discarded/i);
  });

  it('names the road graphs used, or says none', () => {
    expect(markdown(rows, ['sim_a.jsonl'], new Set(['city', 'highway']))).toContain('city, highway');
    expect(markdown(rows, ['sim_a.jsonl'], new Set())).toMatch(/Road graphs used: none/);
  });

  it('explains the along/cross split rather than only tabulating it', () => {
    const md = markdown(rows, ['sim_a.jsonl'], new Set());
    expect(md).toMatch(/marker inside a building/);
    expect(md).toMatch(/road snapping deliberately does nothing about it/);
  });

  it('tells the reader how to reproduce it', () => {
    const md = markdown(rows, ['sim_a.jsonl'], new Set());
    expect(md).toContain('pnpm ablation');
    expect(md).toContain('pnpm eval:record');
  });

  it('writes n/a rather than NaN', () => {
    const md = markdown([aggregate({ name: 'empty' }, [])], ['sim_a.jsonl'], new Set());
    expect(md).not.toContain('NaN');
  });
});
