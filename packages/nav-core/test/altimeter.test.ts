/**
 * Barometric altitude.
 *
 * ★ WHAT IS BEING ASSERTED, AND WHAT DELIBERATELY IS NOT ★
 *
 * Not absolute altitude. A phone barometer cannot measure it: sea-level
 * pressure moves tens of hectopascals with the weather, which is hundreds of
 * metres of apparent height, and the sensor has no way to know today's value.
 * Every test below is about CHANGE, because change is the only thing this
 * sensor is honestly good at — and it happens to be exactly what both
 * consumers want.
 */
import { describe, expect, it } from 'vitest';
import {
  BarometricAltimeter,
  DEFAULT_ALTIMETER_CONFIG,
} from '../src/alignment/altimeter.js';

/** 8.434 m per hPa. A 6 m flyover is about 0.71 hPa. */
const SEA_LEVEL = 1013.25;

function settle(a: BarometricAltimeter, pressure = SEA_LEVEL, from = 0): number {
  let t = from;
  for (let i = 0; i < DEFAULT_ALTIMETER_CONFIG.warmupSamples + 2; i++) {
    a.push(pressure, t);
    t += 200;
  }
  return t;
}

describe('warm-up', () => {
  it('refuses to answer until the sensor has settled', () => {
    // The first readings of a barometer that has just powered on are routinely
    // wrong by several hPa. Answering from them would put fifty metres of
    // invented climb into the filter's vertical channel at start-up.
    const a = new BarometricAltimeter();
    expect(a.push(SEA_LEVEL, 0).isReady).toBe(false);
    expect(a.isReady).toBe(false);
    settle(a);
    expect(a.isReady).toBe(true);
  });
});

describe('relative altitude', () => {
  it('reads zero at the reference', () => {
    const a = new BarometricAltimeter();
    settle(a);
    expect(a.push(SEA_LEVEL, 5000).relativeM).toBeCloseTo(0, 3);
  });

  it('goes UP when pressure goes DOWN', () => {
    // The sign that is wrong half the time when written from memory.
    const a = new BarometricAltimeter();
    const t = settle(a);
    const climbed = a.push(SEA_LEVEL - 1, t + 100);
    expect(climbed.relativeM).toBeGreaterThan(0);
    expect(climbed.relativeM).toBeCloseTo(8.434, 1);
  });

  it('goes down when pressure rises', () => {
    const a = new BarometricAltimeter();
    const t = settle(a);
    // Not exactly -16.87: the reference has already drifted a little toward
    // the new pressure by this point, which is the intended behaviour and is
    // why the tolerance is a decimetre rather than a centimetre.
    expect(a.push(SEA_LEVEL + 2, t + 100).relativeM).toBeCloseTo(-16.87, 0);
  });
});

describe('the change term — what detects a flyover', () => {
  it('reports a six-metre climb over a ramp', () => {
    // A flyover is about six metres acquired over a twenty-second ramp. This
    // is the signal Phase 14's HMM uses to tell a flyover from the road
    // beneath it, which are the same point on any map.
    const a = new BarometricAltimeter();
    let t = settle(a);
    let reading = a.push(SEA_LEVEL, t);
    for (let i = 1; i <= 20; i++) {
      t += 1000;
      // 6 m over 20 s, linearly.
      reading = a.push(SEA_LEVEL - (i / 20) * (6 / 8.434), t);
    }
    expect(reading.changeM).toBeGreaterThan(4);
    expect(reading.changeM).toBeLessThan(8);
  });

  it('reports nothing on the flat', () => {
    const a = new BarometricAltimeter();
    let t = settle(a);
    let reading = a.push(SEA_LEVEL, t);
    for (let i = 0; i < 60; i++) {
      t += 500;
      reading = a.push(SEA_LEVEL, t);
    }
    expect(Math.abs(reading.changeM)).toBeLessThan(0.5);
  });
});

describe('reference drift', () => {
  it('★ absorbs the weather without absorbing a climb', () => {
    // The whole trade in one test. The reference must drift, or a two-hour
    // drive banks the day's pressure change as apparent climb. It must not
    // drift fast, or a real climb vanishes into it — the same failure the
    // acceleration high-pass would have with too short a time constant.
    const a = new BarometricAltimeter();
    let t = settle(a);

    // Two hours of weather: 6 hPa, which is 50 m of apparent height.
    for (let i = 0; i < 720; i++) {
      t += 10_000;
      a.push(SEA_LEVEL - (i / 720) * 6, t);
    }
    const afterWeather = a.push(SEA_LEVEL - 6, t).relativeM;
    // Almost all of it has been absorbed. Without drift this would read ~50 m.
    expect(Math.abs(afterWeather)).toBeLessThan(15);

    // And a flyover, right after, is still visible.
    let reading = a.push(SEA_LEVEL - 6, t);
    for (let i = 1; i <= 20; i++) {
      t += 1000;
      reading = a.push(SEA_LEVEL - 6 - (i / 20) * (6 / 8.434), t);
    }
    expect(reading.changeM).toBeGreaterThan(4);
  });
});

describe('hostile input', () => {
  it('rejects pascals offered as hectopascals', () => {
    // 101325 Pa is 1013.25 hPa. Read as hPa it is a hundred kilometres of
    // altitude change, and a unit mix-up crossing a bridge is exactly the kind
    // of thing that gets fixed on one side and forgotten on the other.
    const a = new BarometricAltimeter();
    settle(a);
    const before = a.push(SEA_LEVEL, 5000).relativeM;
    expect(a.push(101_325, 5200).relativeM).toBeCloseTo(before, 6);
  });

  it('rejects a non-finite reading', () => {
    const a = new BarometricAltimeter();
    settle(a);
    expect(a.push(Number.NaN, 6000).relativeM).toBeCloseTo(0, 6);
    expect(a.push(SEA_LEVEL, Number.NaN).isReady).toBe(true);
  });

  it('never emits a non-finite altitude', () => {
    const a = new BarometricAltimeter();
    let t = settle(a);
    for (const p of [SEA_LEVEL, 500, 1100, SEA_LEVEL - 30, SEA_LEVEL + 30]) {
      t += 300;
      const r = a.push(p, t);
      expect(Number.isFinite(r.relativeM)).toBe(true);
      expect(Number.isFinite(r.changeM)).toBe(true);
    }
  });

  it('forgets everything on reset', () => {
    const a = new BarometricAltimeter();
    settle(a);
    a.reset();
    expect(a.isReady).toBe(false);
  });
});
