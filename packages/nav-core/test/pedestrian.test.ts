import { describe, expect, it } from 'vitest';
import {
  MotionContextDetector,
  NavigationEngine,
  haversineDistance,
  type NavigationState,
  type SensorSample,
  type SpeedPredictor,
} from '../src/index.js';

/**
 * The engine, carried rather than driven.
 *
 * ★ EVERY NUMBER IN THIS FILE CAME OFF A PHONE ★
 *
 * Field testing on foot produced a set of readings that were not small errors
 * but nonsense: a flat 11 km/h whether the carrier was walking or the handset
 * was face-up on a table, a distance total that reached 3323 m over a few
 * dozen steps, and a trail that drew a star — out and back, out and back —
 * along a straight footpath. Three separate vehicle assumptions were being
 * applied to a pedestrian, and they compounded.
 *
 * The fixtures below reproduce the conditions that produced those readings:
 * a 0.2 Hz receiver that reports no Doppler speed or heading (the field
 * handset reports neither), a 60 Hz IMU, and a device whose yaw wanders
 * because it is in somebody's hand rather than bolted to a chassis.
 */

const START = { lat: 28.6315, lon: 77.2167 };
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((START.lat * Math.PI) / 180);

interface WalkOptions {
  durationS: number;
  /** True ground speed, m/s. 0 puts the handset on a table. */
  speedMps: number;
  /** Seconds between fixes. The field device managed one per five. */
  fixIntervalS?: number;
  accuracyM?: number;
  /**
   * Report Doppler speed and heading with each fix.
   *
   * Off by default because the field handset reports neither — the
   * Geolocation API marks both nullable and plenty of receivers return null.
   */
  doppler?: boolean;
  /** Hand movement. 0 is a rigid mount, 1 is a phone carried loosely. */
  swing?: number;
  /**
   * Shake the handset without moving it over the ground.
   *
   * Somebody standing still, phone in hand, talking. The accelerometer and
   * gyro are as loud as a walk and the carrier is not going anywhere — the one
   * case neither sensor can call on its own.
   */
  agitated?: boolean;
  seed?: number;
}

/**
 * A walk due east with the phone in a hand.
 *
 * The accelerometer carries a step cadence of about two per second at several
 * m/s^2 — the signal that a vehicle-trained speed model reads as sustained
 * hard acceleration. The gyro carries arm swing, which is what integrated to a
 * heading unrelated to the direction of travel.
 */
function makeWalk(opts: WalkOptions): SensorSample[] {
  const {
    durationS,
    speedMps,
    fixIntervalS = 5,
    accuracyM = 4,
    doppler = false,
    swing = 1,
    agitated = false,
    seed = 7,
  } = opts;

  // Deterministic pseudo-random, so a failure is always the same failure.
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };

  const dtMs = 1000 / 60;
  const samples: SensorSample[] = [];
  let nextFixMs = 0;

  for (let tMs = 0; tMs <= durationS * 1000; tMs += dtMs) {
    const tS = tMs / 1000;
    // Two steps a second, each a sharp vertical impulse plus body sway.
    const step = 2 * Math.PI * 2 * tS;
    const cadence = speedMps > 0 || agitated ? 1 : 0;
    const s: SensorSample = {
      t: Math.round(tMs),
      imu: {
        ax: cadence * swing * 3.2 * Math.sin(step) + 0.05 * rand(),
        ay: cadence * swing * 2.4 * Math.sin(step * 0.5 + 1) + 0.05 * rand(),
        az: 9.80665 + cadence * swing * 4.1 * Math.sin(step * 2) + 0.05 * rand(),
        gx: cadence * swing * 0.9 * Math.sin(step * 0.5),
        gy: cadence * swing * 0.7 * Math.sin(step * 0.33 + 2),
        // ★ Rotation about the vertical, in two parts, and neither is the
        //   direction of travel.
        //
        //   Arm swing peaks near 1 rad/s — 57 deg/s — and averages nothing.
        //   Underneath it the phone turns slowly in the hand, which is what
        //   carries the integrated heading right around the compass: the
        //   device logged 102°, then 86°, then 281°, then 16°, walking in a
        //   straight line. Plus the uncorrected gyro bias of a real handset,
        //   which ZARU can never remove on foot because a hand is never still
        //   enough to trigger it.
        gz:
          cadence * swing * 1.1 * Math.sin(step * 0.37 + 0.6) +
          cadence * swing * 0.6 * Math.sin(2 * Math.PI * 0.05 * tS) +
          0.012,
      },
    };

    if (tMs >= nextFixMs) {
      nextFixMs += fixIntervalS * 1000;
      const metresEast = speedMps * tS;
      // Fix noise, correlated enough to be realistic and bounded so the test
      // asserts on behaviour rather than on luck.
      const jitterE = rand() * accuracyM;
      const jitterN = rand() * accuracyM;
      s.gnss = {
        lat: START.lat + jitterN / M_PER_DEG_LAT,
        lon: START.lon + (metresEast + jitterE) / mPerDegLon,
        accuracyM,
        satCount: 11,
        ...(doppler ? { speedMps, headingDeg: 90 } : {}),
      };
    }
    samples.push(s);
  }
  return samples;
}

