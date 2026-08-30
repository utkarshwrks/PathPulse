import { describe, expect, it } from 'vitest';
import {
  NavigationEngine,
  type SensorSample,
  classifyTurn,
  describeTurn,
  DEFAULT_TURN_CONFIG,
  TurnDetector,
  type TurnEvent,
} from '../src/index.js';

/**
 * Turn detection.
 *
 * The detector's output goes straight into the event log, which is one of the
 * anti-fake features: a judge is invited to read it and check it against what
 * the vehicle actually did. A log claiming a right turn that never happened is
 * worse than no turn detection at all, so most of what is tested here is what
 * must NOT produce a turn.
 */

const START = { lat: 28.6315, lon: 77.2167 };
const HZ = 50;
const DT_MS = 1000 / HZ;
const CRUISE = 14;

/** Drive straight for `seconds`, feeding the detector at 50 Hz. */
function straight(d: TurnDetector, seconds: number, startMs: number, headingDeg = 0) {
  const events: TurnEvent[] = [];
  let t = startMs;
  for (let i = 0; i < seconds * HZ; i++) {
    t += DT_MS;
    const e = d.update(t, 0, DT_MS, CRUISE, headingDeg);
    if (e) events.push(e);
  }
  return { t, events, headingDeg };
}

/**
 * Sweep `totalDeg` over `seconds` at a constant rate.
 * Positive is a right turn, matching the compass-sense yaw rate the attitude
 * estimator produces.
 */
function turn(
  d: TurnDetector,
  totalDeg: number,
  seconds: number,
  startMs: number,
  startHeadingDeg = 0,
  speedMps = CRUISE,
) {
  const events: TurnEvent[] = [];
  const rateDegPerSec = totalDeg / seconds;
  const rateRad = (rateDegPerSec * Math.PI) / 180;
  let t = startMs;
  let heading = startHeadingDeg;
  for (let i = 0; i < seconds * HZ; i++) {
    t += DT_MS;
    heading += (rateDegPerSec * DT_MS) / 1000;
    const e = d.update(t, rateRad, DT_MS, speedMps, heading);
    if (e) events.push(e);
  }
  return { t, events, headingDeg: heading };
}

/** A full manoeuvre: straight, turn, straight long enough for it to close. */
function manoeuvre(totalDeg: number, seconds = 4, speedMps = CRUISE) {
  const d = new TurnDetector();
  const a = straight(d, 2, 0);
  const b = turn(d, totalDeg, seconds, a.t, 0, speedMps);
  const c = straight(d, 2, b.t, b.headingDeg);
  return { detector: d, events: [...b.events, ...c.events] };
}

describe('classifyTurn', () => {
  it('names the manoeuvre, and keeps the number separately', () => {
    expect(classifyTurn(87, 25)).toBe('RIGHT_90');
    expect(classifyTurn(-87, 25)).toBe('LEFT_90');
    expect(classifyTurn(38, 25)).toBe('SLIGHT_RIGHT');
    expect(classifyTurn(-38, 25)).toBe('SLIGHT_LEFT');
    expect(classifyTurn(178, 25)).toBe('U_TURN');
    expect(classifyTurn(-165, 25)).toBe('U_TURN');
  });

  it('discards anything under the reporting floor', () => {
    // A lane change is not a turn. A log full of 12-degree "turns" is a log
    // nobody reads, which costs the event log its whole purpose.
    expect(classifyTurn(12, 25)).toBeNull();
    expect(classifyTurn(-24.9, 25)).toBeNull();
    expect(classifyTurn(NaN, 25)).toBeNull();
  });
});

describe('describeTurn', () => {
  const base = {
    t: 0,
    startedAtMs: 0,
    durationMs: 4000,
    fromHeadingDeg: 0,
    toHeadingDeg: 90,
  };

  it('reads the way a driver would say it', () => {
    expect(describeTurn({ ...base, kind: 'RIGHT_90', deltaDeg: 87.4 })).toBe('RIGHT 87°');
    expect(describeTurn({ ...base, kind: 'LEFT_90', deltaDeg: -91.6 })).toBe('LEFT 92°');
    expect(describeTurn({ ...base, kind: 'U_TURN', deltaDeg: 179.2 })).toBe('U-TURN 179°');
  });
});

