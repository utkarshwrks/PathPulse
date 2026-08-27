import type { EnuPoint } from '../types.js';
import { angleDiffDeg, type RoadIndex, type RoadSegment } from '../mapmatch/RoadIndex.js';
import type { RoadPosition } from '../mapmatch/types.js';

export interface RoadSnapConfig {
  /** No road within this distance means no match at all, metres. */
  searchRadiusM: number;
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
  headingWeightM: 30,
  continuityBonusM: 20,
  minSnapStrength: 0.1,
  maxSnapStrength: 0.7,
  crossTrackCapM: 5,
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
): RoadPosition | null {
  const candidates = index.nearbySegments(enu.e, enu.n, config.searchRadiusM);
  if (candidates.length === 0) return null;

  let best: RoadPosition | null = null;
  let bestScore = Infinity;

  for (const seg of candidates) {
    const p = projectOntoSegment(enu.e, enu.n, seg);
    if (p.distanceM > config.searchRadiusM) continue;

    const way = index.getWay(seg.wayId);
    const mismatch = headingMismatchDeg(headingDeg, seg.bearingDeg, way?.oneway === true);

    let score = p.distanceM + config.headingWeightM * (mismatch / 180);
    if (lastWayId !== null && seg.wayId === lastWayId) score -= config.continuityBonusM;

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
): SnapResult {
  const bearingRad = (match.bearingDeg * Math.PI) / 180;
  // Unit vector along the road, and its right-hand normal.
  const alongE = Math.sin(bearingRad);
  const alongN = Math.cos(bearingRad);
  const rightE = alongN;
  const rightN = -alongE;

  // Correction vector, then keep only its cross-road component.
  const de = match.enu.e - enu.e;
  const dn = match.enu.n - enu.n;
  const crossMagnitude = de * rightE + dn * rightN;

  const c = Number.isFinite(confidence) ? confidence : 0;
  const strength = Math.max(
    config.minSnapStrength,
    Math.min(config.maxSnapStrength, 1 - c),
  );

  const applied = crossMagnitude * strength;
  return {
    enu: { e: enu.e + applied * rightE, n: enu.n + applied * rightN },
    strength,
    // Signed the other way round so positive means "we are right of the road".
    crossTrackM: -crossMagnitude,
  };
}
