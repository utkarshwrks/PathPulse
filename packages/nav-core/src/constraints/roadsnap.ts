import type { EnuPoint } from '../types.js';
import { angleDiffDeg, type RoadIndex, type RoadSegment } from '../mapmatch/RoadIndex.js';
import type { RoadPosition } from '../mapmatch/types.js';

export interface RoadSnapConfig {
  /** No road within this distance means no match at all, metres. */
  searchRadiusM: number;
  /**
   * Widened radius used when the ordinary one finds nothing, metres.
   *
   * ★ THE FAILURE MODE THIS FIXES ★
   * With a single fixed radius, road snapping stops the moment it is needed
   * most. Dead reckoning drifts past 50 m from any road, `findRoadMatch`
   * returns null, snapping silently disengages, and the marker is then free to
   * wander open ground — which is exactly the field report: "it goes off the
   * road, into the plots". Measured over the committed logs, 27 % of
   * dead-reckoning samples were drawn more than 10 m from any road and the
   * worst was 106 m out, with the largest excursions occurring precisely where
   * the estimate had drifted beyond the search radius.
   *
   * A vehicle 200 m from the nearest road is not off-road; it is a bad
   * estimate of a vehicle that is on one. Looking further is not a licence to
   * match anything — the score still prefers near roads with the right
   * heading — it is a refusal to give up at the point of maximum need.
   */
  wideSearchRadiusM: number;
  /**
   * Cost in metres of a fully-opposed heading, scaled linearly by mismatch.
   *
   * The build guide writes this as `headingMismatch * 30`. Taken literally with
   * degrees that would make a 90-degree mismatch cost 2700 — swamping distance
   * entirely and reducing the score to "whichever road points the right way,
   * however far". Read instead as 30 metres for a completely wrong heading,
   * scaled by mismatch/180, it does what it is clearly meant to: break ties
   * between parallel roads without overruling proximity.
   */
  headingWeightM: number;
  /** Bonus for staying on the way we matched last sample, metres. */
  continuityBonusM: number;
  /** Lower bound on how much of the correction is applied per sample. */
  minSnapStrength: number;
  /** Upper bound. Never 1: a hard snap is a teleport wearing a hat. */
  maxSnapStrength: number;
  /** Cross-track uncertainty is capped at this once a match is held, metres. */
  crossTrackCapM: number;
  /**
   * Snap strength used while dead reckoning, 0..1.
   *
   * ★ WHY THIS IS 1 AND THE OTHERS ARE NOT ★
   * While GNSS is healthy the receiver is measuring position and the road is a
   * weaker claim than the measurement, so the snap stays gentle and lets the
   * fix win. The instant GNSS is gone that reverses completely: there is no
   * measurement left, and "the vehicle is on a road" becomes the strongest
   * statement anybody can make about where it is. Applying 10 % of that (which
   * is what `1 - confidence` gives on the first second of an outage, when
   * confidence is still 1) draws the marker 90 % of the way into the field.
   *
   * Full projection is not a teleport: it is applied through a ramp, and the
   * estimate enters the outage already on the road, so the correction grows
   * from nothing exactly as the drift does.
   */
  deadReckoningStrength: number;
  /** Seconds over which a change in snap strength is phased in. */
  strengthRampMs: number;
  /**
   * Fastest the snap correction itself may move the marker, m/s.
   *
   * ★ GOLDEN RULE #6 ENFORCED BY CONSTRUCTION, NOT BY HOPE ★
   *
   * Ramping the STRENGTH is not enough, because the target moves too. When the
   * matched way changes — the estimate runs off the end of one road and a
   * nearer one wins — a full-strength snap re-aims at a completely different
   * line, and the marker arrives there on the very next sample. Measured on
   * the highway log: a 158.6 metre step between two consecutive samples, which
   * is a teleport by any definition and precisely what the rule forbids.
   *
   * So the applied correction is a rate-limited vector rather than a value
   * recomputed from scratch each sample. In normal operation the limit never
   * binds — cross-track drift grows at centimetres per second — and when it
   * does bind, a correction that would have been a jump becomes a slide.
   *
   * 60 m/s matches `RecoveryConfig.maxSlewRateMps`, deliberately: it is the
   * figure this codebase already settled on for "fast, but continuous motion
   * the eye can follow", and having two different answers to the same question
   * would mean one of them is wrong.
   */
  maxSnapRateMps: number;
  /**
   * How far the snap may move the marker ALONG the road, metres.
   *
   * ★ THE ONE EXCEPTION TO "CROSS-TRACK ONLY", AND ITS BOUND ★
   *
   * The rule exists so the map can never invent progress the vehicle has not
   * made — see `applyRoadSnap`. It has one blind spot: when the nearest point
   * on a road is an ENDPOINT, the offset to it is largely along the road, so
   * discarding that component leaves the marker hanging off the end of the way
   * in open ground. Refusing to move is not neutrality there; it is choosing
   * to draw the vehicle in a field.
   *
   * So a bounded along-track correction is allowed. Bounded, because the
   * purpose of the original rule survives: the map may nudge the marker onto
   * the end of a road, it may not carry it down one. Measured, this removed
   * the last off-road excursions without moving mean drift.
   *
   * 0 restores the strict Phase 6D behaviour.
   */
  maxAlongCorrectionM: number;
  /**
   * A match must be at least this close before its speed limit is trusted, m.
   *
   * ★ MATCHING A ROAD AND TRUSTING ITS SPEED LIMIT ARE DIFFERENT CLAIMS ★
   * Snapping geometry is forgiving: pulled toward roughly the right road, the
   * marker looks right even if the specific way is wrong. A speed limit is not
   * forgiving — adopting the wrong road's limit clamps the estimate to a speed
   * the vehicle is not doing, and that error integrates.
   *
   * Measured: feeding the limit from any match inside the full 50 m radius made
   * along-track error on the highway route WORSE, 107 m to 135 m, because a
   * nearby service road's limit was applied to a vehicle on a trunk road. Only
   * accepting confident matches turns the same mechanism into the largest
   * along-track improvement available, 107 m to 34 m.
   */
  speedLimitTrustDistanceM: number;
  /** And its heading must agree within this, degrees. */
  speedLimitTrustHeadingDeg: number;
}

