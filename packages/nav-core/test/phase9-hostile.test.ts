import { describe, expect, it } from 'vitest';
import {
  buildConfidenceRing,
  confidenceAreaM2,
  NavigationEngine,
  TurnDetector,
  type SensorSample,
} from '../src/index.js';

/**
 * Phase 9A and 9B, assumed broken.
 *
 * The tests written alongside each feature check that it works. These check
 * what happens when it is handed something nobody intended: a NaN from a
 * config, a position on the antimeridian, a receiver that reports a fix every
 * five seconds instead of every one. That is where the previous deep test
 * passes found their bugs, and none of it shows up in a coverage report —
 * every line below was already at 100%.
 */

const DELHI = { lat: 28.6315, lon: 77.2167 };

describe('9A hostile — buildConfidenceRing', () => {
  it('never emits an undefined vertex, whatever the segment count', () => {
    // A non-finite segment count makes the vertex loop run zero times. Closing
    // the ring then appends ring[0], which does not exist — and a coordinate
    // array containing undefined is not a crash here, it is a crash later,
    // inside the map, with a stack trace pointing nowhere near this file.
    for (const segments of [NaN, Infinity, -Infinity, -10, 0]) {
      const ring = buildConfidenceRing(
        DELHI,
        { alongM: 10, crossM: 5, headingDeg: 0 },
        { segments },
      );
      for (const vertex of ring) {
        expect(Array.isArray(vertex)).toBe(true);
        expect(Number.isFinite(vertex[0])).toBe(true);
        expect(Number.isFinite(vertex[1])).toBe(true);
      }
    }
  });

  it('survives non-finite axis bounds without emitting NaN coordinates', () => {
    const ring = buildConfidenceRing(
      DELHI,
      { alongM: 50, crossM: 20, headingDeg: 45 },
      { minAxisM: NaN, maxAxisM: NaN },
    );
    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('★ does not smear across the whole globe at the antimeridian', () => {
    // Longitude wraps from +180 to -180. A ring straddling it comes back with
    // vertices at both ends, and a GeoJSON polygon joins them the long way —
    // a 360-degree band across the entire map instead of a small ellipse.
    // Fiji and the Chatham Islands are on the wrong side of this line, and so
    // is anyone demoing with a spoofed location.
    const ring = buildConfidenceRing(
      { lat: -18, lon: 179.98 },
      { alongM: 4000, crossM: 4000, headingDeg: 90 },
    );
    const lons = ring.map(([lon]) => lon);
    const span = Math.max(...lons) - Math.min(...lons);
    expect(span).toBeLessThan(10);
  });

  it('stays a bounded shape near the pole', () => {
    const ring = buildConfidenceRing(
      { lat: 89.9, lon: 0 },
      { alongM: 3000, crossM: 3000, headingDeg: 0 },
    );
    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
  });

  it('treats a negative axis as absent rather than mirroring the shape', () => {
    const ring = buildConfidenceRing(DELHI, { alongM: -50, crossM: -20, headingDeg: 0 });
    expect(ring.length).toBeGreaterThan(3);
    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('reports area of zero, never negative, for a degenerate ellipse', () => {
    expect(confidenceAreaM2({ alongM: 0, crossM: 100, headingDeg: 0 })).toBe(0);
    expect(confidenceAreaM2({ alongM: -5, crossM: -5, headingDeg: 0 })).toBe(0);
  });
});

describe('9A hostile — covariance through a low-rate recovery', () => {
  /**
   * The field-tested device delivers a fix every 5 to 20 seconds, not every
   * second. Anything that reads `sample.gnss` per-sample sees `undefined` on
   * the overwhelming majority of samples, and a default standing in for it
   * becomes the value that is used almost all of the time.
   */
  function driveWithSlowFixes(opts: {
    durationS: number;
    outageStartS: number;
    outageEndS: number;
    fixIntervalS: number;
    accuracyM: number;
  }): SensorSample[] {
    const { durationS, outageStartS, outageEndS, fixIntervalS, accuracyM } = opts;
    const hz = 50;
    const dtMs = 1000 / hz;
    const samples: SensorSample[] = [];
    let nextGnssMs = 0;
    const speedMps = 14;

    for (let tMs = 0; tMs <= durationS * 1000; tMs += dtMs) {
      const phase = (tMs / 1000) * 2 * Math.PI * 20;
      const shake = 0.8;
      const s: SensorSample = {
        t: tMs,
        imu: {
          ax: shake * Math.sin(phase),
          ay: shake * Math.sin(phase * 1.31),
          az: 9.80665 + shake * Math.sin(phase * 0.77),
          gx: 0,
          gy: 0,
          gz: 0,
        },
      };
      if (tMs >= nextGnssMs) {
        nextGnssMs += fixIntervalS * 1000;
        const inOutage = tMs >= outageStartS * 1000 && tMs < outageEndS * 1000;
        if (!inOutage) {
          const metresEast = (speedMps * tMs) / 1000;
          s.gnss = {
            lat: DELHI.lat,
            lon:
              DELHI.lon + metresEast / (111_320 * Math.cos((DELHI.lat * Math.PI) / 180)),
            accuracyM,
            speedMps,
            headingDeg: 90,
            satCount: 9,
          };
        }
      }
      samples.push(s);
    }
    return samples;
  }

  const samples = driveWithSlowFixes({
    durationS: 90,
    outageStartS: 20,
    outageEndS: 45,
    fixIntervalS: 5,
    // At or under trustedAccuracyM (20 m), or the engine never leaves
    // INITIALIZING and there is no recovery to inspect at all.
    accuracyM: 18,
  });
  const engine = new NavigationEngine();
  const states = samples.map((s) => engine.update(s));
  const recovering = states.filter((s) => s.mode === 'RECOVERING');

  it('has a recovery to inspect', () => {
    expect(recovering.length).toBeGreaterThan(5);
  });

  it('★ does not pulse the ellipse between fixes on a 0.2 Hz receiver', () => {
    // The shrink target is read from the current sample. On a receiver that
    // reports every five seconds, 249 samples out of 250 carry no fix at all,
    // so a per-sample fallback becomes the target almost always — and the
    // ellipse oscillates between the fallback and the real accuracy every time
    // a fix lands. On screen: a pulsing shape, during the exact moment the
    // demo is meant to look composed.
    let reversals = 0;
    for (let i = 1; i < recovering.length; i++) {
      const step = recovering[i]!.covariance.alongM - recovering[i - 1]!.covariance.alongM;
      if (step > 0.01) reversals++;
    }
    expect(reversals).toBe(0);
  });

  it('★ settles on the accuracy the receiver actually reported', () => {
    // This drive reports 18 m fixes throughout. Settling anywhere near 5 m
    // claims a precision the hardware never offered.
    const settled = states[states.length - 1]!;
    expect(settled.mode).toBe('GNSS');
    expect(settled.covariance.alongM).toBeCloseTo(18, 1);
  });

  it('★ still does not pulse when recovery spans several fixes', () => {
    // The test above only spans a fix or two, because a small drift slews in
    // about two seconds. A long outage produces a large drift, whose slew is
    // rate-limited to many seconds — long enough for several fixes to land
    // inside it, which is where a per-sample fallback shows up plainly.
    const long = driveWithSlowFixes({
      durationS: 180,
      outageStartS: 20,
      outageEndS: 130,
      fixIntervalS: 2,
      accuracyM: 18,
    });
    const e = new NavigationEngine();
    const st = long.map((s) => e.update(s));
    const rec = st.filter((s) => s.mode === 'RECOVERING');
    expect(rec.length).toBeGreaterThan(100);

    let reversals = 0;
    for (let i = 1; i < rec.length; i++) {
      if (rec[i]!.covariance.alongM - rec[i - 1]!.covariance.alongM > 0.01) reversals++;
    }
    expect(reversals).toBe(0);
  });

  it('keeps the ellipse finite and positive at every single sample', () => {
    for (const s of states) {
      expect(Number.isFinite(s.covariance.alongM)).toBe(true);
      expect(Number.isFinite(s.covariance.crossM)).toBe(true);
      expect(s.covariance.alongM).toBeGreaterThanOrEqual(0);
      expect(s.covariance.crossM).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('9B hostile — TurnDetector', () => {
  const DT = 20;

  function feed(
    d: TurnDetector,
    rateDegPerSec: number,
    seconds: number,
    startMs: number,
    headingDeg: number,
    speedMps = 14,
  ) {
    const events = [];
    let t = startMs;
    let heading = headingDeg;
    for (let i = 0; i < seconds * (1000 / DT); i++) {
      t += DT;
      heading += (rateDegPerSec * DT) / 1000;
      const e = d.update(t, (rateDegPerSec * Math.PI) / 180, DT, speedMps, heading);
      if (e) events.push(e);
    }
    return { t, heading, events };
  }

  it('★ always reports headings in [0, 360), whatever it is fed', () => {
    // The engine normalises heading, but this is a public API and the HUD
    // prints these straight out. A "turn from -80° to 10°" is not a compass
    // bearing, it is a bug that reads as one.
    const d = new TurnDetector();
    const a = feed(d, 0, 2, 0, -800);
    const b = feed(d, 22.5, 4, a.t, a.heading);
    const c = feed(d, 0, 2, b.t, b.heading);
    const events = [...b.events, ...c.events];
    expect(events).toHaveLength(1);
    expect(events[0]!.fromHeadingDeg).toBeGreaterThanOrEqual(0);
    expect(events[0]!.fromHeadingDeg).toBeLessThan(360);
    expect(events[0]!.toHeadingDeg).toBeGreaterThanOrEqual(0);
    expect(events[0]!.toHeadingDeg).toBeLessThan(360);
  });

  it('does not accumulate a turn across a clock jump', () => {
    const d = new TurnDetector();
    feed(d, 0, 2, 0, 0);
    // A 30-second gap: the app was backgrounded. Whatever the vehicle did in
    // that time, it is not one continuous turn.
    const e = d.update(60_000, (22.5 * Math.PI) / 180, 30_000, 14, 90);
    expect(e).toBeNull();
    expect(d.isTurning).toBe(false);
  });

  it('does not fire from a stationary phone being rotated for a long time', () => {
    const d = new TurnDetector();
    const a = feed(d, 45, 20, 0, 0, 0);
    expect(a.events).toHaveLength(0);
    expect(d.count).toBe(0);
  });

  it('handles a speed of exactly the gate without throwing', () => {
    const d = new TurnDetector({ minSpeedMps: 1.5 });
    const a = feed(d, 22.5, 4, 0, 0, 1.5);
    const b = feed(d, 0, 2, a.t, a.heading, 1.5);
    expect([...a.events, ...b.events].length).toBeLessThanOrEqual(1);
  });

  it('treats a NaN speed as not moving rather than as moving', () => {
    const d = new TurnDetector();
    const a = feed(d, 45, 5, 0, 0, NaN);
    expect(a.events).toHaveLength(0);
    expect(d.isTurning).toBe(false);
  });

  it('never emits a turn whose duration is negative or zero', () => {
    const d = new TurnDetector();
    const a = feed(d, 0, 2, 0, 0);
    const b = feed(d, 30, 4, a.t, a.heading);
    const c = feed(d, 0, 2, b.t, b.heading);
    for (const e of [...b.events, ...c.events]) {
      expect(e.durationMs).toBeGreaterThan(0);
      expect(e.t).toBeGreaterThan(e.startedAtMs);
    }
  });

  it('reports a deltaDeg consistent with the kind it assigned', () => {
    const d = new TurnDetector();
    const a = feed(d, 0, 2, 0, 0);
    const b = feed(d, -30, 4, a.t, a.heading);
    const c = feed(d, 0, 2, b.t, b.heading);
    const e = [...b.events, ...c.events][0]!;
    expect(e.kind.startsWith('LEFT')).toBe(true);
    expect(e.deltaDeg).toBeLessThan(0);
  });

  it('survives an absurd config without hanging or emitting junk', () => {
    const d = new TurnDetector({ windowMs: 0, triggerDeg: 0, settleMs: 0 });
    const a = feed(d, 10, 3, 0, 0);
    for (const e of a.events) {
      expect(Number.isFinite(e.deltaDeg)).toBe(true);
      expect(Number.isFinite(e.durationMs)).toBe(true);
    }
  });
});
