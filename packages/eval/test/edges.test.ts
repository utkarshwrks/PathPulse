import { describe, expect, it } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { computeMetrics, decomposeError, truthAt, truthDistanceM, truthHeadingAt } from '../src/metrics.js';
import { parseJsonl, runEval } from '../src/harness.js';
import { loadConfig, parseArgs, readLog } from '../src/paths.js';

const LAT = 28.6315;
const LON = 77.2167;
const G = 9.80665;

/**
 * Adversarial input for the eval harness.
 *
 * A benchmark that crashes on a short log is annoying; a benchmark that
 * silently returns a flattering number for a broken one is dangerous. These
 * push degenerate and hostile input through the whole path and check that the
 * result is either correct or honestly absent — never a plausible-looking
 * number with nothing behind it.
 */

function log(samples: Array<Partial<SensorSample> & { t: number }>): string {
  return samples.map((s) => JSON.stringify(s)).join('\n');
}

function imu() {
  return { ax: 0, ay: 0, az: G, gx: 0, gy: 0, gz: 0 };
}

function drive(seconds: number, opts: { gnssEvery?: number; speedMps?: number } = {}) {
  const { gnssEvery = 1000, speedMps = 10 } = opts;
  const out: Array<Partial<SensorSample> & { t: number }> = [];
  const mPerLon = 111_320 * Math.cos((LAT * Math.PI) / 180);
  for (let t = 0; t <= seconds * 1000; t += 20) {
    const s: Partial<SensorSample> & { t: number } = { t, imu: imu() };
    if (t % gnssEvery === 0) {
      s.gnss = {
        lat: LAT,
        lon: LON + (speedMps * t) / 1000 / mPerLon,
        accuracyM: 4,
        speedMps,
        headingDeg: 90,
        satCount: 9,
      };
    }
    out.push(s);
  }
  return out;
}

const BASE = {
  configName: 'test',
  logName: 'test.jsonl',
  engineConfig: {},
  outageStartMs: 10_000,
  outageDurationMs: 10_000,
};

describe('parseJsonl — hostile logs', () => {
  it('returns nothing for an empty file', () => {
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl('\n\n   \n')).toEqual([]);
  });

  it('skips lines that are valid JSON but not samples', () => {
    const text = ['null', '42', '"hello"', '[]', '{"nope":1}', JSON.stringify({ t: 5 })].join('\n');
    expect(parseJsonl(text)).toEqual([{ t: 5 }]);
  });

  it('rejects a non-finite timestamp rather than sorting NaN', () => {
    // NaN in a comparator makes the sort order undefined, which would silently
    // scramble the whole log.
    const text = ['{"t":null}', '{"t":"x"}', JSON.stringify({ t: 1 })].join('\n');
    expect(parseJsonl(text)).toEqual([{ t: 1 }]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseJsonl(`{"t":0}\r\n{"t":20}\r\n`).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps duplicate timestamps rather than dropping data', () => {
    // The engine rejects them itself; silently discarding here would hide a
    // recording problem instead of surfacing it.
    expect(parseJsonl(log([{ t: 0 }, { t: 0 }, { t: 20 }]))).toHaveLength(3);
  });
});

describe('truthAt — degenerate truth', () => {
  it('handles two identical timestamps without dividing by zero', () => {
    const truth = [
      { t: 1000, lat: LAT, lon: LON },
      { t: 1000, lat: LAT + 0.001, lon: LON },
    ];
    const p = truthAt(truth, 1000)!;
    expect(Number.isFinite(p.lat)).toBe(true);
  });

  it('handles a stationary track', () => {
    const truth = Array.from({ length: 5 }, (_, i) => ({ t: i * 1000, lat: LAT, lon: LON }));
    expect(truthAt(truth, 2500)!.lat).toBeCloseTo(LAT, 9);
    expect(truthHeadingAt(truth, 2500)).toBeNull();
  });
});

describe('decomposeError — non-finite input', () => {
  it('does not turn a NaN position into a NaN split silently', () => {
    const d = decomposeError({ lat: Number.NaN, lon: LON }, { lat: LAT, lon: LON }, 90);
    // The magnitude is honestly NaN; what must not happen is a finite-looking
    // along/cross pair implying we measured something.
    expect(Number.isNaN(d.errorM)).toBe(true);
  });

  it('handles an exactly-coincident estimate', () => {
    const d = decomposeError({ lat: LAT, lon: LON }, { lat: LAT, lon: LON }, 90);
    expect(d.errorM).toBe(0);
    expect(d.alongM).toBe(0);
    expect(d.crossM).toBe(0);
  });

  it('works at the equator and near the poles', () => {
    for (const lat of [0, 60, 84]) {
      const d = decomposeError({ lat, lon: 10 }, { lat, lon: 10 }, 90);
      expect(Number.isFinite(d.errorM)).toBe(true);
    }
  });
});

