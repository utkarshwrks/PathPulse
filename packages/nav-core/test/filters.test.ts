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

  it('detects a parked vehicle', () => {
    const d = new StationarityDetector({ windowSize: 50 });
    let r = d.evaluate();
    for (let i = 0; i < 60; i++) {
      r = d.push(0.01 * Math.random(), 0.01 * Math.random(), 9.81, 0.001, 0.001, 0.001);
    }
    expect(r.isStationary).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
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