describe('TurnDetector', () => {
  it('detects a right turn and classifies it', () => {
    const { events } = manoeuvre(90);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('RIGHT_90');
    expect(events[0]!.deltaDeg).toBeGreaterThan(85);
    expect(events[0]!.deltaDeg).toBeLessThan(95);
  });

  it('gets the sign right — a left turn is not a right turn', () => {
    // Field defect #4 was a whole-system sign error that looked perfect in
    // simulation. Turning the wrong way on the HUD is the same class of bug,
    // and just as invisible until someone drives it.
    const { events } = manoeuvre(-90);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('LEFT_90');
    expect(events[0]!.deltaDeg).toBeLessThan(0);
  });

  it('separates a U-turn from a right turn', () => {
    expect(manoeuvre(180, 6).events[0]!.kind).toBe('U_TURN');
    expect(manoeuvre(90).events[0]!.kind).toBe('RIGHT_90');
  });

  it('reports the headings it turned between', () => {
    const { events } = manoeuvre(90);
    const e = events[0]!;
    expect(e.fromHeadingDeg).toBeGreaterThanOrEqual(0);
    expect(e.fromHeadingDeg).toBeLessThan(15);
    expect(e.toHeadingDeg).toBeGreaterThan(80);
    expect(e.toHeadingDeg).toBeLessThan(100);
  });

  it('★ ignores rotation while stopped — a phone turning is not a vehicle turning', () => {
    // Picked up at a light and rotated to read a message: a clean 90 degrees
    // with the vehicle stationary. Without the speed gate this lands in the
    // event log as a right turn at a junction.
    const { events } = manoeuvre(90, 4, 0.2);
    expect(events).toHaveLength(0);
  });

  it('does not fire on a gentle motorway bend', () => {
    // 20 degrees spread over 8 seconds never reaches 40 in any 3-second window.
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    const b = turn(d, 20, 8, a.t);
    const c = straight(d, 2, b.t, b.headingDeg);
    expect([...b.events, ...c.events]).toHaveLength(0);
  });

  it('does not fire on a lane change', () => {
    // Out and back: a real sweep in each direction that nets to nothing.
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    const b = turn(d, 15, 1.2, a.t);
    const c = turn(d, -15, 1.2, b.t, b.headingDeg);
    const e = straight(d, 2, c.t, c.headingDeg);
    expect([...b.events, ...c.events, ...e.events]).toHaveLength(0);
  });

  it('does not split one turn into two when the steering wobbles', () => {
    // Real steering is not a constant rate. A momentary dip in yaw rate must
    // not close the turn and open a second one.
    const d = new TurnDetector();
    let t = straight(d, 2, 0).t;
    let heading = 0;
    const events: TurnEvent[] = [];
    const rates = [30, 28, 4, 26, 30, 22]; // deg/s, with a dip in the middle
    for (const r of rates) {
      const res = turn(d, r * 0.6, 0.6, t, heading);
      t = res.t;
      heading = res.headingDeg;
      events.push(...res.events);
    }
    const tail = straight(d, 2, t, heading);
    events.push(...tail.events);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('RIGHT_90');
  });

  it('only reports once the turn has ended, never mid-sweep', () => {
    // Firing at 40 degrees would label every U-turn a right turn.
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    const b = turn(d, 180, 6, a.t);
    expect(b.events).toHaveLength(0);
    expect(d.isTurning).toBe(true);
    const c = straight(d, 2, b.t, b.headingDeg);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.kind).toBe('U_TURN');
  });

  it('handles two turns in a row', () => {
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    const b = turn(d, 90, 4, a.t);
    const c = straight(d, 2, b.t, b.headingDeg);
    const e = turn(d, -90, 4, c.t, b.headingDeg);
    const f = straight(d, 2, e.t, e.headingDeg);
    const all = [...b.events, ...c.events, ...e.events, ...f.events];
    expect(all).toHaveLength(2);
    expect(all[0]!.kind).toBe('RIGHT_90');
    expect(all[1]!.kind).toBe('LEFT_90');
    expect(d.count).toBe(2);
  });

  it('force-closes a rotation that never settles', () => {
    const d = new TurnDetector({ maxDurationMs: 5000 });
    const a = straight(d, 2, 0);
    // A spiral ramp: continuous rotation with no straight section at all.
    const b = turn(d, 900, 20, a.t);
    expect(b.events.length).toBeGreaterThanOrEqual(1);
  });

  it('abandons a turn interrupted by a stop rather than straddling it', () => {
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    const b = turn(d, 45, 1.5, a.t); // turn opens
    expect(d.isTurning).toBe(true);
    turn(d, 0, 1, b.t, b.headingDeg, 0); // vehicle stops mid-turn
    expect(d.isTurning).toBe(false);
  });

  it('rejects junk timing instead of producing a turn from it', () => {
    const d = new TurnDetector();
    expect(d.update(NaN, 1, DT_MS, CRUISE, 0)).toBeNull();
    expect(d.update(1000, 1, 0, CRUISE, 0)).toBeNull();
    expect(d.update(1000, 1, -5, CRUISE, 0)).toBeNull();
    // A 5-second gap between samples is a clock jump, not a 5-second turn.
    expect(d.update(1000, 1, 5000, CRUISE, 0)).toBeNull();
  });

  it('treats a non-finite yaw rate as zero rather than propagating NaN', () => {
    const d = new TurnDetector();
    const a = straight(d, 2, 0);
    let t = a.t;
    for (let i = 0; i < 100; i++) {
      t += DT_MS;
      expect(d.update(t, NaN, DT_MS, CRUISE, 0)).toBeNull();
    }
    expect(d.isTurning).toBe(false);
  });

  it('exposes the last turn and survives a reset', () => {
    const { detector } = manoeuvre(90);
    expect(detector.current?.kind).toBe('RIGHT_90');
    expect(detector.count).toBe(1);
    detector.reset();
    expect(detector.current).toBeNull();
    expect(detector.count).toBe(0);
    expect(detector.isTurning).toBe(false);
  });

  it('uses the guide’s stated thresholds', () => {
    // 40 degrees in 3 seconds, straight from the build guide.
    expect(DEFAULT_TURN_CONFIG.triggerDeg).toBe(40);
    expect(DEFAULT_TURN_CONFIG.windowMs).toBe(3000);
  });
});

