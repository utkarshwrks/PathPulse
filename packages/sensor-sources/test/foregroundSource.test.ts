import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ForegroundSource } from '../src/native/ForegroundSource.js';
import type { SensorSample } from '@pathpulse/nav-core';

/**
 * Phase 15 — the native foreground sensor loop, web side.
 *
 * ★ WHAT IS ACTUALLY BEING TESTED ★
 *
 * Not the Java. The service, the wake lock and the screen-off sample rate need
 * a phone, and this file does not pretend otherwise — `pnpm android:gradle`
 * proves it compiles and only a real drive proves it holds 10 Hz with the
 * screen off.
 *
 * What IS testable, and is the part most likely to be quietly wrong, is the
 * bridge. Values cross from Java as JSON: a `Float` that missed its overload
 * arrives as the STRING "9.81", a missing gyro arrives as absent rather than
 * zero, and a fix repeated on consecutive samples would tell the engine the
 * receiver is fixing at 100 Hz. None of those throw. All of them produce
 * confident, plausible, wrong navigation.
 */

type Listener = (payload: {
  samples: Array<Record<string, unknown>>;
  status: Record<string, number | boolean>;
}) => void;

let listener: Listener | null = null;
const started = vi.fn();
const stopped = vi.fn();
let capabilities = { available: true, hasGyroscope: true, hasBarometer: false };

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'PathPulseSensors',
    Plugins: {
      PathPulseSensors: { capabilities: async () => capabilities },
    },
  },
  registerPlugin: () => ({
    start: async () => {
      started();
      return { started: true };
    },
    stop: async () => {
      stopped();
    },
    capabilities: async () => capabilities,
    addListener: async (_event: string, handler: Listener) => {
      listener = handler;
      return { remove: async () => { listener = null; } };
    },
  }),
}));

beforeEach(() => {
  listener = null;
  started.mockClear();
  stopped.mockClear();
  capabilities = { available: true, hasGyroscope: true, hasBarometer: false };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connected(): Promise<{ source: ForegroundSource; samples: SensorSample[] }> {
  const source = new ForegroundSource();
  const samples: SensorSample[] = [];
  source.onSample((s) => samples.push(s));
  await source.start();
  return { source, samples };
}

const send = (payload: Array<Record<string, unknown>>, status: Record<string, number | boolean> = {}) =>
  listener?.({ samples: payload, status });

describe('availability', () => {
  it('is available when the plugin is in the build', async () => {
    expect(await ForegroundSource.isAvailable()).toBe(true);
  });

  it('is not available when the plugin says it is not', async () => {
    capabilities = { available: false, hasGyroscope: false, hasBarometer: false };
    expect(await ForegroundSource.isAvailable()).toBe(false);
  });
});

describe('the bridge', () => {
  it('turns a native batch into samples', async () => {
    const { samples } = await connected();
    send([
      { t: 1000, imu: { ax: 0.1, ay: 0.2, az: 9.8, gx: 0.01, gy: 0, gz: -0.02, hasGyro: true } },
      { t: 1010, imu: { ax: 0.1, ay: 0.2, az: 9.8, gx: 0.01, gy: 0, gz: -0.02, hasGyro: true } },
    ]);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.t).toBe(1000);
    expect(samples[0]!.imu!.az).toBeCloseTo(9.8, 6);
  });

  it('★ parses a number that arrived as a string', async () => {
    // JSObject has no Float overload; a value that misses its cast crosses as
    // "9.81". Read naively that is NaN, and a NaN entering the estimator is a
    // position that flies off the map ten seconds later with nothing to point
    // at. The plugin casts explicitly AND this parses defensively, because the
    // cost of the second belt is four lines.
    const { samples } = await connected();
    send([{ t: '2000', imu: { ax: '0.5', ay: '0', az: '9.81', gx: '0', gy: '0', gz: '0' } }]);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.t).toBe(2000);
    expect(samples[0]!.imu!.az).toBeCloseTo(9.81, 6);
  });

  it('drops a sample with no usable timestamp rather than inventing one', async () => {
    const { samples } = await connected();
    send([{ imu: { ax: 1, ay: 1, az: 9.8 } }, { t: 'nonsense', imu: { ax: 1, ay: 1, az: 9.8 } }]);
    expect(samples).toHaveLength(0);
  });

  it('never emits a non-finite value into the engine', async () => {
    const { samples } = await connected();
    send([{ t: 3000, imu: { ax: Number.NaN, ay: 0, az: 9.8 } }]);
    // The accelerometer triple is incomplete, so there is no IMU to report.
    // Emitting it with a zero would be inventing a measurement.
    expect(samples.every((s) => !s.imu || Number.isFinite(s.imu.ax))).toBe(true);
  });

  it('carries a GNSS fix through with its accuracy and speed', async () => {
    const { samples } = await connected();
    send([
      {
        t: 4000,
        imu: { ax: 0, ay: 0, az: 9.8 },
        gnss: { lat: 23.16, lon: 79.93, accuracyM: 4.5, speedMps: 12.3, headingDeg: 87, satCount: 14 },
      },
    ]);
    expect(samples[0]!.gnss!.lat).toBeCloseTo(23.16, 6);
    expect(samples[0]!.gnss!.accuracyM).toBeCloseTo(4.5, 6);
    expect(samples[0]!.gnss!.speedMps).toBeCloseTo(12.3, 6);
  });

  it('★ marks a real constellation breakdown as MEASURED', async () => {
    // The whole point of the native GnssStatus path. Every other source has to
    // label its breakdown simulated, because the WebView reports a count and
    // nothing more — and inventing a NavIC number for an ISRO-sponsored
    // problem statement is the worst thing this app could be caught doing.
    const { samples } = await connected();
    send([
      {
        t: 5000,
        imu: { ax: 0, ay: 0, az: 9.8 },
        gnss: {
          lat: 23.16,
          lon: 79.93,
          accuracyM: 4,
          satCount: 11,
          constellations: { GPS: 7, NAVIC: 3, GALILEO: 1 },
        },
      },
    ]);
    expect(samples[0]!.gnss!.constellations).toEqual({ GPS: 7, NAVIC: 3, GALILEO: 1 });
    expect(samples[0]!.gnss!.constellationsSimulated).toBe(false);
  });

  it('does not attach a breakdown when the native side sent none', async () => {
    const { samples } = await connected();
    send([{ t: 6000, imu: { ax: 0, ay: 0, az: 9.8 }, gnss: { lat: 1, lon: 2, accuracyM: 5 } }]);
    expect(samples[0]!.gnss!.constellations).toBeUndefined();
    // Absent, not "false" — the UI distinguishes "no breakdown available" from
    // "a breakdown of nothing", and so must this.
    expect(samples[0]!.gnss!.constellationsSimulated).toBeUndefined();
  });

  it('reports the rate the NATIVE side measured, not the one this side can see', async () => {
    // ★ THE NUMBER THE PHASE EXISTS TO MOVE ★ If the WebView is asleep, so is
    // any code here that would count. Only the service can measure whether the
    // loop survived the screen going off.
    const { source } = await connected();
    send([{ t: 7000, imu: { ax: 0, ay: 0, az: 9.8 } }], { imuRateHz: 98.4, droppedSamples: 0 });
    expect(source.status.nativeImuHz).toBeCloseTo(98.4, 3);
  });

  it('surfaces dropped samples rather than losing them silently', async () => {
    const { source } = await connected();
    send([{ t: 8000, imu: { ax: 0, ay: 0, az: 9.8 } }], { imuRateHz: 40, droppedSamples: 512 });
    expect(source.status.droppedSamples).toBe(512);
  });

  it('reports a missing gyroscope as missing, never as zero', async () => {
    // A phone with no gyroscope draws a straight line through every corner.
    // `hasGyro: false` is a fact the UI must be able to state; a silent zero
    // is the failure this whole capability flag was added to end.
    capabilities = { available: true, hasGyroscope: false, hasBarometer: false };
    const { source } = await connected();
    expect(source.capabilities.hasGyro).toBe(false);
  });

  it('starts the service once and stops it cleanly', async () => {
    const { source } = await connected();
    expect(started).toHaveBeenCalledTimes(1);
    await source.start();
    expect(started).toHaveBeenCalledTimes(1);
    source.stop();
    expect(source.status.running).toBe(false);
  });
});

