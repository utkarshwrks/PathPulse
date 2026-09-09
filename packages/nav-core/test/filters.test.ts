import { describe, expect, it } from 'vitest';
import { LowPassFilter, MedianFilter, StationarityDetector } from '../src/index.js';

describe('MedianFilter', () => {
  it('rejects an isolated spike entirely', () => {
    // A pothole shock must not survive into the integrator. A mean would
    // smear it across the window; the median discards it.
    const f = new MedianFilter(5);
    for (const v of [1, 1, 1, 1]) f.push(v);
    expect(f.push(50)).toBe(1);
  });

  it('still tracks a genuine level change', () => {
    const f = new MedianFilter(5);
    for (const v of [1, 1, 1, 1, 1]) f.push(v);
    for (const v of [9, 9, 9]) f.push(v);
    expect(f.current()).toBe(9);
  });

  it('ignores non-finite input instead of poisoning the window', () => {
    const f = new MedianFilter(3);
    f.push(2);
    f.push(2);
    expect(f.push(NaN)).toBe(2);
  });
});

describe('LowPassFilter', () => {
  it('passes a slow signal nearly unchanged', () => {
    const f = new LowPassFilter(5, 50);
    let out = 0;
    for (let i = 0; i < 200; i++) out = f.push(Math.sin((2 * Math.PI * 0.5 * i) / 50));
    expect(Math.abs(out)).toBeLessThan(1.2);
    const g = new LowPassFilter(5, 50);
    let dc = 0;
    for (let i = 0; i < 200; i++) dc = g.push(3);
    expect(dc).toBeCloseTo(3, 2);
  });

  it('attenuates 20 Hz engine vibration hard', () => {
    // This is the whole reason the filter exists.
    const f = new LowPassFilter(5, 50);
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      const out = f.push(Math.sin((2 * Math.PI * 20 * i) / 50));
      if (i > 200) peak = Math.max(peak, Math.abs(out));
    }
    expect(peak).toBeLessThan(0.3);
  });

  it('does not inject a startup transient', () => {
    // Starting from zero would ramp toward a constant input and look like a
    // real acceleration for the first second.
    const f = new LowPassFilter(5, 50);
    expect(f.push(9.81)).toBeCloseTo(9.81, 1);
  });
});

