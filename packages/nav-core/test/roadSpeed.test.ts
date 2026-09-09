import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROAD_SPEED_RATCHET,
  ROAD_CLASS_SPEED_KPH,
  RoadSpeedCeilingRatchet,
  roadSpeedCeiling,
  type RoadSpeedCeilingSource,
} from '../src/constraints/roadSpeed.js';

const TOL = 1.3;

describe('roadSpeedCeiling', () => {
  it('prefers the way\'s own maxspeed over its class', () => {
    // A statement about THIS road outranks one about roads like it.
    const r = roadSpeedCeiling(30, 'primary', 1);
    expect(r.source).toBe('maxspeed');
    expect(r.ceilingMps).toBeCloseTo(30 / 3.6, 6);
  });

  it('falls back to the class table, which is what India actually has tagged', () => {
    const r = roadSpeedCeiling(undefined, 'residential', 1);
    expect(r.source).toBe('class');
    expect(r.ceilingMps).toBeCloseTo(40 / 3.6, 6);
  });

  it('★ says nothing about a class it does not know', () => {
    // Inventing a ceiling for an unenumerated class would clamp a vehicle that
    // may legitimately be on it. No opinion is the honest answer.
    for (const h of [undefined, '', 'busway', 'raceway', 'road']) {
      expect(roadSpeedCeiling(undefined, h, TOL).source).toBe('none');
      expect(roadSpeedCeiling(undefined, h, TOL).ceilingMps).toBeUndefined();
    }
  });

  it('applies the tolerance, so a genuine 60 in a 40 zone is untouched', () => {
    const r = roadSpeedCeiling(undefined, 'residential', TOL);
    expect(r.ceilingMps! * 3.6).toBeCloseTo(52, 6);
  });

  it('★ bounds the field failure: 90 km/h asserted on a residential street', () => {
    const asserted = 90 / 3.6;
    const { ceilingMps } = roadSpeedCeiling(undefined, 'residential', TOL);
    expect(Math.min(asserted, ceilingMps!) * 3.6).toBeCloseTo(52, 6);
    // And on the tertiary ways the same ride crossed.
    const tertiary = roadSpeedCeiling(undefined, 'tertiary', TOL);
    expect(tertiary.ceilingMps! * 3.6).toBeCloseTo(65, 6);
  });

  it('link roads carry their parent class', () => {
    for (const parent of ['tertiary', 'secondary', 'primary', 'trunk', 'motorway']) {
      expect(ROAD_CLASS_SPEED_KPH[`${parent}_link`]).toBe(ROAD_CLASS_SPEED_KPH[parent]);
    }
  });

  it('rejects a nonsense maxspeed rather than clamping to it', () => {
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(roadSpeedCeiling(bad, 'residential', TOL).source).toBe('class');
    }
  });

  it('never returns a non-finite ceiling', () => {
    for (const tol of [0, -1, Number.NaN]) {
      const r = roadSpeedCeiling(50, 'primary', tol);
      expect(Number.isFinite(r.ceilingMps!)).toBe(true);
    }
  });
});

describe('RoadSpeedCeilingRatchet', () => {
  const HOLD = DEFAULT_ROAD_SPEED_RATCHET.raiseHoldMs;
  const slow = { ceilingMps: 40 / 3.6, source: 'class' as const };
  const mid = { ceilingMps: 60 / 3.6, source: 'class' as const };
  const fast = { ceilingMps: 70 / 3.6, source: 'class' as const };
  const none = { ceilingMps: undefined, source: 'none' as const };

  /** Offer the same ceiling until the hold expires, and return what is in force. */
  function settle(
    r: RoadSpeedCeilingRatchet,
    from: number,
    offer: { ceilingMps: number; source: RoadSpeedCeilingSource },
  ) {
    let held = r.update(from, offer);
    for (let t = from + 20; t <= from + HOLD + 20; t += 20) held = r.update(t, offer);
    return held;
  }

  it('★ does not adopt even the FIRST offer immediately', () => {
    // Going from "the map has no opinion" to "the map says 26" is the largest
    // change this mechanism can make, and it was the one that was unguarded:
    // the first sample brushing a service road slammed the ceiling onto a
    // vehicle doing a hundred. The off-road eval caught it — worst excursion
    // 40 m to 99.6 m.
    const r = new RoadSpeedCeilingRatchet();
    expect(r.update(0, slow).ceilingMps).toBeUndefined();
    expect(r.update(HOLD - 20, slow).ceilingMps).toBeUndefined();
  });

  it('adopts it once it has been offered for the hold', () => {
    const r = new RoadSpeedCeilingRatchet();
    expect(settle(r, 0, slow).ceilingMps).toBeCloseTo(slow.ceilingMps, 6);
  });

  it('drops to a lower ceiling immediately once one is established', () => {
    const r = new RoadSpeedCeilingRatchet();
    settle(r, 0, fast);
    expect(r.update(HOLD + 100, slow).ceilingMps).toBeCloseTo(slow.ceilingMps, 6);
  });

  it('★ makes a rise wait, so a flickering match cannot lift the clamp', () => {
    const r = new RoadSpeedCeilingRatchet();
    const t0 = HOLD + 40;
    settle(r, 0, slow);
    for (let t = t0; t < t0 + HOLD; t += 20) {
      expect(r.update(t, fast).ceilingMps).toBeCloseTo(slow.ceilingMps, 6);
    }
    expect(r.update(t0 + HOLD, fast).ceilingMps).toBeCloseTo(fast.ceilingMps, 6);
  });

  it('★ a match alternating between two classes never lifts the clamp', () => {
    // The junction case: a residential street beside a primary road, offered
    // alternately. Without the hold the ceiling spends half its time at 70.
    const r = new RoadSpeedCeilingRatchet();
    settle(r, 0, slow);
    let held = r.current;
    for (let t = HOLD + 40; t < 60_000; t += 20) {
      held = r.update(t, (t / 20) % 2 === 0 ? slow : fast);
    }
    expect(held.ceilingMps).toBeCloseTo(slow.ceilingMps, 6);
  });

  it('releases at once when the match is lost', () => {
    // A vehicle we cannot place on a road may be on an unmapped one.
    const r = new RoadSpeedCeilingRatchet();
    settle(r, 0, slow);
    expect(r.update(HOLD + 100, none).ceilingMps).toBeUndefined();
    expect(r.update(HOLD + 120, none).source).toBe('none');
  });

  it('a rise restarts its hold if the offer changes', () => {
    const r = new RoadSpeedCeilingRatchet();
    settle(r, 0, slow);
    const t0 = HOLD + 40;
    r.update(t0, fast);
    r.update(t0 + HOLD - 100, mid); // a different rise: restarts the clock
    expect(r.update(t0 + HOLD, mid).ceilingMps).toBeCloseTo(slow.ceilingMps, 6);
    expect(settle(r, t0 + HOLD, mid).ceilingMps).toBeCloseTo(mid.ceilingMps, 6);
  });

  it('reports the source of whatever is in force', () => {
    const r = new RoadSpeedCeilingRatchet();
    expect(settle(r, 0, { ceilingMps: 10, source: 'maxspeed' }).source).toBe('maxspeed');
    expect(r.update(HOLD + 100, none).source).toBe('none');
  });

  it('resets clean', () => {
    const r = new RoadSpeedCeilingRatchet();
    settle(r, 0, slow);
    r.reset();
    expect(r.current.ceilingMps).toBeUndefined();
    expect(r.current.source).toBe('none');
  });
});
