import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPOOFING_CONFIG,
  NavigationEngine,
  SpoofingDetector,
  type SensorSample,
  type SpoofingInput,
} from '../src/index.js';

/**
 * GNSS anomaly detection.
 *
 * Most of this file is about what must NOT raise an alarm. A detector that
 * fires on a tunnel exit, a traffic light or a poor fix is not a feature, it
 * is a badge that says "GNSS ANOMALY DETECTED" for the whole demo — and a
 * judge who watches it fire on something they can explain stops believing the
 * rest of the screen too.
 *
 * The three checks it does make are each the version that survives contact
 * with this app's normal behaviour: implied speed rather than raw distance,
 * sustained disagreement rather than one sample, and satellites-lost-while-
 * signal-healthy rather than satellites-lost.
 */

const BASE = { lat: 23.1815, lon: 79.9864 };

/** Metres east of BASE, as a lon offset. */
function east(metres: number): number {
  return BASE.lon + metres / (111_320 * Math.cos((BASE.lat * Math.PI) / 180));
}

function input(patch: Partial<SpoofingInput> & { t: number }): SpoofingInput {
  return {
    drSpeedMps: 0,
    stationary: true,
    ...patch,
  };
}

describe('SpoofingDetector — implausible jumps', () => {
  it('flags a fix that teleports faster than any vehicle moves', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    // 500 m in 1 s = 500 m/s.
    const found = d.update(
      input({ t: 1000, gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5 } }),
    );
    expect(found?.kind).toBe('IMPLAUSIBLE_JUMP');
    expect(found?.message).toMatch(/fix moved \d+m in 1\.0s — \d+ m\/s/);
  });

  it('★ does not fire when returning from a long outage', () => {
    // THE FALSE POSITIVE THAT MATTERS. This app spends much of its time in
    // outages, and every recovery moves the fix hundreds of metres from the
    // last one. Measured as distance, "jumped more than 50 m" fires every
    // single time the app works correctly.
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    // 60 s later, 840 m further on: a vehicle at 14 m/s, entirely ordinary.
    const found = d.update(
      input({ t: 60_000, gnss: { lat: BASE.lat, lon: east(840), accuracyM: 5 } }),
    );
    expect(found).toBeNull();
  });

  it('★ does not fire on two poor fixes disagreeing with each other', () => {
    // Two 60 m fixes 60 m apart imply a high speed over a short gap and mean
    // nothing at all — that is what a 60 m accuracy is telling you.
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 60 } }));
    const found = d.update(
      input({ t: 600, gnss: { lat: BASE.lat, lon: east(60), accuracyM: 60 } }),
    );
    expect(found).toBeNull();
  });

  it('★ ignores fixes too close together in time to mean anything', () => {
    // 5 m of ordinary scatter across 100 ms implies 50 m/s. That is the
    // arithmetic measuring noise, not the vehicle.
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 1 } }));
    const found = d.update(
      input({ t: 100, gnss: { lat: BASE.lat, lon: east(8), accuracyM: 1 } }),
    );
    expect(found).toBeNull();
  });

  it('does not fire on a fast but possible motorway speed', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 4 } }));
    // 35 m/s is 126 km/h.
    const found = d.update(
      input({ t: 2000, gnss: { lat: BASE.lat, lon: east(70), accuracyM: 4 } }),
    );
    expect(found).toBeNull();
  });

  it('needs a previous fix before it can judge a jump', () => {
    const d = new SpoofingDetector();
    expect(d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }))).toBeNull();
  });
});