describe('truthDistanceM — window edges', () => {
  const truth = Array.from({ length: 11 }, (_, i) => ({
    t: i * 1000,
    lat: LAT,
    lon: LON + (10 * i) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
  }));

  it('is zero for an inverted window', () => {
    expect(truthDistanceM(truth, 8000, 2000)).toBe(0);
  });

  it('is zero for a window with no truth in it', () => {
    expect(truthDistanceM(truth, 50_000, 60_000)).toBe(0);
  });

  it('handles an empty truth array', () => {
    expect(truthDistanceM([], 0, 10_000)).toBe(0);
  });
});

describe('runEval — degenerate logs', () => {
  it('handles a log with no samples at all', () => {
    const r = runEval([], BASE);
    expect(r.states).toEqual([]);
    expect(r.truth).toEqual([]);
    expect(r.metrics.samples).toBe(0);
    expect(Number.isNaN(r.metrics.driftPercent)).toBe(true);
  });

  it('handles a log with no GNSS anywhere', () => {
    // No truth means nothing to score against. The result must be empty rather
    // than a confident zero.
    const samples = parseJsonl(log([{ t: 0, imu: imu() }, { t: 20, imu: imu() }]));
    const r = runEval(samples, BASE);
    expect(r.truth).toEqual([]);
    expect(r.metrics.samples).toBe(0);
    expect(r.metrics.finalErrorM).toBe(0);
    expect(Number.isNaN(r.metrics.driftPercent)).toBe(true);
  });

  it('handles an outage window entirely after the log ends', () => {
    const samples = parseJsonl(log(drive(5)));
    const r = runEval(samples, { ...BASE, outageStartMs: 900_000, outageDurationMs: 60_000 });
    expect(r.metrics.samples).toBe(0);
    // Nothing was withheld, so there is nothing to report — not 0% drift.
    expect(Number.isNaN(r.metrics.driftPercent)).toBe(true);
  });

  it('handles an outage window entirely before the log starts', () => {
    const samples = parseJsonl(log(drive(5)));
    const r = runEval(samples, { ...BASE, outageStartMs: -60_000, outageDurationMs: 10_000 });
    expect(r.metrics.samples).toBe(0);
  });

  it('handles a zero-length outage', () => {
    const samples = parseJsonl(log(drive(20)));
    const r = runEval(samples, { ...BASE, outageDurationMs: 0 });
    expect(r.metrics.samples).toBe(0);
    expect(r.states.length).toBe(samples.length);
  });

  it('handles an outage covering the entire log', () => {
    // Nothing is ever aided, so the engine never initialises and the estimate
    // never moves. That must not be scored as a perfect result.
    const samples = parseJsonl(log(drive(20)));
    const r = runEval(samples, { ...BASE, outageStartMs: 0, outageDurationMs: 999_999 });
    expect(r.metrics.recoveryTimeS).toBeNull();
    expect(r.states.every((s) => Number.isFinite(s.position.lat))).toBe(true);
  });

  it('survives a log whose GNSS is corrupt', () => {
    const samples = parseJsonl(
      log([
        { t: 0, imu: imu(), gnss: { lat: Number.NaN, lon: LON, accuracyM: 4 } },
        { t: 20, imu: imu(), gnss: { lat: LAT, lon: LON, accuracyM: -1 } },
        { t: 40, imu: imu() },
      ]),
    );
    const r = runEval(samples, BASE);
    // A NaN fix must not become ground truth.
    expect(r.truth.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true);
    expect(r.states.every((s) => Number.isFinite(s.position.lat))).toBe(true);
  });

  it('survives a log whose IMU is corrupt', () => {
    const samples = parseJsonl(
      log([
        { t: 0, imu: { ax: Number.NaN, ay: 0, az: G, gx: 0, gy: 0, gz: 0 }, gnss: { lat: LAT, lon: LON, accuracyM: 4 } },
        { t: 20, imu: { ax: Infinity, ay: 0, az: G, gx: Infinity, gy: 0, gz: 0 } },
      ]),
    );
    const r = runEval(samples, BASE);
    expect(r.states.every((s) => Number.isFinite(s.position.lat))).toBe(true);
  });

  it('never mutates the samples it is given', () => {
    // ★ The ablation parses each log ONCE and reuses it across nine configs.
    // Stripping gnss in place would silently delete it for every run after the
    // first, and every one of those runs would look like a triumph.
    const samples = parseJsonl(log(drive(30)));
    const before = samples.filter((s) => s.gnss).length;
    for (let i = 0; i < 3; i++) {
      runEval(samples, { ...BASE, outageStartMs: 5000, outageDurationMs: 20_000 });
    }
    expect(samples.filter((s) => s.gnss).length).toBe(before);
  });

  it('gives the same answer every time for the same input', () => {
    // If this ever fails, every number in docs/benchmarks.md is luck.
    const samples = parseJsonl(log(drive(40)));
    const a = runEval(samples, { ...BASE, outageStartMs: 10_000, outageDurationMs: 20_000 });
    const b = runEval(samples, { ...BASE, outageStartMs: 10_000, outageDurationMs: 20_000 });
    expect(JSON.stringify(a.metrics)).toBe(JSON.stringify(b.metrics));
  });

  it('scores only the outage, not the whole drive', () => {
    // Outside the outage the estimate is reset onto GNSS at every fix. Including
    // it would average the real error toward zero and make a longer drive look
    // more accurate than a shorter one.
    const samples = parseJsonl(log(drive(60)));
    const short = runEval(samples, { ...BASE, outageStartMs: 20_000, outageDurationMs: 10_000 });
    const long = runEval(samples, { ...BASE, outageStartMs: 20_000, outageDurationMs: 30_000 });
    expect(long.metrics.samples).toBeGreaterThan(short.metrics.samples);
    expect(long.metrics.distanceTravelledM).toBeGreaterThan(short.metrics.distanceTravelledM);
  });

  it('reports a longer outage as worse than a shorter one from the same point', () => {
    // Not a law of nature, but on a straight constant-speed drive it must hold,
    // and if it ever stops holding something is badly wrong.
    const samples = parseJsonl(log(drive(120)));
    const short = runEval(samples, { ...BASE, outageStartMs: 20_000, outageDurationMs: 15_000 });
    const long = runEval(samples, { ...BASE, outageStartMs: 20_000, outageDurationMs: 60_000 });
    expect(long.metrics.finalErrorM).toBeGreaterThan(short.metrics.finalErrorM);
  });
});

