import { describe, expect, it } from 'vitest';
import {
  MotionContextDetector,
  NavigationEngine,
  enuToLatLon,
  type RoadGraph,
  type SensorSample,
} from '../src/index.js';

const ORIGIN = { lat: 23.1686, lon: 79.9339 };

/**
 * ★ THE JABALPUR MOUNTED-PHONE LATCH ★
 *
 * Field video. A rigidly mounted handset on a vehicle in city traffic. While
 * GNSS was still healthy the badge read `ON FOOT` at 5 km/h — every one of the
 * three PEDESTRIAN conditions satisfied, and none of them wrong on its own: a
 * scooter over broken surface shakes the phone past the variance threshold,
 * potholes and engine harmonics land inside the step detector's 0.6-3.5 Hz
 * band so a cadence is reported, and crawling in traffic at 1.4 m/s is inside
 * the pedestrian speed ceiling.
 *
 * Then the fixes stopped. For the next forty seconds:
 *
 *     DEAD RECKONING  [ON FOOT]   0 km/h  [STEPS]
 *     distance 704 m -> 707 m -> 708 m
 *
 * The estimate advanced 23 m while the vehicle covered 174 m. Recovery error
 * went from 4.58 % to 20.74 %.
 *
 * A mounted phone has no step cadence, so the pedestrian speed path resolves
 * to zero, so the estimate freezes. This file is the deliverable that stops
 * that recurring.
 */
describe('★ a mounted vehicle must never classify PEDESTRIAN', () => {
  /**
   * A vehicle on a bad road, crawling. Loud enough to breach the variance
   * threshold and thumping inside the step detector's cadence band — which is
   * exactly the signal that produced the field failure.
   */
  function roughRoadSample(t: number, opts: { gnssMps?: number } = {}): SensorSample {
    const p = t / 1000;
    // ~1.9 Hz thumping, the middle of the walking band, at walking amplitude.
    const thump = 3.2 * Math.sin(p * 2 * Math.PI * 1.9);
    const s: SensorSample = {
      t,
      imu: {
        ax: 0.9 * Math.sin(p * 7.1),
        ay: 0.7 * Math.sin(p * 11.3),
        az: 9.80665 + thump + 0.6 * Math.sin(p * 23.3),
        gx: 0.02 * Math.sin(p * 3.1),
        gy: 0.02 * Math.sin(p * 5.7),
        gz: 0.03 * Math.sin(p * 1.3),
      },
    };
    if (opts.gnssMps !== undefined) {
      const q = enuToLatLon(0, opts.gnssMps * p, ORIGIN.lat, ORIGIN.lon);
      s.gnss = { lat: q.lat, lon: q.lon, accuracyM: 4, speedMps: opts.gnssMps, headingDeg: 0 };
    }
    return s;
  }

  function road(): RoadGraph {
    const pts: Array<[number, number]> = [
      [0, -2000],
      [0, 8000],
    ];
    return {
      bbox: [0, 0, 0, 0],
      ways: [
        {
          id: 'street',
          highway: 'tertiary',
          coords: pts.map(([e, n]) => {
            const q = enuToLatLon(e, n, ORIGIN.lat, ORIGIN.lon);
            return [q.lon, q.lat] as [number, number];
          }),
        },
      ],
    };
  }

  /**
   * Drive at `cruiseMps`, drop to crawling traffic, then lose GNSS entirely.
   * Mirrors the video: healthy fixes, a slow stretch, then airplane mode.
   */
  function ride(cruiseMps: number, crawlMps: number) {
    const engine = new NavigationEngine();
    engine.setRoadGraph(road());
    const dt = 100;
    let t = 0;
    let entryState!: ReturnType<NavigationEngine['update']>;
    // 40 s cruising — establishes VEHICLE beyond doubt.
    for (; t < 40_000; t += dt) {
      engine.update(roughRoadSample(t, t % 1000 === 0 ? { gnssMps: cruiseMps } : {}));
    }
    // 20 s crawling in traffic on a bad road — the signal that produced ON FOOT.
    for (; t < 60_000; t += dt) {
      entryState = engine.update(roughRoadSample(t, t % 1000 === 0 ? { gnssMps: crawlMps } : {}));
    }
    const atOutageEntry = {
      context: engine.diagnostics.motionContext,
      distanceM: entryState.distanceTravelledM,
    };
    // 45 s with no fixes at all.
    const contexts: string[] = [];
    const sources: string[] = [];
    let last!: ReturnType<NavigationEngine['update']>;
    for (; t < 105_000; t += dt) {
      last = engine.update(roughRoadSample(t));
      contexts.push(engine.diagnostics.motionContext);
      sources.push(engine.currentSpeedSource);
    }
    return { engine, atOutageEntry, contexts, sources, final: last };
  }

  it('★ never says ON FOOT while crawling in traffic on a bad road', () => {
    const { atOutageEntry } = ride(12, 1.4);
    expect(atOutageEntry.context).not.toBe('PEDESTRIAN');
  });

  it('★ never says ON FOOT at any point in the outage that follows', () => {
    const { contexts } = ride(12, 1.4);
    expect(contexts).not.toContain('PEDESTRIAN');
  });

  it('★ never hands a mounted vehicle the STEPS speed source', () => {
    // This is the one that froze the estimate: no cadence on a mounted phone
    // means speedMps(0) means zero means the marker stops.
    const { sources } = ride(12, 1.4);
    expect(sources).not.toContain('STEPS');
  });

  it('★ and the estimate keeps advancing through the outage', () => {
    // The field failure: 704 m -> 708 m over forty seconds while the vehicle
    // covered 174 m. Anything that freezes shows up here as a flat distance.
    //
    // The fixture enters the outage crawling at 1.4 m/s and the IMU carries no
    // real forward acceleration, so 45 s of coasting is about 63 m and that is
    // the honest answer — the assertion is against FROZEN, not against a
    // particular distance.
    const { atOutageEntry, final } = ride(12, 1.4);
    const advanced = final.distanceTravelledM - atOutageEntry.distanceM;
    expect(advanced).toBeGreaterThan(40);
  });

  it('reports the latch so it can be seen on the roadside', () => {
    const { engine } = ride(12, 1.4);
    expect(engine.diagnostics.contextLatched).toBe(true);
    expect(engine.diagnostics.contextLatchedAt).toBeGreaterThan(0);
  });
});