describe('SpoofingDetector — static hold', () => {
  /** Drive with GNSS pinned to one spot while the IMU reports real motion. */
  function heldStill(d: SpoofingDetector, untilMs: number, stepMs = 1000) {
    let found = null;
    for (let t = 0; t <= untilMs; t += stepMs) {
      const e = d.update(
        input({
          t,
          gnss: { ...BASE, accuracyM: 5, speedMps: 0 },
          drSpeedMps: 14,
          stationary: false,
        }),
      );
      if (e) found = e;
    }
    return found;
  }

  it('flags a receiver insisting it is stopped while the IMU disagrees', () => {
    const d = new SpoofingDetector();
    const found = heldStill(d, 12_000);
    expect(found?.kind).toBe('STATIC_HOLD');
    expect(found?.message).toMatch(/inertial says 14\.0 m\/s/);
  });

  it('★ needs sustained disagreement, not one sample', () => {
    // Doppler speed lags, and on a 0.2 Hz receiver a single stale fix is
    // routine. One disagreeing sample must never raise an alarm.
    const d = new SpoofingDetector();
    const found = heldStill(d, DEFAULT_SPOOFING_CONFIG.staticSustainMs - 2000);
    expect(found).toBeNull();
  });

  it('★ does not fire at a traffic light', () => {
    // Genuinely stopped: GNSS says zero and so does the IMU. The stationarity
    // detector is the same one driving ZUPT, so this can never contradict the
    // constraint that is simultaneously zeroing our speed.
    const d = new SpoofingDetector();
    let found = null;
    for (let t = 0; t <= 30_000; t += 1000) {
      const e = d.update(
        input({
          t,
          gnss: { ...BASE, accuracyM: 5, speedMps: 0 },
          drSpeedMps: 0,
          stationary: true,
        }),
      );
      if (e) found = e;
    }
    expect(found).toBeNull();
  });

  it('does not fire when the IMU is barely moving', () => {
    const d = new SpoofingDetector();
    let found = null;
    for (let t = 0; t <= 30_000; t += 1000) {
      const e = d.update(
        input({
          t,
          gnss: { ...BASE, accuracyM: 5, speedMps: 0 },
          drSpeedMps: 1.2,
          stationary: false,
        }),
      );
      if (e) found = e;
    }
    expect(found).toBeNull();
  });

  it('resets the clock as soon as GNSS starts moving again', () => {
    const d = new SpoofingDetector();
    heldStill(d, 4000);
    // A moving fix clears the accumulated disagreement.
    d.update(
      input({
        t: 5000,
        gnss: { ...BASE, accuracyM: 5, speedMps: 13 },
        drSpeedMps: 14,
        stationary: false,
      }),
    );
    const found = d.update(
      input({
        t: 8000,
        gnss: { ...BASE, accuracyM: 5, speedMps: 0 },
        drSpeedMps: 14,
        stationary: false,
      }),
    );
    expect(found).toBeNull();
  });

  it('★ derives GNSS speed from consecutive fixes when Doppler is absent', () => {
    // Android frequently omits speed. A spoofer holding position produces
    // identical fixes, which derive to zero just the same.
    const d = new SpoofingDetector();
    let found = null;
    for (let t = 0; t <= 12_000; t += 1000) {
      const e = d.update(
        input({ t, gnss: { ...BASE, accuracyM: 5 }, drSpeedMps: 14, stationary: false }),
      );
      if (e) found = e;
    }
    expect(found?.kind).toBe('STATIC_HOLD');
  });
});

describe('SpoofingDetector — constellation', () => {
  function fix(t: number, satCount: number, meanCn0: number): SpoofingInput {
    return input({ t, gnss: { ...BASE, accuracyM: 5, satCount, meanCn0 } });
  }

  it('flags satellites collapsing while the signal stays strong', () => {
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) d.update(fix(t, 12, 42));
    const found = d.update(fix(5000, 3, 44));
    expect(found?.kind).toBe('CONSTELLATION');
    expect(found?.message).toMatch(/C\/N0 still 44/);
  });

  it('★ does not fire entering a tunnel', () => {
    // A tunnel takes carrier-to-noise down with the satellite count. That is
    // the ordinary case this app is built around, and it must stay silent.
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) d.update(fix(t, 12, 42));
    const found = d.update(fix(5000, 2, 18));
    expect(found).toBeNull();
  });

  it('does not fire on a mild dip', () => {
    const d = new SpoofingDetector();
    for (let t = 0; t < 5000; t += 1000) d.update(fix(t, 12, 42));
    expect(d.update(fix(5000, 9, 42))).toBeNull();
  });

  it('stays silent when the platform does not report the fields', () => {
    // The Capacitor/WebView stack exposes neither. Inventing a verdict from
    // absent data is precisely the kind of thing this project refuses to do.
    const d = new SpoofingDetector();
    for (let t = 0; t < 10_000; t += 1000) {
      expect(d.update(input({ t, gnss: { ...BASE, accuracyM: 5 } }))).toBeNull();
    }
  });

  it('needs a baseline before it can call anything a collapse', () => {
    const d = new SpoofingDetector();
    expect(d.update(fix(0, 3, 44))).toBeNull();
  });
});