describe('computeMetrics — arithmetic edges', () => {
  const truth = Array.from({ length: 11 }, (_, i) => ({
    t: i * 1000,
    lat: LAT,
    lon: LON + (10 * i) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
  }));

  const base = {
    configName: 'c',
    log: 'l',
    outageStartMs: 0,
    outageDurationMs: 10_000,
    truth,
    recoveredAtMs: null,
    zuptTriggers: 0,
    zaruTriggers: 0,
    roadSnapAppliedFraction: 0,
    positionResets: 0,
  };

  it('never reports RMSE below MAE', () => {
    // A mathematical identity: if it is ever violated, one of them is wrong.
    const states = [0, 2000, 5000, 9000].map((t) => ({
      t,
      mode: 'DEAD_RECKONING' as const,
      position: { lat: LAT + t / 1e7, lon: LON },
      velocityMps: 10,
      headingDeg: 90,
      covariance: { alongM: 1, crossM: 1, headingDeg: 1 },
      confidence: 0.5,
      distanceTravelledM: 0,
      timeSinceGnssMs: t,
      estimatedDriftM: 0,
      biases: { accel: [0, 0, 0] as [number, number, number], gyro: [0, 0, 0] as [number, number, number] },
    }));
    const m = computeMetrics({ ...base, outageStates: states });
    expect(m.rmseM).toBeGreaterThanOrEqual(m.maeM - 1e-9);
    expect(m.maxErrorM).toBeGreaterThanOrEqual(m.cep95M - 1e-9);
    expect(m.cep95M).toBeGreaterThanOrEqual(0);
  });

  it('reports a single-sample outage without dividing by zero', () => {
    const m = computeMetrics({
      ...base,
      outageStates: [
        {
          t: 0,
          mode: 'DEAD_RECKONING',
          position: { lat: LAT, lon: LON },
          velocityMps: 0,
          headingDeg: 0,
          covariance: { alongM: 0, crossM: 0, headingDeg: 0 },
          confidence: 0,
          distanceTravelledM: 0,
          timeSinceGnssMs: 0,
          estimatedDriftM: 0,
          biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
        },
      ],
    });
    expect(m.meanUpdateHz).toBe(0);
    expect(Number.isFinite(m.rmseM)).toBe(true);
  });
});