describe('StationarityDetector', () => {
  it('refuses to answer before the window is full', () => {
    // Declaring "stationary" from three samples would zero a real velocity.
    const d = new StationarityDetector({ windowSize: 50 });
    for (let i = 0; i < 10; i++) d.push(0, 0, 9.81, 0, 0, 0);
    expect(d.evaluate().isStationary).toBe(false);
  });

  it('detects a parked vehicle, but only after sustained confirmation', () => {
    const d = new StationarityDetector({ windowSize: 50 });
    const still = () =>
      d.push(0.01 * Math.random(), 0.01 * Math.random(), 9.81, 0.001, 0.001, 0.001);

    // 50 to fill the window, then 25 more to satisfy the entry hold. A real
    // stop lasts seconds, so 1.5 s of confirmation costs nothing — and it is
    // what stops the overlapping tails of the moving/stopped variance
    // distributions from producing a ZUPT while the vehicle is still rolling.
    let r = d.evaluate();
    for (let i = 0; i < 60; i++) r = still();
    expect(r.isStationary).toBe(false);

    for (let i = 0; i < 40; i++) r = still();
    expect(r.isStationary).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('leaves the stationary state on a single moving sample', () => {
    const d = new StationarityDetector({ windowSize: 50 });
    let r = d.evaluate();
    for (let i = 0; i < 100; i++) {
      r = d.push(0.01 * Math.random(), 0.01 * Math.random(), 9.81, 0.001, 0.001, 0.001);
    }
    expect(r.isStationary).toBe(true);
    // Pulling away must be believed immediately — holding "stopped" for even a
    // second while accelerating would suppress a real velocity.
    r = d.push(3, 2, 11, 0.3, 0.1, 0.4);
    expect(r.isStationary).toBe(false);
  });

  it('does not call a moving vehicle stationary', () => {
    const d = new StationarityDetector({ windowSize: 50 });
    let r = d.evaluate();
    for (let i = 0; i < 60; i++) {
      r = d.push(Math.sin(i) * 2, Math.cos(i) * 2, 9.81 + Math.sin(i), 0.05, 0.02, 0.3);
    }
    expect(r.isStationary).toBe(false);
  });

  it('is not fooled by constant-speed cruising', () => {
    // Accelerometer magnitude is ~9.81 whether parked or cruising, which is
    // why the detector keys on variance rather than magnitude. But a cruising
    // vehicle still vibrates, so variance separates them.
    const d = new StationarityDetector({ windowSize: 50 });
    let r = d.evaluate();
    for (let i = 0; i < 60; i++) {
      r = d.push(0.4 * Math.sin(i * 3), 0.3 * Math.cos(i * 2), 9.81 + 0.5 * Math.sin(i * 7), 0.01, 0.01, 0.05);
    }
    expect(r.isStationary).toBe(false);
  });
});

/**
 * ★ THE SECOND HALF OF THE FIELD REPORT ★
 *
 * "if i stop during dead reckoning then also it appear to be moving".
 *
 * The chain is only ever arrested by ZUPT, ZUPT is only ever armed by this
 * detector, and this detector's gate was measured on a car with its engine
 * off. A running two-wheeler idling at a light sits above it, so on a scooter
 * `isStationary` never went true and the speed model went on asserting a speed
 * at a machine standing still.
 */
describe('StationarityDetector learns this vehicle', () => {
  /** A window's worth of samples with a given accelerometer variance. */
  function feed(d: StationarityDetector, amplitude: number, gyro: number, n: number) {
    let last = d.evaluate();
    for (let i = 0; i < n; i++) {
      // Along gravity, so the magnitude — which is what the detector reads —
      // actually carries the variance.
      const v = amplitude * (i % 2 === 0 ? 1 : -1);
      last = d.push(0, 0, 9.81 + v, gyro, 0, 0);
    }
    return last;
  }

  /** An idle loud enough to breach the car-derived gate, quiet next to cruise. */
  const IDLE_AMPLITUDE = 0.18; // variance ~0.032, against a 0.015 gate
  const CRUISE_AMPLITUDE = 1.2;

  it('★ a two-wheeler idling reads as MOVING against the shipped gate', () => {
    const d = new StationarityDetector({ adaptive: false });
    expect(feed(d, IDLE_AMPLITUDE, 0.001, 200).isStationary).toBe(false);
  });

  it('★ and reads as stopped once GNSS has shown it what a stop looks like', () => {
    const d = new StationarityDetector();
    // Two minutes of ordinary riding: the receiver labels the stops and the
    // cruises, and the gap between them is the gate.
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 0.032, 0.0012);
      d.observeLabelled(true, 1.1, 0.06);
    }
    expect(d.thresholds.learned).toBe(true);
    expect(d.thresholds.accelVariance).toBeGreaterThan(0.032);
    expect(feed(d, IDLE_AMPLITUDE, 0.001, 200).isStationary).toBe(true);
  });

  it('still refuses to call a cruising vehicle stopped', () => {
    const d = new StationarityDetector();
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 0.032, 0.0012);
      d.observeLabelled(true, 1.1, 0.06);
    }
    expect(feed(d, CRUISE_AMPLITUDE, 0.05, 200).isStationary).toBe(false);
  });

  it('★ declines when the two distributions do not separate', () => {
    // ★ THE SAFETY ARGUMENT, AS A TEST ★ A vehicle whose idle is as loud as
    // its cruise offers no gap to move into, and guessing one buys a missed
    // stop with a false one. See `learnSeparationFactor`.
    const d = new StationarityDetector();
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 0.5, 0.05);
      d.observeLabelled(true, 0.55, 0.055);
    }
    expect(d.thresholds.learned).toBe(false);
    expect(d.thresholds.accelVariance).toBe(0.015);
  });

  it('never moves the gate on stopped samples alone', () => {
    const d = new StationarityDetector();
    for (let i = 0; i < 300; i++) d.observeLabelled(false, 0.032, 0.0012);
    expect(d.thresholds.learned).toBe(false);
  });

  it('is bounded however wide the measured gap is', () => {
    // learnMaxRatio is a guard against a degenerate learned distribution, not
    // the operative limit — see its note. What actually bounds the gate is
    // learnSeparationFactor against the moving quantile.
    const d = new StationarityDetector();
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 5, 2);
      d.observeLabelled(true, 500, 200);
    }
    expect(d.thresholds.accelVariance).toBeLessThanOrEqual(0.015 * 64);
    expect(d.thresholds.gyroMean).toBeLessThanOrEqual(0.02 * 64);
  });

  it('only ever raises the gate, never tightens it', () => {
    const d = new StationarityDetector();
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 0.0001, 0.0001);
      d.observeLabelled(true, 1.1, 0.06);
    }
    expect(d.thresholds.accelVariance).toBe(0.015);
    expect(d.thresholds.gyroMean).toBe(0.02);
  });

  it('is off entirely when switched off', () => {
    const d = new StationarityDetector({ adaptive: false });
    for (let i = 0; i < 150; i++) {
      d.observeLabelled(false, 0.032, 0.0012);
      d.observeLabelled(true, 1.1, 0.06);
    }
    expect(d.thresholds.learned).toBe(false);
    expect(d.thresholds.accelVariance).toBe(0.015);
  });
});

