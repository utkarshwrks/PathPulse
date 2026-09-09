/**
 * What the road says the vehicle cannot be doing.
 *
 * ★ THE MAP ALREADY KNEW, AND NOBODY ASKED IT ★
 *
 * Field ride, Jabalpur, a two-wheeler in city traffic on residential and
 * tertiary ways, GNSS off for 52 s:
 *
 *   t+25.5s   64 km/h [ML]   dist  994 m
 *   t+51.9s   48 km/h [ML]   dist 1329 m
 *   recovery  44 km/h [ML]   dist 1649 m,  drift 197.0 m
 *
 * 655 m in the final 26 seconds is a sustained 90 km/h, on streets where 40 is
 * the limit. The only ceiling in the chain was `maxSpeedMps: 40` — 144 km/h —
 * which stops nothing, and the whole failure follows from that: an over-stated
 * speed pushes the estimate ahead ALONG the road, it crosses a junction the
 * vehicle has not physically reached, snapping commits to a branch there, and
 * `continuityMaxMismatchDeg` then makes staying on the wrong way cheaper than
 * leaving it. The error is locked in and cannot self-correct.
 *
 * The matcher is not broken. It is being handed a position that has already
 * left the truth.
 *
 * ★ MOST OF THIS WAS ALREADY IN THE GRAPH ★
 *
 * `maxspeed` has been carried through the PPG1 codec since it was written, and
 * decoded onto `RoadWay.maxspeed`, and surfaced on every snap candidate as
 * `RoadPosition.maxspeedKph`. It was consumed by exactly one caller —
 * `canTrustSpeedLimit`, which decides whether the match is close enough to
 * believe — and never used to bound anything.
 *
 * ★ WHY THE CLASS TABLE CARRIES THE WORK, NOT `maxspeed` ★
 *
 * `maxspeed` tagging is sparse in India: on the ride above almost no way had
 * one. `highway` is present on essentially every way in OSM, and the codec
 * already stores it — as an index into a per-graph string table, so the value
 * survives the round trip and no format change is needed to read it.
 *
 * These numbers are not legal limits. They are the speed above which a vehicle
 * is almost certainly not on a way of this class, chosen high rather than
 * accurate: the job is to catch a 2-3x over-read, not to police anybody. A
 * genuine 60 in a 40 zone passes through the tolerance untouched.
 *
 * ★ A BOUND, NEVER A MEASUREMENT ★
 *
 * This truncates the estimator's output. It must never enter the filter as an
 * observation — that is the standing rule the whole map-matching design rests
 * on, and the reason snapping corrects what is SHOWN while the estimator keeps
 * its own honest opinion. A clamp is permitted; a measurement is not.
 */

/**
 * Plausible ceiling by OSM `highway` class, km/h.
 *
 * Link roads take their parent's figure: a slip road off a trunk carries trunk
 * traffic, and a vehicle is on it for a few seconds.
 */
export const ROAD_CLASS_SPEED_KPH: Readonly<Record<string, number>> = {
  // ★ `service` AND `living_street` ARE DELIBERATELY ABSENT ★
  //
  // They are the most numerous class in every graph we hold — 434 of 725 ways
  // in the city extract, 2,787 of 5,794 in IO-VNBD S1, 7,940 of 15,022 in S3c
  // — and they carry the lowest ceiling, which makes them simultaneously the
  // likeliest wrong match and the most damaging one. A service road running
  // parallel to a main road, within the trust radius and pointing the same
  // way, passes every test this module can apply and then clamps a vehicle
  // doing 100 to 26.
  //
  // `speedLimitTrustDistanceM` already records this exact failure for the
  // `maxspeed` path: "a nearby service road's limit was applied to a vehicle
  // on a trunk road", 107 m of along-track error becoming 135 m. That
  // mechanism survived it because `maxspeed` is tagged on 6 of 725 city ways,
  // so it almost never fired. A class table fires on every way, so the same
  // hazard is live on every sample and has to be answered rather than
  // survived.
  //
  // Nothing is lost by declining: a vehicle genuinely on a service road is
  // doing under 30 anyway, so the clamp had almost no work to do there.
  residential: 40,
  unclassified: 40,
  tertiary: 50,
  tertiary_link: 50,
  secondary: 60,
  secondary_link: 60,
  primary: 70,
  primary_link: 70,
  trunk: 85,
  trunk_link: 85,
  motorway: 95,
  motorway_link: 95,
};

/** Where a ceiling came from. Rendered on the Device screen — see `roadSpeedClamp`. */
export type RoadSpeedCeilingSource = 'maxspeed' | 'class' | 'none';

export interface RoadSpeedCeiling {
  /** The ceiling, m/s, or undefined when the road says nothing usable. */
  ceilingMps: number | undefined;
  source: RoadSpeedCeilingSource;
}

/**
 * The ceiling this matched way implies, before tolerance.
 *
 * `maxspeed` outranks the class table because it is a statement about THIS
 * road rather than about roads like it. An unknown or absent class yields no
 * ceiling at all rather than a guess: a way tagged with something not in the
 * table is one we have no opinion about, and inventing one would clamp a
 * vehicle that might legitimately be on a highway we failed to enumerate.
 */