/**
 * The classifier on its own, where the transition rules are easiest to state.
 */
describe('leaving VEHICLE costs sustained evidence', () => {
  const DT = 100;

  function feed(
    d: MotionContextDetector,
    from: number,
    ms: number,
    input: { accelVariance: number; cadenceHz: number; gnssSpeedMps?: number; isStationary?: boolean },
  ) {
    let t = from;
    for (; t < from + ms; t += DT) {
      d.push({
        t,
        accelVariance: input.accelVariance,
        isStationary: input.isStationary ?? false,
        cadenceHz: input.cadenceHz,
        ...(input.gnssSpeedMps !== undefined
          ? { gnssSpeedMps: input.gnssSpeedMps, gnssSpeedT: t }
          : {}),
      });
    }
    return t;
  }

  /** Establish VEHICLE the way a real drive does: a speed no pedestrian reaches. */
  function driving(d: MotionContextDetector, from = 0) {
    return feed(d, from, 20_000, { accelVariance: 2.0, cadenceHz: 0, gnssSpeedMps: 12 });
  }

  it('★ a few seconds of pothole cadence in traffic does not make a pedestrian', () => {
    const d = new MotionContextDetector();
    let t = driving(d);
    expect(d.current).toBe('VEHICLE');
    // Three seconds of the exact signal that produced the field failure.
    t = feed(d, t, 3000, { accelVariance: 2.0, cadenceHz: 1.9, gnssSpeedMps: 1.4 });
    expect(d.current).toBe('VEHICLE');
    expect(d.reason).toContain('gnss measured a vehicle');
  });

  it('a genuine walk still gets recognised, it just takes a minute', () => {
    // A rider who parks and walks away. `vehicleMemoryMs` is the cost: sixty
    // seconds of a vehicle-tuned heading rule applied to somebody strolling,
    // bought in exchange for never freezing an outage.
    const d = new MotionContextDetector();
    let t = driving(d);
    t = feed(d, t, 70_000, { accelVariance: 2.0, cadenceHz: 1.9, gnssSpeedMps: 1.4 });
    expect(d.current).toBe('PEDESTRIAN');
  });

  it('somebody who opens the app walking is recognised at once', () => {
    // Nothing to protect: there is no vehicle verdict, so no confirm applies.
    const d = new MotionContextDetector();
    feed(d, 0, 6000, { accelVariance: 2.0, cadenceHz: 1.8, gnssSpeedMps: 1.3 });
    expect(d.current).toBe('PEDESTRIAN');
  });

  it('★ the latch holds the context across an outage', () => {
    const d = new MotionContextDetector();
    let t = driving(d);
    d.setGnssHealthy(false, t);
    expect(d.latched).toBe(true);
    expect(d.latchedAt).toBe(t);
    // Forty seconds of loud thumping with no fixes: the signal says walking,
    // the latch says the receiver last saw a vehicle, and absence of evidence
    // releases nothing.
    t = feed(d, t, 40_000, { accelVariance: 2.0, cadenceHz: 1.9 });
    expect(d.current).toBe('VEHICLE');
    expect(d.reason).toContain('latched');
  });

  it('a stop is the one release the latch allows', () => {
    // isStationary is a raw-sensor decision the IMU makes on its own, and it
    // already arms ZUPT everywhere else. A vehicle that has stopped really is
    // stationary.
    const d = new MotionContextDetector();
    const t = driving(d);
    d.setGnssHealthy(false, t);
    feed(d, t, 6000, { accelVariance: 0.002, cadenceHz: 0, isStationary: true });
    expect(d.current).toBe('STATIONARY');
  });

  it('releases when GNSS comes back', () => {
    const d = new MotionContextDetector();
    const t = driving(d);
    d.setGnssHealthy(false, t);
    expect(d.latched).toBe(true);
    d.setGnssHealthy(true, t + 30_000);
    expect(d.latched).toBe(false);
    expect(d.latchedAt).toBeNull();
  });

  it('vehicleEstablished stays true through the outage, which is what gates STEPS', () => {
    const d = new MotionContextDetector();
    const t = driving(d);
    expect(d.vehicleEstablished).toBe(true);
    d.setGnssHealthy(false, t);
    feed(d, t, 30_000, { accelVariance: 2.0, cadenceHz: 1.9 });
    expect(d.vehicleEstablished).toBe(true);
  });
});