describe('SpoofingDetector — display behaviour', () => {
  it('holds the anomaly on screen, then clears it', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    d.update(input({ t: 1000, gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5 } }));
    expect(d.current).not.toBeNull();

    d.update(input({ t: 1000 + DEFAULT_SPOOFING_CONFIG.holdMs - 100 }));
    expect(d.current).not.toBeNull();

    d.update(input({ t: 1000 + DEFAULT_SPOOFING_CONFIG.holdMs + 1 }));
    expect(d.current).toBeNull();
  });

  it('counts each kind separately, for the debug panel', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    d.update(input({ t: 1000, gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5 } }));
    expect(d.totals.IMPLAUSIBLE_JUMP).toBe(1);
    expect(d.totals.STATIC_HOLD).toBe(0);
  });

  it('survives junk timing and missing fixes without throwing', () => {
    const d = new SpoofingDetector();
    expect(d.update(input({ t: NaN }))).toBeNull();
    expect(d.update(input({ t: 0 }))).toBeNull();
    expect(
      d.update(input({ t: 1000, gnss: { lat: NaN, lon: NaN, accuracyM: NaN } })),
    ).toBeNull();
  });

  it('clears everything on reset', () => {
    const d = new SpoofingDetector();
    d.update(input({ t: 0, gnss: { ...BASE, accuracyM: 5 } }));
    d.update(input({ t: 1000, gnss: { lat: BASE.lat, lon: east(500), accuracyM: 5 } }));
    d.reset();
    expect(d.current).toBeNull();
    expect(d.totals.IMPLAUSIBLE_JUMP).toBe(0);
  });
});

describe('NavigationEngine — the detector stays quiet on an ordinary drive', () => {
  /**
   * ★ THE TEST THAT MATTERS ★
   * Every unit test above can pass while the detector still fires constantly
   * on the demo itself. This runs the same drive the engine tests use — GNSS,
   * a 20 s outage, dead reckoning, recovery — and requires total silence.
   * The outage recovery is exactly the event a naive jump check flags.
   */
  function makeDrive(outageStartS: number, outageEndS: number, durationS: number) {
    const hz = 50;
    const dtMs = 1000 / hz;
    const samples = [];
    let nextGnssMs = 0;
    const speedMps = 14;
    const start = { lat: 28.6315, lon: 77.2167 };

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
        nextGnssMs += 1000;
        const inOutage = tMs >= outageStartS * 1000 && tMs < outageEndS * 1000;
        if (!inOutage) {
          const metresEast = (speedMps * tMs) / 1000;
          s.gnss = {
            lat: start.lat,
            lon: start.lon + metresEast / (111_320 * Math.cos((start.lat * Math.PI) / 180)),
            accuracyM: 4,
            speedMps,
            headingDeg: 90,
            satCount: 9,
            meanCn0: 38,
          };
        }
      }
      samples.push(s);
    }
    return samples;
  }

  it('★ raises no anomaly across a full outage and recovery', () => {
    const engine = new NavigationEngine();
    const states = makeDrive(20, 40, 60).map((s) => engine.update(s));
    const anomalies = [...engine.events.all].filter((e) => e.type === 'GNSS_ANOMALY');
    expect(anomalies).toEqual([]);
    expect(states.some((s) => s.gnssAnomaly !== undefined)).toBe(false);
  });

  it('★ raises no anomaly across a very long outage', () => {
    // 110 s of dead reckoning, then a fix hundreds of metres from the last
    // one. This is the single most anomaly-shaped thing the app does.
    const engine = new NavigationEngine();
    makeDrive(20, 130, 180).forEach((s) => engine.update(s));
    expect([...engine.events.all].filter((e) => e.type === 'GNSS_ANOMALY')).toEqual([]);
  });

  it('surfaces a genuinely teleported fix on the state, for the HUD badge', () => {
    const engine = new NavigationEngine();
    const samples = makeDrive(20, 40, 60);
    // Move one fix 5 km sideways: a real teleport, not a recovery.
    const target = samples.find((s) => s.gnss && s.t > 50_000);
    if (target?.gnss) target.gnss.lat += 0.045;

    let flagged = false;
    for (const s of samples) {
      const st = engine.update(s);
      if (st.gnssAnomaly) flagged = true;
    }
    expect(flagged).toBe(true);
  });
});