export function roadSpeedCeiling(
  maxspeedKph: number | undefined,
  highway: string | undefined,
  toleranceFactor: number,
): RoadSpeedCeiling {
  const tol = Number.isFinite(toleranceFactor) && toleranceFactor > 0 ? toleranceFactor : 1;
  if (maxspeedKph !== undefined && Number.isFinite(maxspeedKph) && maxspeedKph > 0) {
    return { ceilingMps: ((maxspeedKph / 3.6) * tol), source: 'maxspeed' };
  }
  const classKph = highway === undefined ? undefined : ROAD_CLASS_SPEED_KPH[highway];
  if (classKph !== undefined) {
    return { ceilingMps: ((classKph / 3.6) * tol), source: 'class' };
  }
  return { ceilingMps: undefined, source: 'none' };
}

export interface RoadSpeedRatchetConfig {
  /**
   * How long a HIGHER ceiling must be offered before it takes effect, ms.
   *
   * ★ ASYMMETRIC, BECAUSE THE TWO ERRORS ARE NOT ★
   *
   * The matcher flickers between candidate ways at junctions, and a
   * residential street beside a primary road offers 40 and 70 alternately. A
   * ceiling that followed that would spend half its time at 70 and clamp
   * nothing — the flap would defeat the mechanism rather than merely blur it.
   *
   * So a rise has to be sustained: the vehicle really is on a faster road, and
   * a couple of seconds of confirmation costs at most a couple of seconds of
   * over-clamping while it accelerates onto it. A FALL applies at once,
   * because the cost of being late is the failure this exists to prevent, and
   * because clamping is safe by construction — it only ever removes speed the
   * estimator could not justify.
   */
  raiseHoldMs: number;
}

export const DEFAULT_ROAD_SPEED_RATCHET: RoadSpeedRatchetConfig = {
  raiseHoldMs: 2500,
};

/**
 * Holds a road-derived ceiling steady across a flickering match.
 *
 * Stateful, and therefore a class rather than a function: the hold is about
 * time, and the only honest way to express "this has been offered for two and
 * a half seconds" is to remember when it was first offered.
 */
export class RoadSpeedCeilingRatchet {
  private readonly config: RoadSpeedRatchetConfig;
  private applied: number | undefined;
  private appliedSource: RoadSpeedCeilingSource = 'none';
  private pending: number | undefined;
  private pendingSource: RoadSpeedCeilingSource = 'none';
  private pendingSinceMs: number | null = null;

  constructor(config: Partial<RoadSpeedRatchetConfig> = {}) {
    this.config = { ...DEFAULT_ROAD_SPEED_RATCHET, ...config };
  }

  get current(): RoadSpeedCeiling {
    return { ceilingMps: this.applied, source: this.applied === undefined ? 'none' : this.appliedSource };
  }

  /**
   * Offer this sample's ceiling and get back the one in force.
   *
   * @param offered the ceiling the current match implies, or undefined when
   *                there is no trusted match — which RELEASES the clamp
   *                immediately, because a vehicle we cannot place on a road may
   *                legitimately be on an unmapped one.
   */
  update(tMs: number, offered: RoadSpeedCeiling): RoadSpeedCeiling {
    const next = offered.ceilingMps;
    if (next === undefined || !Number.isFinite(next)) {
      this.applied = undefined;
      this.appliedSource = 'none';
      this.pending = undefined;
      this.pendingSinceMs = null;
      return this.current;
    }
    if (this.applied !== undefined && next <= this.applied) {
      // A fall between two established ceilings. Immediate — see `raiseHoldMs`.
      this.applied = next;
      this.appliedSource = offered.source;
      this.pending = undefined;
      this.pendingSinceMs = null;
      return this.current;
    }
    // ★ THE FIRST OFFER IS A RISE TOO ★
    //
    // Adopting it immediately was the bug the off-road eval caught: the very
    // first sample that brushed a service road slammed the ceiling from
    // nothing to 26 km/h, on a vehicle doing a hundred. Going from "the map
    // has no opinion" to "the map says 26" is the largest change this
    // mechanism can make, and it is exactly the one that was unguarded.
    // A rise. Hold it until it has been offered continuously for long enough.
    if (this.pending === undefined || next !== this.pending) {
      this.pending = next;
      this.pendingSource = offered.source;
      this.pendingSinceMs = tMs;
      return this.current;
    }
    if (this.pendingSinceMs !== null && tMs - this.pendingSinceMs >= this.config.raiseHoldMs) {
      this.applied = this.pending;
      this.appliedSource = this.pendingSource;
      this.pending = undefined;
      this.pendingSinceMs = null;
    }
    return this.current;
  }

  reset(): void {
    this.applied = undefined;
    this.appliedSource = 'none';
    this.pending = undefined;
    this.pendingSource = 'none';
    this.pendingSinceMs = null;
  }
}