export const DEFAULT_ROAD_SNAP_CONFIG: RoadSnapConfig = {
  searchRadiusM: 50,
  wideSearchRadiusM: 250,
  headingWeightM: 30,
  continuityBonusM: 20,
  minSnapStrength: 0.1,
  maxSnapStrength: 0.7,
  crossTrackCapM: 5,
  deadReckoningStrength: 1,
  strengthRampMs: 1000,
  maxSnapRateMps: 60,
  maxAlongCorrectionM: 25,
  speedLimitTrustDistanceM: 20,
  speedLimitTrustHeadingDeg: 45,
};

/** Closest point on a segment to a query point, plus how far along it lies. */
function projectOntoSegment(
  e: number,
  n: number,
  seg: RoadSegment,
): { e: number; n: number; t: number; distanceM: number } {
  const dx = seg.e2 - seg.e1;
  const dy = seg.n2 - seg.n1;
  const lenSq = dx * dx + dy * dy;
  // Clamped to [0,1] so the projection never runs off the end of the segment
  // and onto an imaginary extension of the road.
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((e - seg.e1) * dx + (n - seg.n1) * dy) / lenSq)) : 0;
  const pe = seg.e1 + dx * t;
  const pn = seg.n1 + dy * t;
  return { e: pe, n: pn, t, distanceM: Math.hypot(e - pe, n - pn) };
}

/**
 * Heading mismatch against a road, in degrees.
 *
 * A way's bearing is the direction it happens to be drawn in OpenStreetMap,
 * not the direction of travel. On a two-way road, driving the other way is a
 * perfect match at 180 degrees of nominal mismatch — so the two directions are
 * folded together. On a one-way road the direction is real information and is
 * kept, which is what lets a divided carriageway be told from its opposite.
 */