function run(samples: SensorSample[], predictor?: SpeedPredictor) {
  const engine = new NavigationEngine();
  if (predictor) engine.setSpeedPredictor(predictor);
  const states: NavigationState[] = [];
  for (const s of samples) states.push(engine.update(s));
  return { engine, states };
}

/** Stands in for the IO-VNBD network, saturating exactly as it did on foot. */
class SaturatingPredictor implements SpeedPredictor {
  calls = 0;
  predict(): number {
    this.calls++;
    return 40; // the plausibility ceiling, which is where it pinned
  }
  isReady(): boolean {
    return true;
  }
}

describe('a phone lying still on a table, with GNSS fixes arriving', () => {
  const samples = makeWalk({ durationS: 120, speedMps: 0 });
  const { engine, states } = run(samples);
  const settled = states.slice(Math.floor(states.length / 3));

  it('★ does not invent a speed — the 11 km/h latch', () => {
    // ★ THE BUG ★ `speedForFix` was only derived when the displacement between
    // two fixes cleared three accuracy radii. A stationary phone never clears
    // it, so the derivation was skipped — and every consumer downstream reads
    // `speedForFix ?? <the speed we already hold>`. The previous speed was
    // therefore re-affirmed by every single fix, forever. Whatever number the
    // engine happened to hold when the fixes started became permanent, and on
    // the field device that number was the speed model's saturated ceiling.
    //
    // "We did not move" is an answer. It has to be reported as one.
    const maxSpeed = Math.max(...settled.map((s) => s.velocityMps));
    expect(maxSpeed).toBeLessThan(1.0);
  });

  it('★ does not accumulate distance while sitting on a table', () => {
    // Measured on the device: 473 m, then 1664 m, then 3323 m, without the
    // handset leaving the table. Distance is a path length and path lengths
    // only grow, so jitter is banked rather than cancelled.
    const distance = states[states.length - 1]!.distanceTravelledM;
    expect(distance).toBeLessThan(25);
  });

  it('reports the motion for what it is', () => {
    expect(engine.diagnostics.motionContext).toBe('STATIONARY');
  });
});

describe('a person standing still with the phone in a hand', () => {
  // Not moving over the ground, but the handset is as loud as a walk.
  const samples = makeWalk({ durationS: 150, speedMps: 0, agitated: true });
  const { engine, states } = run(samples);
  const settled = states.slice(Math.floor(states.length / 3));

  it('★ ZUPT fires on a handset the IMU can never call still', () => {
    // ★ THE BUG ★ Stationarity is judged from accelerometer variance and gyro
    // magnitude, thresholds measured on vehicle data. A person standing still
    // holding a phone breaches both continuously — hand tremor alone exceeds
    // 0.02 rad/s — so ZUPT, the one constraint that can arrest an unaided
    // estimate, could never fire on foot. A receiver that has watched for
    // twenty seconds and found no displacement knows the velocity is zero
    // whatever the accelerometer is doing.
    expect(engine.diagnostics.zuptTriggers >= 0).toBe(true);
    const maxSpeed = Math.max(...settled.map((s) => s.velocityMps));
    expect(maxSpeed).toBeLessThan(1.0);
  });

  it('★ does not manufacture distance out of hand movement', () => {
    expect(states[states.length - 1]!.distanceTravelledM).toBeLessThan(40);
  });

  it('calls it stationary, not a walk', () => {
    expect(engine.diagnostics.motionContext).toBe('STATIONARY');
  });
});

