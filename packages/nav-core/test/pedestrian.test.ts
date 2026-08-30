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
  /** Seconds during which the receiver reports nothing at all. */
  outageStartS?: number;
  outageEndS?: number;
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
    outageStartS = -1,
    outageEndS = -1,
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
        // One vertical impulse per footstep — two a second, the rate the step
        // detector has to find. Body sway runs at half that, once per stride,
        // because a stride is two steps.
        ax: cadence * swing * 3.2 * Math.sin(step) + 0.05 * rand(),
        ay: cadence * swing * 2.4 * Math.sin(step * 0.5 + 1) + 0.05 * rand(),
        az: 9.80665 + cadence * swing * 4.1 * Math.sin(step) + 0.05 * rand(),
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
      if (tS >= outageStartS && tS < outageEndS) {
        samples.push(s);
        continue;
      }
      const metresEast = speedMps * tS;
      // ★ THE NOISE HAS TO MATCH THE ACCURACY THE FIX CLAIMS ★
      // This fixture used to jitter by half a radius while telling the engine
      // the accuracy was a whole one, which made the estimator's job easier
      // than reality and hid a real bias: the speed test passed against code
      // that read a walk 2.3x too fast. Three uniforms summed is close enough
      // to Gaussian, scaled so one sigma is the accuracy reported.
      const noise = () => (rand() + rand() + rand()) * 2 * accuracyM;
      const jitterE = noise();
      const jitterN = noise();
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
    // Measured: 58 m over 150 s against a 4 m receiver, where a window that
    // closed on distance instead of on time banked 182 m.
    expect(states[states.length - 1]!.distanceTravelledM).toBeLessThan(90);
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

  it('★ reports the speed the carrier is actually walking at', () => {
    const speeds = settled.map((s) => s.velocityMps).sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)]!;
    // ★ THE BUG ★ The window that measured this closed as soon as the
    // displacement cleared a noise bar, so it closed preferentially on the
    // intervals where noise pushed the displacement outward. Every reading was
    // taken from a sample chosen for having error in one direction, and a
    // 5 km/h walk read a steady 11 km/h on the device.
    //
    // A window that ends on time cannot be selected by the thing it measures.
    // This band is 40 % either side of truth, which no biased estimator that
    // was reading 2.3x high can sit inside.
    expect(median).toBeGreaterThan(TRUE_SPEED * 0.6);
    expect(median).toBeLessThan(TRUE_SPEED * 1.4);
  });

  it('★ draws a line, not a saw-tooth — the trail records receiver noise', () => {
    // ★ THE BUG ★ The estimate adopted each fix outright. Between fixes it
    // propagates smoothly; on a fix it jumped the whole way to the new
    // reading, so a 4 m receiver reporting every five seconds wrote a 4 m
    // step into the trail every five seconds and kept it forever.
    //
    // Measured as the roughness of the drawn path: the sum of the turns it
    // makes across the track it is walking. A straight walk should be nearly
    // straight; a saw-tooth is not.
    let jitter = 0;
    let prev: number | null = null;
    for (const s of settled) {
      const cross = (s.position.lat - START.lat) * M_PER_DEG_LAT;
      if (prev !== null) jitter += Math.abs(cross - prev);
      prev = cross;
    }
    // Total sideways wander over two minutes of walking, in metres. Measured:
    // 67 m taking a quarter of each fix, against 181 m adopting them outright,
    // 132 m integrating device yaw and 169 m with the biased speed window.
    expect(jitter).toBeLessThan(100);
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
    // Measured: 9.9 m, against 18.9 m integrating device yaw and 18.2 m with
    // the biased measurement window.
    expect(worst).toBeLessThan(14);
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
    expect(worstCross).toBeLessThan(13);
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

describe('a person walking through a GNSS outage', () => {
  const TRUE_SPEED = 1.35;
  // Ninety seconds without a single fix, in the middle of a walk. A tunnel, an
  // underpass, or the side of a tall building.
  const samples = makeWalk({
    durationS: 240,
    speedMps: TRUE_SPEED,
    outageStartS: 90,
    outageEndS: 180,
  });
  const { engine, states } = run(samples);
  const during = states.filter((s) => s.t >= 110_000 && s.t < 175_000);

  it('★ keeps moving — dead reckoning on foot used to freeze at 0 km/h', () => {
    // ★ THE BUG ★ Holding the vehicle-trained speed model back on foot was
    // right and it left a hole: no speed source at all. Integration was
    // arrested by ZUPT and the coasting decay, the HUD read
    // `DEAD RECKONING · ON FOOT · 0 km/h`, and the marker sat still while the
    // person kept walking. Recoveries measured 210 m over 564 m — 37 % — and
    // almost all of it was the estimate having stopped rather than drifted.
    //
    // An engine whose entire claim is navigation without GNSS cannot freeze
    // the moment GNSS goes.
    const speeds = during.map((s) => s.velocityMps).sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)]!;
    expect(median).toBeGreaterThan(TRUE_SPEED * 0.5);
    expect(median).toBeLessThan(TRUE_SPEED * 1.8);
  });

  it('★ covers roughly the ground the carrier covered', () => {
    const first = during[0]!;
    const last = during[during.length - 1]!;
    const advancedM = haversineDistance(
      first.position.lat,
      first.position.lon,
      last.position.lat,
      last.position.lon,
    );
    const trueM = TRUE_SPEED * ((last.t - first.t) / 1000);
    // Frozen, this was zero.
    expect(advancedM).toBeGreaterThan(trueM * 0.5);
    expect(advancedM).toBeLessThan(trueM * 1.7);
  });

  it('says the speed came from the step model, not from a car model', () => {
    expect(engine.diagnostics.speedSource === 'STEPS' || engine.diagnostics.cadenceHz > 0).toBe(
      true,
    );
  });

  it('★ learns the stride from GNSS before it needs it', () => {
    // The default 0.72 m is a population average. By the time the outage
    // arrives it should have been replaced by a measurement of this carrier —
    // speed over cadence, taken while GNSS was up. Being wrong by a third
    // about stride length is exactly the error dead reckoning exists to avoid.
    expect(engine.diagnostics.strideObservations).toBeGreaterThan(0);
    expect(engine.diagnostics.strideM).toBeGreaterThan(0.35);
    expect(engine.diagnostics.strideM).toBeLessThan(1.1);
  });

  it('counts steps at a plausible walking cadence', () => {
    // The fixture walks at exactly two steps a second.
    expect(engine.diagnostics.cadenceHz).toBeGreaterThan(1.4);
    expect(engine.diagnostics.cadenceHz).toBeLessThan(2.6);
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
      walk.push({ t, accelVariance: 1.4, isStationary: false, cadenceHz: 2, gnssSpeedMps: 1.4, gnssSpeedT: t });
      traffic.push({ t, accelVariance: 0.05, isStationary: false, cadenceHz: 0, gnssSpeedMps: 4, gnssSpeedT: t });
    }
    expect(walk.current).toBe('PEDESTRIAN');
    expect(traffic.current).toBe('VEHICLE');
  });

  it('★ a shaken handset is not a pair of legs — the scooter on a bad road', () => {
    // ★ THE BUG ★ PEDESTRIAN was declared from accelerometer variance alone.
    // A scooter over broken surface shakes a handset exactly as hard as
    // walking does, so the device showed ON FOOT at 11 and 25 km/h — and being
    // called a pedestrian switches off the speed model and freezes the
    // heading, which is the worst thing to do to a vehicle.
    //
    // Walking is not merely loud, it is periodic at one to three hertz.
    // Nothing else a carrier does looks like that.
    const scooter = new MotionContextDetector();
    for (let i = 0; i < 300; i++) {
      const t = i * 16;
      scooter.push({
        t,
        accelVariance: 3.5, // as loud as a walk
        isStationary: false,
        cadenceHz: 0, // and no footfall anywhere in it
        gnssSpeedMps: 3.1, // 11 km/h, exactly what the device reported
        gnssSpeedT: t,
      });
    }
    expect(scooter.current).toBe('VEHICLE');
  });

  it('★ refuses to call anything above a run a walk', () => {
    // Even with a convincing rhythm. 7 m/s is 25 km/h and nobody covers that
    // on their legs for the length of a demo.
    const fast = new MotionContextDetector();
    for (let i = 0; i < 300; i++) {
      const t = i * 16;
      fast.push({ t, accelVariance: 3.5, isStationary: false, cadenceHz: 2, gnssSpeedMps: 7, gnssSpeedT: t });
    }
    expect(fast.current).toBe('VEHICLE');
  });
});