export function headingMismatchDeg(
  headingDeg: number,
  roadBearingDeg: number,
  oneway: boolean,
): number {
  const raw = Math.abs(angleDiffDeg(headingDeg, roadBearingDeg));
  return oneway ? raw : Math.min(raw, 180 - raw);
}

/** Find the best road match for a position, or null if nothing is close enough. */
export function findRoadMatch(
  enu: EnuPoint,
  headingDeg: number,
  index: RoadIndex,
  lastWayId: string | null,
  config: RoadSnapConfig = DEFAULT_ROAD_SNAP_CONFIG,
  searchRadiusM: number = config.searchRadiusM,
): RoadPosition | null {
  const radius = Math.max(1, searchRadiusM);
  const candidates = index.nearbySegments(enu.e, enu.n, radius);
  if (candidates.length === 0) return null;

  // Continuity is a tie-breaker measured in metres, so it has to scale with
  // the radius it is breaking ties inside — 20 m against a 50 m search is a
  // meaningful preference, against a 250 m one it is noise. Capped, because a
  // held way that is genuinely wrong has to be able to lose.
  const continuityBonusM =
    config.continuityBonusM * Math.min(3, Math.max(1, radius / config.searchRadiusM));

  let best: RoadPosition | null = null;
  let bestScore = Infinity;

  const { e, n } = enu;
  for (const seg of candidates) {
    const p = projectOntoSegment(e, n, seg);
    if (p.distanceM > radius) continue;

    const way = index.getWay(seg.wayId);
    const mismatch = headingMismatchDeg(headingDeg, seg.bearingDeg, way?.oneway === true);

    // ★ SCORE THE MATCH BY WHERE IT WOULD LEAVE US, NOT ONLY BY HOW FAR IT IS ★
    //
    // A match at a segment ENDPOINT is one the snap cannot fully act on: the
    // correction to it is mostly along the road, and along-track movement is
    // capped on purpose. So such a match can be the nearest road and still
    // leave the marker in a field — which is what happened on the highway log,
    // where the estimate ran off the end of a way and hovered 123 m from the
    // road it was still nominally matched to, until a different way finally
    // won and the marker jumped 158 m onto it.
    //
    // Charging the match for the part of the correction that cannot be applied
    // makes the scorer prefer a road it can actually put the marker on, which
    // both keeps it on the road and removes the large target changes that made
    // the jump possible.
    const alongOvershootM = Math.abs(
      (p.e - e) * Math.sin((seg.bearingDeg * Math.PI) / 180) +
        (p.n - n) * Math.cos((seg.bearingDeg * Math.PI) / 180),
    );
    const unsnappableM = Math.max(0, alongOvershootM - config.maxAlongCorrectionM);

    let score = p.distanceM + config.headingWeightM * (mismatch / 180) + unsnappableM;

    // ★ CONTINUITY MUST NOT SURVIVE RUNNING OFF THE END OF THE WAY ★
    //
    // `t` is clamped to [0,1], so a projection that lands exactly on an
    // endpoint means the estimate is PAST the end of this segment, not
    // alongside it. Preferring the held way there is precisely backwards: we
    // have left it. Worse, the correction to such a match is almost entirely
    // ALONG the road, and `applyRoadSnap` discards the along component by
    // design — so the snap computes a 23 m error and then moves the marker
    // zero metres, leaving it sitting in a field at the end of a road while
    // the panel cheerfully names the road it is not on. That was every
    // remaining off-road excursion in the measurement.
    const atEndpoint = p.t <= 1e-6 || p.t >= 1 - 1e-6;
    if (!atEndpoint && lastWayId !== null && seg.wayId === lastWayId) score -= continuityBonusM;

    if (score < bestScore) {
      bestScore = score;
      best = {
        wayId: seg.wayId,
        name: way?.name,
        maxspeedKph: way?.maxspeed,
        arcLengthM: seg.arcStartM + p.t * seg.lengthM,
        enu: { e: p.e, n: p.n },
        distanceM: p.distanceM,
        bearingDeg: seg.bearingDeg,
      };
    }
  }

  return best;
}