describe('NavigationEngine — turns reach the event log', () => {
  /**
   * The detector is correct in isolation above. This checks the wiring: that
   * the engine feeds it the *corrected* yaw rate and that a turn driven
   * through the full engine surfaces as a TURN event and on the state.
   *
   * The gyro here is deliberately NOT flat-phone. gz alone would under-report
   * this turn badly, which is field defect #1 — the whole reason the detector
   * consumes the gravity-projected rate rather than device Z.
   */
  const TILT_RAD = (35 * Math.PI) / 180; // phone leaning back in a cradle

  function drive(yawRatesDegPerSec: number[], hz = 50) {
    const engine = new NavigationEngine();
    const dtMs = 1000 / hz;
    const states = [];
    let t = 0;
    let heading = 90;
    let nextGnssMs = 0;

    for (const rateDeg of yawRatesDegPerSec) {
      t += dtMs;
      heading = (heading + (rateDeg * dtMs) / 1000 + 360) % 360;
      const rateRad = (rateDeg * Math.PI) / 180;

      // Gravity split across Y and Z by the mount tilt, and the yaw rate split
      // the same way — this is what a real cradled phone reports.
      const phase = (t / 1000) * 2 * Math.PI * 20;
      const shake = 0.8;
      const s: SensorSample = {
        t,
        imu: {
          ax: shake * Math.sin(phase),
          ay: 9.80665 * Math.sin(TILT_RAD) + shake * Math.sin(phase * 1.31),
          az: 9.80665 * Math.cos(TILT_RAD) + shake * Math.sin(phase * 0.77),
          gx: 0,
          // Compass-sense right turn is negative under the right-hand rule.
          gy: -rateRad * Math.sin(TILT_RAD),
          gz: -rateRad * Math.cos(TILT_RAD),
        },
      };
      if (t >= nextGnssMs) {
        nextGnssMs += 1000;
        const hRad = (heading * Math.PI) / 180;
        s.gnss = {
          lat: START.lat + (14 * (t / 1000) * Math.cos(hRad)) / 111_320,
          lon:
            START.lon +
            (14 * (t / 1000) * Math.sin(hRad)) /
              (111_320 * Math.cos((START.lat * Math.PI) / 180)),
          accuracyM: 4,
          speedMps: 14,
          headingDeg: heading,
          satCount: 9,
        };
      }
      states.push(engine.update(s));
    }
    return { states, events: [...engine.events.all] };
  }

  it('★ logs a TURN event for a turn taken with the phone in a cradle', () => {
    const rates = [
      ...Array<number>(150).fill(0), // 3 s straight
      ...Array<number>(200).fill(22.5), // 4 s at 22.5 deg/s = 90 deg
      ...Array<number>(150).fill(0), // 3 s straight
    ];
    const { states, events } = drive(rates);
    const last = states[states.length - 1]!;
    expect(last.lastTurn).toBeDefined();
    expect(last.lastTurn!.kind).toBe('RIGHT_90');
    expect(last.lastTurn!.label).toMatch(/^RIGHT \d+°$/);

    // Golden Rule #8: it has to be in the log a judge can export and read.
    const logged = events.filter((e) => e.type === 'TURN');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.message).toMatch(/RIGHT \d+° over [\d.]+s/);
    expect(logged[0]!.data?.kind).toBe('RIGHT_90');
  });

  it('logs nothing for a straight run', () => {
    const { states, events } = drive(Array<number>(500).fill(0));
    expect(states[states.length - 1]!.lastTurn).toBeUndefined();
    expect(events.filter((e) => e.type === 'TURN')).toHaveLength(0);
  });
});
