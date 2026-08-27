import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorSample } from '@pathpulse/nav-core';

/**
 * NativeSource against mocked Capacitor plugins.
 *
 * This is the code that actually runs inside the APK, and it was the least
 * covered file in the project at 8%. It carries the same one-sample-stream
 * rule as WebSource, and a permission-denial path that decides whether the app
 * shows a clear message or simply never produces a fix.
 *
 * The Capacitor modules are imported lazily inside `start()` — deliberately, so
 * they never get pulled into the web bundle — which is precisely what makes
 * them mockable here without a device.
 */

type AccelHandler = (e: unknown) => void;
type WatchCallback = (p: unknown, err?: unknown) => void;

const state = {
  permission: 'granted' as 'granted' | 'denied',
  isNative: true,
  accelHandlers: [] as AccelHandler[],
  watchCallbacks: [] as WatchCallback[],
  removedListeners: 0,
  clearedWatches: [] as string[],
  motionThrows: false,
  geolocationThrows: false,
};

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => state.isNative },
}));

vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    requestPermissions: async () => {
      if (state.geolocationThrows) throw new Error('no permission API');
      return { location: state.permission };
    },
    watchPosition: async (_opts: unknown, cb: WatchCallback) => {
      state.watchCallbacks.push(cb);
      return 'watch-1';
    },
    clearWatch: async ({ id }: { id: string }) => {
      state.clearedWatches.push(id);
    },
  },
}));

vi.mock('@capacitor/motion', () => ({
  Motion: {
    addListener: async (_type: string, cb: AccelHandler) => {
      if (state.motionThrows) throw new Error('no motion');
      state.accelHandlers.push(cb);
      return {
        remove: async () => {
          state.removedListeners++;
        },
      };
    },
  },
}));

function accel(ax: number, ay: number, az: number, beta = 0, gamma = 0, alpha = 0) {
  for (const h of [...state.accelHandlers]) {
    h({
      accelerationIncludingGravity: { x: ax, y: ay, z: az },
      rotationRate: { beta, gamma, alpha },
    });
  }
}

function fix(lat: number, lon: number, extra: Record<string, number | null> = {}) {
  for (const cb of [...state.watchCallbacks]) {
    cb({
      coords: { latitude: lat, longitude: lon, accuracy: 6, speed: null, heading: null, ...extra },
    });
  }
}

async function started() {
  const { NativeSource } = await import('../src/index.js');
  const src = new NativeSource();
  const samples: SensorSample[] = [];
  src.onSample((s) => samples.push(s));
  await src.start();
  return { src, samples };
}

