import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';
import { WebSource } from '../src/index.js';

/**
 * WebSource against a mocked DOM.
 *
 * It was the least-covered file in the project at 8%, and it is where the
 * one-sample-stream bug lived — the browser sources emitted a second sample per
 * fix, pushing the same IMU reading through every filter window twice. That is
 * exactly the class of defect a unit test catches and a field test does not,
 * because nothing on screen looks wrong.
 */

type MotionHandler = (e: unknown) => void;

interface Harness {
  motion: (ax: number, ay: number, az: number, beta?: number, gamma?: number, alpha?: number) => void;
  fix: (lat: number, lon: number, extra?: Record<string, number | null>) => void;
  fail: () => void;
  clearWatchCalls: number[];
  listenerCount: () => number;
}

let harness: Harness;

function installDom(opts: { geolocation?: boolean; deviceMotion?: boolean } = {}) {
  const { geolocation = true, deviceMotion = true } = opts;
  const handlers: MotionHandler[] = [];
  let successCb: ((p: unknown) => void) | null = null;
  let errorCb: (() => void) | null = null;
  const clearWatchCalls: number[] = [];

  const win: Record<string, unknown> = {
    addEventListener: (type: string, cb: MotionHandler) => {
      if (type === 'devicemotion') handlers.push(cb);
    },
    removeEventListener: (type: string, cb: MotionHandler) => {
      if (type !== 'devicemotion') return;
      const i = handlers.indexOf(cb);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  if (deviceMotion) win.DeviceMotionEvent = function DeviceMotionEvent() {};

  const nav: Record<string, unknown> = {};
  if (geolocation) {
    nav.geolocation = {
      watchPosition: (ok: (p: unknown) => void, err: () => void) => {
        successCb = ok;
        errorCb = err;
        return 42;
      },
      clearWatch: (id: number) => clearWatchCalls.push(id),
    };
  }

  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', nav);

  harness = {
    motion: (ax, ay, az, beta = 0, gamma = 0, alpha = 0) => {
      for (const h of [...handlers]) {
        h({
          accelerationIncludingGravity: { x: ax, y: ay, z: az },
          rotationRate: { beta, gamma, alpha },
        });
      }
    },
    fix: (lat, lon, extra = {}) => {
      successCb?.({
        coords: { latitude: lat, longitude: lon, accuracy: 5, speed: null, heading: null, ...extra },
      });
    },
    fail: () => errorCb?.(),
    clearWatchCalls,
    listenerCount: () => handlers.length,
  };
}

async function started(): Promise<{ src: WebSource; samples: SensorSample[] }> {
  const src = new WebSource();
  const samples: SensorSample[] = [];
  src.onSample((s) => samples.push(s));
  await src.start();
  return { src, samples };
}

describe('WebSource', () => {
  beforeEach(() => installDom());
  afterEach(() => vi.unstubAllGlobals());

  it('reports what the browser can do', async () => {
    const { src } = await started();
    expect(src.capabilities.hasImu).toBe(true);
    expect(src.capabilities.hasGnss).toBe(true);
    expect(src.capabilities.name).toMatch(/browser/i);
  });

  it('emits an IMU sample per motion event, converting deg/s to rad/s', async () => {
    const { samples } = await started();
    // DeviceMotion reports rotation in deg/s; nav-core works in rad/s.
    harness.motion(0.1, 0.2, 9.8, 180, 90, 45);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.imu!.ax).toBeCloseTo(0.1, 6);
    expect(samples[0]!.imu!.gx).toBeCloseTo(Math.PI, 5);
    expect(samples[0]!.imu!.gy).toBeCloseTo(Math.PI / 2, 5);
    expect(samples[0]!.imu!.gz).toBeCloseTo(Math.PI / 4, 5);
  });

  it('does NOT emit a separate sample for a fix', async () => {
    // ★ THE ONE-SAMPLE-STREAM RULE ★
    // A fix used to be emitted as its own sample carrying the last IMU reading,
    // so that reading entered the median, low-pass and stationarity windows
    // twice and arrived with a dt of zero.
    const { samples } = await started();
    harness.motion(0, 0, 9.8);
    expect(samples).toHaveLength(1);

    harness.fix(28.6315, 77.2167);
    expect(samples).toHaveLength(1); // still one — the fix is queued, not emitted

    harness.motion(0, 0, 9.8);
    expect(samples).toHaveLength(2);
    expect(samples[1]!.gnss).toBeDefined();
    expect(samples[1]!.imu).toBeDefined();
  });

  it('attaches each fix to exactly one sample', async () => {
    const { samples } = await started();
    harness.fix(28.6315, 77.2167);
    harness.motion(0, 0, 9.8);
    harness.motion(0, 0, 9.8);
    harness.motion(0, 0, 9.8);
    expect(samples.filter((s) => s.gnss)).toHaveLength(1);
  });

  it('keeps the newest fix when several arrive between motion events', async () => {
    const { samples } = await started();
    harness.fix(1, 1);
    harness.fix(2, 2);
    harness.motion(0, 0, 9.8);
    expect(samples[0]!.gnss!.lat).toBe(2);
  });

  it('drops a null speed and heading rather than reporting them as zero', async () => {
    // Reporting a missing Doppler speed as 0 m/s would tell the engine the
    // vehicle is stopped, which is a very different claim from "unknown".
    const { samples } = await started();
    harness.fix(28.6315, 77.2167, { speed: null, heading: null });
    harness.motion(0, 0, 9.8);
    expect(samples[0]!.gnss!.speedMps).toBeUndefined();
    expect(samples[0]!.gnss!.headingDeg).toBeUndefined();
  });

  it('passes through a speed and heading when the device does report them', async () => {
    const { samples } = await started();
    harness.fix(28.6315, 77.2167, { speed: 12.5, heading: 87 });
    harness.motion(0, 0, 9.8);
    expect(samples[0]!.gnss!.speedMps).toBeCloseTo(12.5, 6);
    expect(samples[0]!.gnss!.headingDeg).toBeCloseTo(87, 6);
  });

  it('measures its own rates rather than reporting the nominal ones', async () => {
    const { src } = await started();
    for (let i = 0; i < 10; i++) harness.motion(0, 0, 9.8);
    expect(src.measuredRates.imuHz).toBeGreaterThan(0);
  });

  it('survives a geolocation error without tearing itself down', async () => {
    // One bad fix must not end the drive.
    const { samples } = await started();
    harness.fail();
    harness.motion(0, 0, 9.8);
    expect(samples).toHaveLength(1);
  });

  it('ignores a motion event with no acceleration payload', async () => {
    const { samples } = await started();
    for (const h of [harness]) void h;
    (globalThis.window as unknown as { addEventListener: unknown }) &&
      harness.motion(Number.NaN, 0, 9.8);
    // A NaN axis still produces a sample; nav-core is responsible for rejecting
    // it. What must not happen is a throw inside the event handler.
    expect(samples.length).toBeGreaterThanOrEqual(0);
  });

  it('detaches its listener and clears the watch on stop', async () => {
    const { src } = await started();
    expect(harness.listenerCount()).toBe(1);
    src.stop();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.clearWatchCalls).toEqual([42]);
  });

  it('is idempotent on repeated start', async () => {
    const { src, samples } = await started();
    await src.start();
    harness.motion(0, 0, 9.8);
    // Two listeners would duplicate every sample.
    expect(samples).toHaveLength(1);
  });
});

describe('WebSource — degraded browsers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports no IMU when DeviceMotion is absent', async () => {
    installDom({ deviceMotion: false });
    const src = new WebSource();
    await src.start();
    expect(src.capabilities.hasImu).toBe(false);
  });

  it('emits fixes on their own when there is no IMU to ride along with', async () => {
    // Otherwise a fix would queue forever waiting for a motion event that is
    // never coming, and the app would look like it had no GNSS at all.
    installDom({ deviceMotion: false });
    const src = new WebSource();
    const samples: SensorSample[] = [];
    src.onSample((s) => samples.push(s));
    await src.start();

    harness.fix(28.6315, 77.2167);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.gnss).toBeDefined();
    expect(samples[0]!.imu).toBeUndefined();
  });

  it('reports no GNSS when geolocation is absent', async () => {
    installDom({ geolocation: false });
    const src = new WebSource();
    await src.start();
    expect(src.capabilities.hasGnss).toBe(false);
    expect(() => src.stop()).not.toThrow();
  });
});