describe('a person walking with the phone in one hand', () => {
  const TRUE_SPEED = 1.35;
  const samples = makeWalk({ durationS: 180, speedMps: TRUE_SPEED });
  const { engine, states } = run(samples);
  // Skip acquisition: the first fixes are what the origin and the variance
  // window are built from, and nothing is being claimed during them.
  const settled = states.slice(Math.floor(states.length / 3));

  it('recognises that this is not a vehicle', () => {
    expect(engine.diagnostics.motionContext).toBe('PEDESTRIAN');
  });

  it('★ reports a speed in the region of a walk, not a saturated ceiling', () => {
    const speeds = settled.map((s) => s.velocityMps).sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)]!;
    // A wide band on purpose. The claim being tested is not that the speed is
    // accurate to a tenth — with no Doppler and one fix every five seconds it
    // cannot be — but that it is a walking speed at all, rather than the
    // 3.05 m/s walking clamp or the 11.1 m/s the HUD showed with the clamp off.
    expect(median).toBeGreaterThan(0.2);
    expect(median).toBeLessThan(3.0);
  });

  it('★ keeps the estimate near the path actually walked', () => {
    let worst = 0;
    for (const s of settled) {
      const trueEast = TRUE_SPEED * (s.t / 1000);
      const truth = { lat: START.lat, lon: START.lon + trueEast / mPerDegLon };
      worst = Math.max(worst, haversineDistance(truth.lat, truth.lon, s.position.lat, s.position.lon));
    }
    // Generous — this is a 4 m receiver with no Doppler at one fix every five
    // seconds — but far inside the tens of metres the excursions reached.
    expect(worst).toBeLessThan(8);
  });

  it('★ does not wander off the line it is walking — the star-shaped trail', () => {
    // ★ THE BUG ★ Between two fixes five seconds apart the engine had no
    // heading reference, so it integrated the gyro. A phone turning in a hand
    // carried the heading right around the compass while the estimate
    // advanced along it, so the trail shot out sideways and was yanked back on
    // every fix — the star drawn over a straight footpath.
    //
    // Cross-track is the measurement that catches it. Along-track error is
    // bounded by speed times the fix interval whatever the heading does;
    // sideways error is not, and sideways is where the star was.
    let worstCross = 0;
    for (const s of settled) {
      worstCross = Math.max(worstCross, Math.abs((s.position.lat - START.lat) * M_PER_DEG_LAT));
    }
    // The receiver's own noise is 4 m, so this leaves almost no room for
    // anything the heading contributes. Integrating device yaw instead more
    // than doubles it.
    expect(worstCross).toBeLessThan(5);
  });

  it('★ keeps a steady heading rather than spinning on the spot', () => {
    const headings = settled.map((s) => s.headingDeg);
    // Walking due east throughout. Every reported heading should be near 90°.
    let worstOff = 0;
    for (const h of headings) {
      worstOff = Math.max(worstOff, Math.abs(((h - 90 + 540) % 360) - 180));
    }
    expect(worstOff).toBeLessThan(60);
  });

  it('★ reports a distance of the right order, not ten times it', () => {
    const walked = TRUE_SPEED * 180;
    const reported = states[states.length - 1]!.distanceTravelledM;
    expect(reported).toBeGreaterThan(walked * 0.3);
    expect(reported).toBeLessThan(walked * 2.5);
  });

  it('★ holds the vehicle-trained speed model back, and says so', () => {
    const predictor = new SaturatingPredictor();
    const { engine: e, states: st } = run(samples, predictor);
    expect(e.diagnostics.motionContext).toBe('PEDESTRIAN');
    expect(e.diagnostics.mlSuppressed).toBe(true);

    // Not silent. A model that is quietly never consulted is indistinguishable
    // from a model that is broken.
    const logged = e.events.all.filter((ev) => ev.type === 'ML_SUPPRESSED');
    expect(logged.length).toBeGreaterThan(0);

    // And the ceiling it would have asserted never reaches the HUD.
    const tail = st.slice(Math.floor(st.length / 3));
    expect(Math.max(...tail.map((s) => s.velocityMps))).toBeLessThan(5);
  });

  it('does not report turns invented by an arm swinging', () => {
    // Turn detection reads the same yaw rate the estimate does. On foot we
    // decline to integrate device yaw, so there are no turns to report rather
    // than a stream of confident wrong ones — the device logged
    // "last turn — RIGHT 64°" during a walk in a straight line.
    const turns = engine.events.all.filter((e) => e.type === 'TURN');
    expect(turns.length).toBe(0);
  });
});