describe('NativeSource — the code that runs in the APK', () => {
  beforeEach(() => {
    state.permission = 'granted';
    state.isNative = true;
    state.accelHandlers = [];
    state.watchCallbacks = [];
    state.removedListeners = 0;
    state.clearedWatches = [];
    state.motionThrows = false;
    state.geolocationThrows = false;
  });

  afterEach(() => vi.clearAllMocks());

  it('detects the native platform', async () => {
    const { NativeSource } = await import('../src/index.js');
    expect(await NativeSource.isAvailable()).toBe(true);
    state.isNative = false;
    expect(await NativeSource.isAvailable()).toBe(false);
  });

  it('emits an IMU sample per motion event, in rad/s', async () => {
    const { samples } = await started();
    accel(0.3, -0.2, 9.9, 180, 90, 45);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.imu!.ay).toBeCloseTo(-0.2, 6);
    expect(samples[0]!.imu!.gx).toBeCloseTo(Math.PI, 5);
    expect(samples[0]!.imu!.gz).toBeCloseTo(Math.PI / 4, 5);
  });

  it('does NOT emit a separate sample for a fix', async () => {
    // The same one-sample-stream rule as WebSource: a fix rides along on the
    // next IMU sample instead of re-sending an IMU reading the engine has
    // already consumed through every filter window.
    const { samples } = await started();
    accel(0, 0, 9.8);
    fix(28.6315, 77.2167);
    expect(samples).toHaveLength(1);

    accel(0, 0, 9.8);
    expect(samples).toHaveLength(2);
    expect(samples[1]!.gnss).toBeDefined();
  });

  it('attaches each fix exactly once', async () => {
    const { samples } = await started();
    fix(28.6315, 77.2167);
    accel(0, 0, 9.8);
    accel(0, 0, 9.8);
    expect(samples.filter((s) => s.gnss)).toHaveLength(1);
  });

  it('drops a null speed rather than reporting a stationary vehicle', async () => {
    // ★ This device really does return null. ★ Reporting it as 0 m/s would
    // tell the engine the vehicle is stopped, which is a different claim from
    // "the device does not measure this".
    const { samples } = await started();
    fix(28.6315, 77.2167, { speed: null, heading: null });
    accel(0, 0, 9.8);
    expect(samples[0]!.gnss!.speedMps).toBeUndefined();
    expect(samples[0]!.gnss!.headingDeg).toBeUndefined();
  });

  it('passes a real speed and heading through', async () => {
    const { samples } = await started();
    fix(28.6315, 77.2167, { speed: 13.5, heading: 200 });
    accel(0, 0, 9.8);
    expect(samples[0]!.gnss!.speedMps).toBeCloseTo(13.5, 6);
    expect(samples[0]!.gnss!.headingDeg).toBeCloseTo(200, 6);
  });

  it('measures its own rates', async () => {
    const { src } = await started();
    for (let i = 0; i < 5; i++) accel(0, 0, 9.8);
    fix(28.6315, 77.2167);
    expect(src.measuredRates.imuHz).toBeGreaterThan(0);
    expect(src.measuredRates.gnssHz).toBeGreaterThan(0);
  });

  it('releases the motion listener and the position watch on stop', async () => {
    const { src } = await started();
    src.stop();
    expect(state.removedListeners).toBe(1);
    // ★ REGRESSION ★ clearWatch goes through a lazy dynamic import, and the
    // watch id used to be nulled synchronously before that import resolved —
    // so clearWatch received null and the GPS watch was never released. It
    // kept running after stop(), draining battery, invisibly.
    await vi.waitFor(() => expect(state.clearedWatches).toEqual(['watch-1']));
  });

  it('is idempotent on repeated start', async () => {
    const { src, samples } = await started();
    await src.start();
    accel(0, 0, 9.8);
    // A second listener would duplicate every sample into the engine.
    expect(samples).toHaveLength(1);
  });
});

describe('NativeSource — permissions and missing hardware', () => {
  beforeEach(() => {
    state.permission = 'granted';
    state.isNative = true;
    state.accelHandlers = [];
    state.watchCallbacks = [];
    state.removedListeners = 0;
    state.clearedWatches = [];
    state.motionThrows = false;
    state.geolocationThrows = false;
  });

  it('reports a denial as a clear capability, not as silence', async () => {
    // A denied permission must surface as hasGnss=false so the UI can say so.
    // Silently never producing a fix looks identical to a broken engine.
    state.permission = 'denied';
    const { src } = await started();
    expect(src.capabilities.hasGnss).toBe(false);
    expect(state.watchCallbacks).toHaveLength(0);
  });

  it('survives the permission API throwing', async () => {
    state.geolocationThrows = true;
    const { src } = await started();
    expect(src.capabilities.hasGnss).toBe(false);
  });

  it('degrades when the device has no motion sensors', async () => {
    state.motionThrows = true;
    const { src } = await started();
    expect(src.capabilities.hasImu).toBe(false);
  });

  it('emits fixes alone when there is no IMU to ride along with', async () => {
    // Otherwise the fix queues forever waiting for a motion event that never
    // arrives, and the app looks like it has no GNSS at all.
    state.motionThrows = true;
    const { samples } = await started();
    fix(28.6315, 77.2167);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.gnss).toBeDefined();
    expect(samples[0]!.imu).toBeUndefined();
  });

  it('ignores a watch callback that reports an error', async () => {
    const { samples } = await started();
    for (const cb of state.watchCallbacks) cb(null, new Error('position unavailable'));
    accel(0, 0, 9.8);
    expect(samples[0]!.gnss).toBeUndefined();
  });

  it('stop is safe before start', async () => {
    const { NativeSource } = await import('../src/index.js');
    expect(() => new NativeSource().stop()).not.toThrow();
  });
});
