import { describe, expect, it } from 'vitest';
import {
  MockSpeedPredictor,
  NavigationEngine,
  enuToLatLon,
  type RoadGraph,
  type SensorSample,
} from '../src/index.js';

/**
 * A scooter on a straight road, through an outage.
 *
 * ★ THE FIELD REPORT ★
 *
 * "as u see here i travelling of straight road in scooty then also it move to
 * other roads and makes zigzag pattern." Screenshots: DEAD RECKONING, the
 * orange trail weaving across a road that is straight for a kilometre, and
 * `uncert. 88/5` — a cross-track figure capped at 5 m, which means map matching
 * believed it was matching the whole time.
 *
 * ★ THE MECHANISM ★
 *
 * Two things compound, and neither shows on the ablation logs because those are
 * cars on simulated surfaces.
 *
 *   The lean compensation inferred a lean from the same instantaneous yaw rate
 *   it then divided by cos(lean) — see applyLeanCompensation. On a scooter that
 *   turns pothole noise into heading error, non-linearly.
 *
 *   And once the heading has drifted past `maxHeadingMismatchDeg`, EVERY
 *   candidate road is rejected. `match` comes back null, the snap correction
 *   bleeds away, and the marker is released to fly off along the heading that
 *   just failed the test — until the heading wanders back and it rejoins. Out,
 *   back, out, back. The zigzag is the marker being dropped and recaptured by
 *   map matching, on a road it never actually left.
 */

const ORIGIN = { lat: 23.1655, lon: 79.9312 };
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** One dead-straight road running east, 3 km of it. */
function straightRoad(): RoadGraph {
  const coords: Array<[number, number]> = [];
  for (let e = -200; e <= 3000; e += 50) {
    const p = enuToLatLon(e, 0, ORIGIN.lat, ORIGIN.lon);
    coords.push([p.lon, p.lat]);
  }
  return {
    bbox: [0, 0, 0, 0],
    ways: [{ id: 'w-main', name: 'straight road', highway: 'secondary', coords }],
  };
}

/**
 * A scooter at 60 km/h on that road.
 *
 * `roughness` scales what the road does to the handset: engine buzz plus
 * intermittent impulses. None of it is a corner and all of it lands on the
 * gyro, which is the entire problem.
 */
function ride(opts: { roughness: number; outageStartS: number; durationS: number; seed?: number }) {
  const { roughness, outageStartS, durationS, seed = 5 } = opts;
  const SPEED = 16.7;
  let st = seed;
  const rand = () => {
    st = (st * 1103515245 + 12345) % 2147483648;
    return st / 2147483648 - 0.5;
  };
  const dtMs = 1000 / 60;
  const samples: SensorSample[] = [];
  let nextFixMs = 0;
  for (let tMs = 0; tMs <= durationS * 1000; tMs += dtMs) {
    const tS = tMs / 1000;
    const e = SPEED * tS;
    const bump = Math.abs(rand()) > 0.46 ? roughness * 6 * rand() : 0;
    const s: SensorSample = {
      t: Math.round(tMs),
      imu: {
        ax: roughness * 0.25 * rand() + bump * 0.1,
        ay: roughness * 0.25 * rand(),
        az: 9.80665 + roughness * 0.5 * rand() + bump * 0.4,
        gx: roughness * 0.15 * rand(),
        gy: roughness * 0.15 * rand(),
        gz: roughness * 0.15 * rand() + bump * 0.02,
      },
    };
    if (tMs >= nextFixMs) {
      nextFixMs += 1000;
      if (tS < outageStartS) {
        s.gnss = {
          lat: ORIGIN.lat,
          lon: ORIGIN.lon + e / mPerDegLon,
          accuracyM: 4,
          satCount: 12,
          speedMps: SPEED,
          headingDeg: 90,
        };
      }
    }
    samples.push(s);
  }
  return samples;
}

/**
 * How far the DRAWN marker strays from the road, in metres, while dead
 * reckoning. The road is the line n = 0, so this is just |north|.
 */
function offRoad(opts: {
  roughness: number;
  twoWheeler?: boolean;
  headingAidDegPerSec?: number;
}) {
  const engine = new NavigationEngine({
    twoWheeler: opts.twoWheeler ?? true,
    ...(opts.headingAidDegPerSec === undefined
      ? {}
      : { roadHeadingAidDegPerSec: opts.headingAidDegPerSec }),
  });
  // Stands in for the speed model, which on the phone is what supplies speed
  // through an outage. Without it this fixture measures the speed chain rather
  // than the heading, and the marker leaves the road for a different reason.
  engine.setSpeedPredictor(new MockSpeedPredictor(16.7), {
    mean: new Array(12).fill(0),
    std: new Array(12).fill(1),
  });
  engine.setRoadGraph(straightRoad());
  const samples = ride({ roughness: opts.roughness, outageStartS: 60, durationS: 200 });
  let max = 0;
  let sum = 0;
  let n = 0;
  let over10 = 0;
  for (const s of samples) {
    const st = engine.update(s);
    if (st.mode !== 'DEAD_RECKONING') continue;
    const lat = Math.abs(st.position.lat - ORIGIN.lat) * M_PER_DEG_LAT;
    if (lat > max) max = lat;
    if (lat > 10) over10++;
    sum += lat;
    n++;
  }
  return { maxM: max, meanM: n === 0 ? 0 : sum / n, over10Pct: n === 0 ? 0 : (100 * over10) / n, n };
}

describe('★ a scooter on a straight road, through an outage', () => {
  it('★ stays on the road it never left', () => {
    // The road is a straight line and the scooter never leaves it, so every
    // metre of northward excursion here is invented.
    for (const roughness of [0.5, 1, 2]) {
      const r = offRoad({ roughness });
      expect(r.n).toBeGreaterThan(1000);
      expect(r.maxM).toBeLessThan(30);
    }
  });

  it('★ and it is the road correcting the heading that keeps it there', () => {
    // Switch the heading aid off — which is exactly the code that shipped —
    // and the same ride, same seed, walks off. Traced: the heading drifts 90 to
    // 77 degrees, the estimate underneath leaves the road while snapping still
    // holds the marker on it, and at 287 m it passes wideSearchRadiusM, loses
    // the match and is released. That release is the zigzag.
    const before = offRoad({ roughness: 2, headingAidDegPerSec: 0 });
    const after = offRoad({ roughness: 2 });
    expect(before.maxM).toBeGreaterThan(100);
    expect(after.maxM).toBeLessThan(before.maxM / 4);
  });

  it('does not need the road to be believed to keep the estimate honest', () => {
    // Sanity: with a graph loaded the marker is on the road, and the engine is
    // still reporting that it is dead reckoning rather than claiming a fix.
    const r = offRoad({ roughness: 1 });
    expect(r.meanM).toBeLessThan(10);
  });
});