/**
 * ★ THE FIRST TIER F RIDE, AS THE DISTRIBUTIONS IT ACTUALLY MEASURED ★
 *
 * A two-wheeler in Jabalpur with the engine running at every stop. Variance of
 * accelerometer magnitude over 256-sample windows, labelled by the nearest fix:
 *
 *   stopped   p50 0.302   p75 1.378   p90 4.343
 *   moving    p05 1.002   p10 1.076   p25 1.831
 *
 * Two findings live in those two rows, and the second one killed a hypothesis.
 */
describe('the learned gate, against real two-wheeler distributions', () => {
  /** Draw a sample matching a measured quantile profile, deterministically. */
  function fill(d: StationarityDetector, moving: boolean, quantiles: number[]) {
    for (let i = 0; i < 150; i++) {
      const v = quantiles[i % quantiles.length]!;
      d.observeLabelled(moving, v, moving ? 0.06 : 0.002);
    }
  }
  /**
   * Ten equally-weighted values reproducing each class's measured quantile
   * profile — so the p50 of the synthetic sample really is the p50 that was
   * measured, rather than an artefact of how many values were listed.
   */
  const STOPPED = [0.038, 0.05, 0.08, 0.115, 0.2, 0.302, 0.7, 1.378, 3.0, 4.343];
  const MOVING = [1.002, 1.3, 1.831, 3.0, 5.427, 8.0, 10.434, 13.0, 15.537, 17.96];

  it('★ p90 of stopped sits above p05 of moving, which is why it declined forever', () => {
    // 4.343 against 1.002. A gate built on the stopped p90 is above most of
    // the moving distribution, so the separation guard correctly refused it —
    // every time, on the one vehicle the mechanism was written for.
    const d = new StationarityDetector({ learnStoppedQuantile: 0.9 });
    fill(d, false, STOPPED);
    fill(d, true, MOVING);
    expect(d.thresholds.learned).toBe(false);
  });

  it('★ and p50 sits below it, which is a clean gap', () => {
    const d = new StationarityDetector();
    fill(d, false, STOPPED);
    fill(d, true, MOVING);
    expect(d.thresholds.learned).toBe(true);
    // 0.302 * 1.5 = 0.45, under the 1.002 * 0.7 = 0.70 the moving side allows.
    expect(d.thresholds.accelVariance).toBeGreaterThan(0.3);
    expect(d.thresholds.accelVariance).toBeLessThan(0.7);
  });

  it('★ the gate reaches a value the old cap could not', () => {
    // learnMaxRatio was 8, capping at 0.12 — and this vehicle's stopped median
    // is 0.302, so the cap alone would have blocked it even with the quantile
    // right. A number from nowhere was overruling one measured from the data.
    const d = new StationarityDetector();
    fill(d, false, STOPPED);
    fill(d, true, MOVING);
    expect(d.thresholds.accelVariance).toBeGreaterThan(0.015 * 8);
  });

  it('a stopped two-wheeler now reads as stopped', () => {
    const d = new StationarityDetector();
    fill(d, false, STOPPED);
    fill(d, true, MOVING);
    // The median stopped window: engine running, phone on the bars.
    let last = d.evaluate();
    for (let i = 0; i < 200; i++) {
      const v = 0.55 * (i % 2 === 0 ? 1 : -1); // variance ~0.30
      last = d.push(0, 0, 9.81 + v, 0.001, 0, 0);
    }
    expect(last.isStationary).toBe(true);
  });

  it('and a moving one still does not', () => {
    const d = new StationarityDetector();
    fill(d, false, STOPPED);
    fill(d, true, MOVING);
    let last = d.evaluate();
    for (let i = 0; i < 200; i++) {
      const v = 2.33 * (i % 2 === 0 ? 1 : -1); // variance ~5.4, the moving p50
      last = d.push(0, 0, 9.81 + v, 0.06, 0, 0);
    }
    expect(last.isStationary).toBe(false);
  });

  it('still declines when a vehicle genuinely does not separate', () => {
    const d = new StationarityDetector();
    fill(d, false, [4, 5, 6]);
    fill(d, true, [4.5, 5.5, 6.5]);
    expect(d.thresholds.learned).toBe(false);
  });
});