/**
 * Is this match confident enough to adopt the road's speed limit?
 *
 * Separate from the match itself, because being on roughly the right road is a
 * much weaker claim than knowing exactly which road you are on.
 */
export function canTrustSpeedLimit(
  match: RoadPosition,
  headingDeg: number,
  oneway: boolean,
  config: RoadSnapConfig = DEFAULT_ROAD_SNAP_CONFIG,
): boolean {
  if (match.maxspeedKph === undefined) return false;
  if (match.distanceM > config.speedLimitTrustDistanceM) return false;
  return (
    headingMismatchDeg(headingDeg, match.bearingDeg, oneway) <=
    config.speedLimitTrustHeadingDeg
  );
}

export interface SnapResult {
  enu: EnuPoint;
  /** How much of the cross-track correction was applied, 0..1. */
  strength: number;
  /** Cross-track error before correction, metres (signed: + is right of road). */
  crossTrackM: number;
}

/**
 * Move a position toward its matched road — across the road only.
 *
 * ★ CROSS-TRACK ONLY. NEVER ALONG-TRACK. ★
 *
 * The nearest point on a road carries two pieces of information, and only one
 * of them is trustworthy. That the vehicle is *on* this road is near-certain,
 * because vehicles do not drive through buildings — so the perpendicular
 * component of the correction is real evidence. Where along the road it sits is
 * exactly what dead reckoning was estimating in the first place, and the
 * nearest-point calculation knows nothing about it; adopting that component
 * would overwrite the estimate with an artefact of geometry and could drag the
 * marker backwards past a junction it has already crossed.
 *
 * So the correction is decomposed against the road's bearing and the along-road
 * part is discarded. This is also why the uncertainty ellipse is an ellipse:
 * snapping bounds cross-track error while along-track error keeps growing.
 *
 * The strength is driven by confidence — trust GNSS when it is healthy, trust
 * the road when it is not — and is capped below 1, because a hard snap is a
 * teleport with better manners.
 */
export function applyRoadSnap(
  enu: EnuPoint,
  match: RoadPosition,
  confidence: number,
  config: RoadSnapConfig = DEFAULT_ROAD_SNAP_CONFIG,
  /**
   * Use this strength instead of deriving one from confidence.
   *
   * The engine supplies it while dead reckoning, where the road is the
   * strongest evidence available rather than the weakest — see
   * `deadReckoningStrength`.
   */
  strengthOverride?: number,
): SnapResult {
  const bearingRad = (match.bearingDeg * Math.PI) / 180;
  // Unit vector along the road, and its right-hand normal.
  const alongE = Math.sin(bearingRad);
  const alongN = Math.cos(bearingRad);
  const rightE = alongN;
  const rightN = -alongE;

  // Correction vector, decomposed against the road.
  const de = match.enu.e - enu.e;
  const dn = match.enu.n - enu.n;
  const crossMagnitude = de * rightE + dn * rightN;
  // See `maxAlongCorrectionM`. Normally zero — the perpendicular foot of an
  // interior projection has no along component at all — and non-zero only when
  // the nearest point is an endpoint, which is exactly the case the cap is for.
  const alongMagnitude = de * alongE + dn * alongN;
  const alongCapped = Math.max(
    -config.maxAlongCorrectionM,
    Math.min(config.maxAlongCorrectionM, alongMagnitude),
  );

  const c = Number.isFinite(confidence) ? confidence : 0;
  const strength =
    strengthOverride !== undefined && Number.isFinite(strengthOverride)
      ? Math.max(0, Math.min(1, strengthOverride))
      : Math.max(config.minSnapStrength, Math.min(config.maxSnapStrength, 1 - c));

  const applied = crossMagnitude * strength;
  const appliedAlong = alongCapped * strength;
  return {
    enu: {
      e: enu.e + applied * rightE + appliedAlong * alongE,
      n: enu.n + applied * rightN + appliedAlong * alongN,
    },
    strength,
    // Signed the other way round so positive means "we are right of the road".
    crossTrackM: -crossMagnitude,
  };
}