describe('the signals only this source can supply', () => {
  it('★ carries C/N0 mean AND spread, which nothing else can', () => {
    // Phase 13's Model 4 reads both, and neither alone separates a reflected
    // signal from a spoofed one: multipath lowers the mean and WIDENS the
    // spread, a spoofer raises the mean and COLLAPSES it. The WebView reports
    // a satellite count and nothing else, so without GnssStatus these two
    // features are permanently absent and the model runs on defaults.
    return connected().then(({ samples }) => {
      send([
        {
          t: 9000,
          imu: { ax: 0, ay: 0, az: 9.8 },
          gnss: { lat: 23.16, lon: 79.93, accuracyM: 4, satCount: 11, meanCn0: 41.2, cn0Spread: 2.6 },
        },
      ]);
      expect(samples[0]!.gnss!.meanCn0).toBeCloseTo(41.2, 5);
      expect(samples[0]!.gnss!.cn0Spread).toBeCloseTo(2.6, 5);
    });
  });

  it('treats a zero C/N0 as "not reported", not as a dead sky', () => {
    // 0 dB-Hz is not a plausible reading. Passed through it would look like
    // the worst possible signal on every phone that omits the field.
    return connected().then(({ samples }) => {
      send([
        {
          t: 9100,
          imu: { ax: 0, ay: 0, az: 9.8 },
          gnss: { lat: 23.16, lon: 79.93, accuracyM: 4, meanCn0: 0 },
        },
      ]);
      expect(samples[0]!.gnss!.meanCn0).toBeUndefined();
    });
  });

  it('carries a barometric pressure through', () => {
    return connected().then(({ samples }) => {
      send([{ t: 9200, imu: { ax: 0, ay: 0, az: 9.8 }, baro: { pressureHpa: 1008.4 } }]);
      expect(samples[0]!.baro!.pressureHpa).toBeCloseTo(1008.4, 5);
    });
  });

  it('rejects a pressure in pascals', () => {
    // 101325 Pa is 1013.25 hPa. Read as hPa it is a hundred kilometres of
    // altitude, and a unit mix-up crossing a bridge is exactly the kind of
    // thing that gets fixed on one side and forgotten on the other.
    return connected().then(({ samples }) => {
      send([{ t: 9300, imu: { ax: 0, ay: 0, az: 9.8 }, baro: { pressureHpa: 101_325 } }]);
      expect(samples[0]!.baro).toBeUndefined();
    });
  });
});