describe('a corrupt sample must not poison the row', () => {
  const truth = Array.from({ length: 11 }, (_, i) => ({
    t: i * 1000,
    lat: LAT,
    lon: LON + (10 * i) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
  }));

  function st(t: number, lat: number) {
    return {
      t,
      mode: 'DEAD_RECKONING' as const,
      position: { lat, lon: LON },
      velocityMps: 10,
      headingDeg: 90,
      covariance: { alongM: 1, crossM: 1, headingDeg: 1 },
      confidence: 0.5,
      distanceTravelledM: 0,
      timeSinceGnssMs: t,
      estimatedDriftM: 0,
      biases: { accel: [0, 0, 0] as [number, number, number], gyro: [0, 0, 0] as [number, number, number] },
    };
  }

  const base = {
    configName: 'c',
    log: 'l',
    outageStartMs: 0,
    outageDurationMs: 10_000,
    truth,
    recoveredAtMs: null,
    zuptTriggers: 0,
    zaruTriggers: 0,
    roadSnapAppliedFraction: 0,
    positionResets: 0,
  };

  it('drops a non-finite sample and reports the drop', () => {
    // ★ REGRESSION ★ One NaN position used to turn RMSE, MAE and max into NaN
    // while CEP95 still read a plausible 90 m, because sorting pushes NaN to
    // the end and the percentile index lands on a real value. A partially
    // corrupt row is worse than an obviously corrupt one: n/a gets
    // investigated, a plausible number gets published.
    const m = computeMetrics({
      ...base,
      outageStates: [st(0, LAT), st(5000, Number.NaN), st(9000, LAT)],
    });
    expect(m.discardedSamples).toBe(1);
    expect(m.samples).toBe(2);
    expect(Number.isFinite(m.rmseM)).toBe(true);
    expect(Number.isFinite(m.maeM)).toBe(true);
    expect(Number.isFinite(m.maxErrorM)).toBe(true);
    expect(Number.isFinite(m.cep95M)).toBe(true);
  });

  it('matches the clean result when the bad sample is simply absent', () => {
    const clean = computeMetrics({ ...base, outageStates: [st(0, LAT), st(9000, LAT)] });
    const withNaN = computeMetrics({
      ...base,
      outageStates: [st(0, LAT), st(5000, Number.NaN), st(9000, LAT)],
    });
    expect(withNaN.rmseM).toBeCloseTo(clean.rmseM, 9);
    expect(withNaN.maxErrorM).toBeCloseTo(clean.maxErrorM, 9);
  });

  it('reports zero discards for a healthy run', () => {
    expect(computeMetrics({ ...base, outageStates: [st(0, LAT)] }).discardedSamples).toBe(0);
  });
});

describe('paths — argument and file handling', () => {
  it('parses flags with and without values', () => {
    const a = parseArgs(['node', 'x', '--log', 'a.jsonl', '--json', '--config', 'full']);
    expect(a.log).toBe('a.jsonl');
    expect(a.config).toBe('full');
    expect(a.json).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    const a = parseArgs(['node', 'x', '--list', '--config', 'full']);
    expect(a.list).toBe(true);
    expect(a.config).toBe('full');
  });

  it('ignores positional arguments', () => {
    expect(parseArgs(['node', 'x', 'stray', '--json'])).toEqual({ json: true });
  });

  it('handles negative numeric values', () => {
    expect(parseArgs(['node', 'x', '--outage-start', '-500'])['outage-start']).toBe('-500');
  });

  it('loads every shipped config, and each declares its engine flags', () => {
    for (const name of ['naive', 'filtered', 'zaru', 'zupt', 'nhc', 'speedclamp', 'highpass', 'full', 'full_forwardbias']) {
      const c = loadConfig(name);
      expect(c.name).toBe(name);
      expect(typeof c.engine).toBe('object');
      expect(c.description, `${name} needs a description for the table`).toBeTruthy();
    }
  });

  it('fails loudly on an unknown config rather than silently defaulting', () => {
    // Falling back to defaults would let a typo in a config name produce a
    // benchmark row labelled with one thing and measuring another.
    expect(() => loadConfig('does-not-exist')).toThrow(/no config named/);
  });

  it('fails loudly on an unknown log', () => {
    expect(() => readLog('nope.jsonl')).toThrow(/no log named/);
  });
});