/**
 * ★ THE ONE SIGNAL A ROUGH ROAD CANNOT FAKE ★
 *
 * Second Tier F ride, outage 2. With GNSS healthy and the vehicle crawling at
 * 4.5 km/h the classifier called PEDESTRIAN — and every rule that fired was
 * behaving correctly. Variance was high, because the road was broken. A
 * cadence was reported, because potholes land inside the step detector's
 * 0.6-3.5 Hz band. The speed was inside the walking band, because traffic.
 *
 * `vehicleMemoryMs` was supposed to catch it and could not: the rider had been
 * in traffic long enough that no vehicle-speed reading was recent. Time cannot
 * separate these cases — a scooter can crawl for as long as it likes.
 *
 * The mount can. A handset clamped to handlebars holds its orientation
 * relative to gravity to a degree or two over the worst surface; a handset
 * being carried swings through tens, because walking rocks the body and turns
 * the wrist. That is not a statistical gap, it is an order of magnitude.
 */
describe('a handset that has not moved in its mount is not on legs', () => {
  const DT = 100;

  function feed(
    d: MotionContextDetector,
    from: number,
    ms: number,
    input: {
      accelVariance: number;
      cadenceHz: number;
      gnssSpeedMps?: number;
      mountMotionDeg?: number;
    },
  ) {
    let t = from;
    for (; t < from + ms; t += DT) {
      d.push({
        t,
        accelVariance: input.accelVariance,
        isStationary: false,
        cadenceHz: input.cadenceHz,
        ...(input.mountMotionDeg !== undefined ? { mountMotionDeg: input.mountMotionDeg } : {}),
        ...(input.gnssSpeedMps !== undefined
          ? { gnssSpeedMps: input.gnssSpeedMps, gnssSpeedT: t }
          : {}),
      });
    }
    return t;
  }

  /** The field signal exactly: loud, rhythmic, slow — and clamped to the bars. */
  const CRAWLING = { accelVariance: 2.0, cadenceHz: 1.9, gnssSpeedMps: 1.25 };

  it('★ a crawling scooter is not a pedestrian, however long it crawls', () => {
    // Five minutes — far past vehicleMemoryMs, which is what could not save it.
    const d = new MotionContextDetector();
    feed(d, 0, 300_000, { ...CRAWLING, mountMotionDeg: 1.5 });
    expect(d.current).not.toBe('PEDESTRIAN');
  });

  it('and the same signal from a carried handset still reads as walking', () => {
    // The veto must not simply disable pedestrian detection. A phone in a hand
    // swings, and that is what tells the two apart.
    const d = new MotionContextDetector();
    feed(d, 0, 300_000, { ...CRAWLING, mountMotionDeg: 25 });
    expect(d.current).toBe('PEDESTRIAN');
  });

  it('says nothing when the attitude has not settled', () => {
    // Before the estimator knows which way is down there is no mount signal,
    // and the other rules stand alone rather than being overruled by silence.
    const d = new MotionContextDetector();
    feed(d, 0, 300_000, CRAWLING);
    expect(d.current).toBe('PEDESTRIAN');
  });

  it('the threshold is an order of magnitude from either case', () => {
    // A clamped phone measures 1-2 degrees, a carried one tens. Anything in
    // between is not a case that occurs, which is why this can be a constant.
    const mounted = new MotionContextDetector();
    feed(mounted, 0, 300_000, { ...CRAWLING, mountMotionDeg: 5.9 });
    expect(mounted.current).not.toBe('PEDESTRIAN');

    const carried = new MotionContextDetector();
    feed(carried, 0, 300_000, { ...CRAWLING, mountMotionDeg: 6.1 });
    expect(carried.current).toBe('PEDESTRIAN');
  });

  it('can be switched off, and then the field failure reproduces', () => {
    const d = new MotionContextDetector({ mountStillDeg: 0 });
    feed(d, 0, 300_000, { ...CRAWLING, mountMotionDeg: 1.5 });
    expect(d.current).toBe('PEDESTRIAN');
  });
});
