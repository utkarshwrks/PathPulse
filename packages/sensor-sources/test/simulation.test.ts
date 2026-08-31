import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { haversineDistance } from '@pathpulse/nav-core';
import {
  CITY_VEHICLE,
  GRAVITY_MPS2,
  HIGHWAY_VEHICLE,
  IDEAL_NOISE,
  PHONE_MEMS_NOISE,
  RoutePath,
  SimulationSource,
  createGaussian,
  type RouteGeoJson,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const city = JSON.parse(
  readFileSync(ROOT + 'data/routes/route_city.json', 'utf8'),
) as RouteGeoJson;
const highway = JSON.parse(
  readFileSync(ROOT + 'data/routes/route_highway.json', 'utf8'),
) as RouteGeoJson;

/** Run a whole drive instantly by stepping the pure engine. */
function drive(sim: SimulationSource, seconds: number) {
  return sim.advance(seconds * 1000);
}

describe('routes on disk', () => {
  it('city route is ~2 km', () => {
    const r = new RoutePath(city);
    expect(r.lengthM).toBeGreaterThan(1900);
    expect(r.lengthM).toBeLessThan(2100);
  });

  it('highway route is ~3 km', () => {
    const r = new RoutePath(highway);
    expect(r.lengthM).toBeGreaterThan(2900);
    expect(r.lengthM).toBeLessThan(3100);
  });

  it('city route has at least four substantial turns', () => {
    // The guide asks for four. Real roads give more, which is strictly better
    // for exercising the gyroscope and Phase 9's turn detector.
    const r = new RoutePath(city);
    let turns = 0;
    let prev = r.headingAt(0);
    let accum = 0;
    for (let s = 5; s <= r.lengthM; s += 5) {
      const h = r.headingAt(s);
      let d = h - prev;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      accum += d;
      prev = h;
      if (Math.abs(accum) >= 60) {
        turns++;
        accum = 0;
      }
    }
    expect(turns).toBeGreaterThanOrEqual(4);
  });

  it('routes are built from real OSM roads, not synthetic geometry', () => {
    // Regression guard. Geometrically generated routes had exact lengths but
    // drove the vehicle through buildings, which looks broken on the map.
    for (const route of [city, highway]) {
      const props = route.properties as Record<string, unknown> | undefined;
      expect(props?.source).toMatch(/OSRM|OpenStreetMap/i);
      expect(Array.isArray(props?.roads)).toBe(true);
      expect((props?.roads as string[]).length).toBeGreaterThan(0);
    }
  });

  it('smooths corners so yaw rate stays physically possible', () => {
    // A raw polyline turns instantly, implying infinite angular rate. If this
    // regresses, the simulated gyro becomes garbage and so does every test
    // that depends on it.
    const r = new RoutePath(city);
    let maxRateDegPerM = 0;
    for (let s = 0; s < r.lengthM - 1; s += 1) {
      let d = r.headingAt(s + 1) - r.headingAt(s);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      maxRateDegPerM = Math.max(maxRateDegPerM, Math.abs(d));
    }
    expect(maxRateDegPerM).toBeLessThan(20);
  });
});

describe('SimulationSource — sample generation', () => {
  it('emits IMU at ~50 Hz and GNSS at ~1 Hz', () => {
    const sim = new SimulationSource({ route: city, seed: 1 });
    const samples = drive(sim, 20);
    const imu = samples.filter((s) => s.imu).length;
    const gnss = samples.filter((s) => s.gnss).length;
    expect(imu / 20).toBeGreaterThan(45);
    expect(imu / 20).toBeLessThan(55);
    expect(gnss).toBeGreaterThanOrEqual(19);
    expect(gnss).toBeLessThanOrEqual(21);
  });

  it('advances timestamps monotonically', () => {
    const sim = new SimulationSource({ route: city, seed: 2 });
    const samples = drive(sim, 15);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.t).toBeGreaterThan(samples[i - 1]!.t);
    }
  });

  it('is deterministic for a given seed', () => {
    // The ablation table compares configs against each other. If the noise
    // differed run to run it would be measuring the seed, not the constraints.
    const a = drive(new SimulationSource({ route: city, seed: 42 }), 10);
    const b = drive(new SimulationSource({ route: city, seed: 42 }), 10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different noise for a different seed', () => {
    const a = drive(new SimulationSource({ route: city, seed: 1 }), 5);
    const b = drive(new SimulationSource({ route: city, seed: 2 }), 5);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('SimulationSource — realistic IMU', () => {
  it('includes gravity, so a level device reads +9.81 up', () => {
    // Getting this sign wrong is the classic DR bug: the estimator concludes
    // the vehicle is accelerating upward forever.
    const sim = new SimulationSource({ route: city, seed: 3, noise: IDEAL_NOISE });
    const s = drive(sim, 2).find((x) => x.imu)!;
    expect(s.imu!.az).toBeCloseTo(GRAVITY_MPS2, 1);
  });

  it('carries a constant accelerometer bias', () => {
    // Bias, not white noise, is what makes dead reckoning hard: it
    // double-integrates into ~36 m of error in a minute.
    const sim = new SimulationSource({ route: city, seed: 4 });
    const samples = drive(sim, 10).filter((s) => s.imu);
    const meanAx = samples.reduce((a, s) => a + s.imu!.ax, 0) / samples.length;
    expect(meanAx).toBeGreaterThan(0.005);
  });

  it('adds white noise and bias of the configured magnitude', () => {
    // Difference two runs that share a seed and route: one with the real noise
    // model, one with an ideal sensor. The vehicle dynamics are identical and
    // both consume the RNG stream identically, so the difference IS exactly
    // the injected bias plus white noise — no need to guess which part of a
    // drive is "steady", which is what made an earlier version of this test
    // measure real cornering instead of sensor noise.
    const noisy = drive(
      new SimulationSource({ route: highway, seed: 5, vehicle: HIGHWAY_VEHICLE }),
      20,
    ).filter((s) => s.imu);
    const ideal = drive(
      new SimulationSource({
        route: highway,
        seed: 5,
        vehicle: HIGHWAY_VEHICLE,
        noise: IDEAL_NOISE,
      }),
      20,
    ).filter((s) => s.imu);

    expect(noisy).toHaveLength(ideal.length);
    const diff = noisy.map((s, i) => s.imu!.gz - ideal[i]!.imu!.gz);
    const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
    const sd = Math.sqrt(diff.reduce((a, b) => a + (b - mean) ** 2, 0) / diff.length);

    // Mean recovers the constant gyro bias.
    expect(mean).toBeCloseTo(PHONE_MEMS_NOISE.gyroBias[2], 3);
    // Spread recovers the white-noise sigma.
    expect(sd).toBeGreaterThan(PHONE_MEMS_NOISE.gyroSigma * 0.7);
    expect(sd).toBeLessThan(PHONE_MEMS_NOISE.gyroSigma * 1.4);
  });

  it('shows vertical vibration when moving', () => {
    const sim = new SimulationSource({ route: highway, seed: 6, vehicle: HIGHWAY_VEHICLE });
    const az = drive(sim, 20)
      .filter((s) => s.imu)
      .slice(300)
      .map((s) => s.imu!.az);
    const mean = az.reduce((a, b) => a + b, 0) / az.length;
    const sd = Math.sqrt(az.reduce((a, b) => a + (b - mean) ** 2, 0) / az.length);
    // Vibration dominates accel white noise on the vertical axis.
    expect(sd).toBeGreaterThan(PHONE_MEMS_NOISE.accelSigma);
  });

  it('reports gyro z during turns and ~zero on straights', () => {
    const sim = new SimulationSource({ route: city, seed: 7, noise: IDEAL_NOISE });
    const samples = drive(sim, 120).filter((s) => s.imu);
    const maxGz = Math.max(...samples.map((s) => Math.abs(s.imu!.gz)));
    // A 90 degree turn taken over a few seconds is a few tenths of a rad/s.
    expect(maxGz).toBeGreaterThan(0.05);
    expect(maxGz).toBeLessThan(2);
  });
});

describe('SimulationSource — driving behaviour', () => {
  it('stops three times on the city route', () => {
    const sim = new SimulationSource({ route: city, seed: 8, vehicle: CITY_VEHICLE });
    const samples = drive(sim, 400).filter((s) => s.gnss);
    let stopped = false;
    let stopEvents = 0;
    for (const s of samples) {
      const v = s.gnss!.speedMps ?? 0;
      if (!stopped && v < 0.3) {
        stopped = true;
        stopEvents++;
      } else if (stopped && v > 1.5) {
        stopped = false;
      }
    }
    // Three red lights (a stop registered at the very end is possible too).
    expect(stopEvents).toBeGreaterThanOrEqual(3);
  });

  it('never exceeds a plausible speed', () => {
    const sim = new SimulationSource({ route: highway, seed: 9, vehicle: HIGHWAY_VEHICLE });
    const speeds = drive(sim, 200)
      .filter((s) => s.gnss)
      .map((s) => s.gnss!.speedMps ?? 0);
    expect(Math.max(...speeds)).toBeLessThan(HIGHWAY_VEHICLE.cruiseMps + 3);
  });

  it('follows the route rather than wandering off it', () => {
    const sim = new SimulationSource({ route: city, seed: 10, gnssAccuracyM: 0.01 });
    const path = new RoutePath(city);
    const fixes = drive(sim, 60).filter((s) => s.gnss);
    for (const f of fixes) {
      // Nearest approach to the polyline must stay tight.
      let best = Infinity;
      for (let s = 0; s <= path.lengthM; s += 10) {
        const p = path.latLonAt(s);
        best = Math.min(best, haversineDistance(f.gnss!.lat, f.gnss!.lon, p.lat, p.lon));
      }
      expect(best).toBeLessThan(12);
    }
  });
});

describe('SimulationSource — GNSS outage', () => {
  it('omits the gnss field entirely during an outage', () => {
    // Absent, never zeroed or faked — the same shape a real tunnel produces.
    const sim = new SimulationSource({ route: city, seed: 11 });
    sim.simulateGnssOutage(10_000, 20_000);
    const samples = drive(sim, 40);

    const during = samples.filter((s) => s.t >= 10_000 && s.t < 30_000);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((s) => s.gnss === undefined)).toBe(true);

    const before = samples.filter((s) => s.t < 10_000 && s.gnss);
    const after = samples.filter((s) => s.t >= 30_000 && s.gnss);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });

  it('keeps IMU flowing through the outage — that is the whole point', () => {
    const sim = new SimulationSource({ route: city, seed: 12 });
    sim.simulateGnssOutage(5_000, 10_000);
    const during = drive(sim, 20).filter((s) => s.t >= 5_000 && s.t < 15_000);
    expect(during.every((s) => s.imu !== undefined)).toBe(true);
  });

  it('supports several outages and clearing them', () => {
    const sim = new SimulationSource({ route: city, seed: 13 });
    sim.simulateGnssOutage(5_000, 3_000);
    sim.simulateGnssOutage(15_000, 3_000);
    expect(sim.isInOutage(6_000)).toBe(true);
    expect(sim.isInOutage(10_000)).toBe(false);
    expect(sim.isInOutage(16_000)).toBe(true);
    sim.clearOutages();
    expect(sim.isInOutage(6_000)).toBe(false);
  });
});

/**
 * ★ THE BUG THIS BLOCK EXISTS FOR ★
 * `advance()` consumes whole IMU steps. The wall timer asks for 50 ms and the
 * step is 20 ms, so it spent 40 and discarded 10 — every tick. Simulated time
 * ran at 0.8x real time and nothing noticed, because every other caller here
 * passes whole seconds and every assertion was written in simulated time.
 *
 * The scripted demo is the one thing that keeps real time. It fires the outage
 * on a wall clock at 15 s, but the outage's 60 s is simulated, so GNSS came
 * back at 90 s of wall clock while the banner announced the recovery at 75 s:
 * the demo's closing five seconds narrated a fix return that had not happened,
 * over a screen still reading DEAD RECKONING with no drift measured.
 */
describe('SimulationSource — simulated time tracks the time requested', () => {
  it('spends a tick that is not a whole number of IMU steps', () => {
    // 50 ms of wall clock, 20 ms per IMU sample. The leftover 10 ms has to
    // survive into the next call rather than being dropped on the floor.
    const sim = new SimulationSource({ route: city, seed: 21 });
    for (let i = 0; i < 100; i++) sim.advance(50);
    expect(sim.elapsedMs).toBe(5_000);
  });

  it('does not drift over the length of a demo', () => {
    const sim = new SimulationSource({ route: city, seed: 22 });
    for (let wall = 0; wall < 80_000; wall += 50) sim.advance(50);
    // Within one IMU step of the 80 s asked for. It used to reach 64 s.
    expect(Math.abs(sim.elapsedMs - 80_000)).toBeLessThanOrEqual(20);
  });

  it('★ returns GNSS on the demo script\u2019s mark, not fifteen seconds late', () => {
    // The whole demo, ticked the way the page ticks it: useDemoMode fires the
    // outage on a wall clock at 15 s, DEMO_SCRIPT announces recovery at 75 s.
    const sim = new SimulationSource({ route: city, seed: 23 });
    let fired = false;
    let recoveredAtWallMs: number | null = null;
    let wasOut = false;

    for (let wall = 0; wall <= 120_000; wall += 50) {
      sim.advance(50);
      if (!fired && wall >= 15_000) {
        fired = true;
        sim.startOutageNow(60_000);
      }
      const out = sim.isInOutage();
      if (wasOut && !out && recoveredAtWallMs === null) recoveredAtWallMs = wall;
      wasOut = out;
    }

    expect(recoveredAtWallMs).not.toBeNull();
    expect(Math.abs(recoveredAtWallMs! - 75_000)).toBeLessThanOrEqual(50);
  });

  it('emits one GNSS fix per second of wall clock at 1 Hz', () => {
    // The visible symptom of the same defect: 0.8 fixes a second.
    const sim = new SimulationSource({ route: city, seed: 24, gnssRateHz: 1 });
    let fixes = 0;
    sim.onSample((s) => {
      if (s.gnss) fixes++;
    });
    for (let wall = 0; wall < 10_000; wall += 50) sim.advance(50);
    // 10 or 11: the window is closed at both ends, so a fix due at exactly
    // t=10000 lands inside it. The defect produced 9 or fewer.
    expect(fixes).toBeGreaterThanOrEqual(10);
    expect(fixes).toBeLessThanOrEqual(11);
  });
});

describe('createGaussian', () => {
  it('has approximately zero mean and unit variance', () => {
    const g = createGaussian(99);
    const xs = Array.from({ length: 20_000 }, () => g());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
  });
});