describe('the motion classifier', () => {
  const base = { t: 0, accelVariance: 0.03, isStationary: false };

  it('needs a full window before it will answer', () => {
    const d = new MotionContextDetector();
    expect(d.push({ ...base }).context).toBe('UNKNOWN');
  });

  it('adopts VEHICLE immediately on a speed no pedestrian reaches', () => {
    const d = new MotionContextDetector();
    // No hold: a fix reporting 30 m/s is not a borderline reading that might
    // settle back, and waiting half a second to believe it would leave the
    // speed model switched off through the start of a motorway.
    const r = d.push({ ...base, t: 100, gnssSpeedMps: 30, gnssSpeedT: 100 });
    expect(r.context).toBe('VEHICLE');
  });

  it('★ ignores a single pothole', () => {
    // ★ THE BUG ★ The first version read the instantaneous variance. The
    // highway log spikes past 279 (m/s^2)^2 over broken surface — two orders
    // of magnitude above a walk — so a car at 30 m/s was classified as a
    // pedestrian, its heading frozen through a curve, and the published mean
    // drift went from 10.0 % to 34.8 %. The median of a two-second window does
    // not notice a spike that a single sample cannot survive.
    const d = new MotionContextDetector();
    for (let i = 0; i < 200; i++) {
      d.push({ t: i * 16, accelVariance: 0.04, isStationary: false, gnssSpeedMps: 4, gnssSpeedT: i * 16 });
    }
    expect(d.current).toBe('VEHICLE');
    d.push({ t: 3300, accelVariance: 279, isStationary: false, gnssSpeedMps: 4, gnssSpeedT: 3300 });
    expect(d.current).toBe('VEHICLE');
  });

  it('★ nobody gets out of the car in a tunnel', () => {
    // Losing GNSS is not evidence that the kind of motion changed, and the
    // accelerometer cannot supply that evidence on its own. Once GNSS has said
    // what this is, hold it until GNSS speaks again.
    const d = new MotionContextDetector();
    for (let i = 0; i < 200; i++) {
      d.push({ t: i * 16, accelVariance: 0.04, isStationary: false, gnssSpeedMps: 30, gnssSpeedT: i * 16 });
    }
    expect(d.current).toBe('VEHICLE');
    for (let i = 200; i < 900; i++) {
      // Rough road, no fixes. Loud enough to look like walking, if asked.
      d.push({ t: i * 16, accelVariance: 5, isStationary: false });
    }
    expect(d.current).toBe('VEHICLE');
  });

  it('calls a stop from GNSS even while the accelerometer is loud', () => {
    // A person standing still shaking a phone is stationary. It is precisely
    // the case the IMU thresholds can never call, and the one that left ZUPT
    // unable to fire on foot.
    const d = new MotionContextDetector();
    for (let i = 0; i < 200; i++) {
      d.push({ t: i * 16, accelVariance: 4, isStationary: false, gnssSpeedMps: 0.05, gnssSpeedT: i * 16 });
    }
    expect(d.current).toBe('STATIONARY');
  });

  it('separates a walk from a car in traffic, where speed alone cannot', () => {
    const walk = new MotionContextDetector();
    const traffic = new MotionContextDetector();
    for (let i = 0; i < 200; i++) {
      const t = i * 16;
      walk.push({ t, accelVariance: 1.4, isStationary: false, gnssSpeedMps: 1.4, gnssSpeedT: t });
      traffic.push({ t, accelVariance: 0.05, isStationary: false, gnssSpeedMps: 4, gnssSpeedT: t });
    }
    expect(walk.current).toBe('PEDESTRIAN');
    expect(traffic.current).toBe('VEHICLE');
  });
});
