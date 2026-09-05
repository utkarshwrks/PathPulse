import {
  approxDistanceM,
  cellKey,
  cellsCovering,
  INNER_RADIUS_M,
  OUTER_RADIUS_M,
  type Lod,
} from './graphCells';
import type { GraphCellStore } from './graphCellStore';

/**
 * Coverage that follows the vehicle, and storage that stays flat while it does.
 *
 * ★ THE REQUIREMENT ★
 * "Even 100 km of map doesn't take any weight on the device... after it passes
 * 20 to 40 km then again 100 km radius, so now user can use it."
 *
 * Two halves. Coverage must move ahead of the vehicle so the disc is always
 * useful, and everything the vehicle has left behind must be released so a long
 * drive does not fill the phone. Neither is worth much without the other: a
 * disc that moves without evicting fills the device on a cross-country drive,
 * and eviction without movement leaves the vehicle driving off the edge of its
 * own coverage.
 */

/** How far the vehicle must get from the anchor before coverage re-centres. */
export const RETARGET_DISTANCE_M = 20_000;

/**
 * How far ahead of the vehicle the new anchor is placed.
 *
 * ★ COVERAGE SHOULD LEAD, NOT SURROUND ★
 * Anchoring on the current position spends half the disc on ground already
 * driven. Placing it ahead along the heading buys road the vehicle has not
 * reached yet, which is the only part that can still be needed. It also
 * supplies most of the hysteresis for free: immediately after re-anchoring the
 * vehicle is this far from the anchor and closing, so it must cover the lead
 * plus the retarget distance before the question is asked again.
 */
export const ANCHOR_LEAD_M = 10_000;

/**
 * Shortest interval between re-anchors, ms.
 *
 * ★ THE STORM THIS PREVENTS ★
 * Geometry alone is not enough hysteresis. A vehicle that turns around just
 * after re-anchoring is immediately moving away from an anchor placed ahead of
 * its old heading, so the distance test passes again within a minute, and each
 * re-anchor discards the in-flight queue and rebuilds it. The result is a
 * prefetcher that never completes a cell while issuing a steady stream of
 * Overpass requests — the exact behaviour that gets an application blocked.
 */
export const MIN_REANCHOR_INTERVAL_MS = 120_000;

export interface Anchor {
  lat: number;
  lon: number;
  atMs: number;
}

export interface RollResult {
  reanchored: boolean;
  anchor: Anchor | null;
  evicted: number;
  bytesAfter: number;
}

export class RollingCoverage {
  private anchor: Anchor | null = null;

  constructor(
    private readonly store: GraphCellStore,
    private readonly retargetM = RETARGET_DISTANCE_M,
    private readonly leadM = ANCHOR_LEAD_M,
    private readonly minIntervalMs = MIN_REANCHOR_INTERVAL_MS,
  ) {}

  get current(): Anchor | null {
    return this.anchor;
  }

  /** Would this position move the anchor? Pure, so the caller can test it. */
  shouldReanchor(lat: number, lon: number, nowMs: number): boolean {
    if (!this.anchor) return true;
    if (nowMs - this.anchor.atMs < this.minIntervalMs) return false;
    return approxDistanceM(lat, lon, this.anchor.lat, this.anchor.lon) > this.retargetM;
  }

  /** Where the anchor goes: ahead along the heading, or here if unknown. */
  anchorFor(lat: number, lon: number, headingDeg: number | null, nowMs: number): Anchor {
    if (headingDeg === null || !Number.isFinite(headingDeg)) {
      return { lat, lon, atMs: nowMs };
    }
    const rad = (headingDeg * Math.PI) / 180;
    const dLat = (this.leadM * Math.cos(rad)) / 110_574;
    const dLon = (this.leadM * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
    return { lat: lat + dLat, lon: lon + dLon, atMs: nowMs };
  }

  /**
   * Advance coverage for the current position, evicting what is behind.
   *
   * ★ EVICTION IS MEASURED FROM THE VEHICLE, NOT THE ANCHOR ★
   * The anchor is deliberately ahead, so evicting relative to it would discard
   * cells still within reach behind the vehicle — including, on a U-turn, the
   * road it is about to drive back along. The disc that is fetched leads; the
   * disc that is kept is centred on where the vehicle actually is.
   */
  async roll(
    lat: number,
    lon: number,
    headingDeg: number | null,
    nowMs: number,
  ): Promise<RollResult> {
    const reanchored = this.shouldReanchor(lat, lon, nowMs);
    if (reanchored) this.anchor = this.anchorFor(lat, lon, headingDeg, nowMs);

    // Never evict what is underfoot: at both levels of detail, because the
    // engine may be reading either. Losing the cell the estimator is snapping
    // to right now would disengage matching mid-drive for no observable reason.
    const keep: string[] = [];
    for (const lod of ['full', 'major'] as Lod[]) {
      for (const cell of cellsCovering(lat, lon, 1, lod)) keep.push(cellKey(cell, lod));
    }

    const { removed, bytesAfter } = await this.store.evict(lat, lon, OUTER_RADIUS_M, { keep });
    return { reanchored, anchor: this.anchor, evicted: removed, bytesAfter };
  }

  reset(): void {
    this.anchor = null;
  }
}

/**
 * Why there is no LOD demotion here, despite it being the obvious design.
 *
 * A cell leaving the inner ring holds FULL detail, and the "correct" thing
 * looks like replacing it with a major-only version to save space. It is not:
 * full is a strict superset of major, so the exchange spends an Overpass
 * request to obtain strictly less data, and leaves a window in which the area
 * is covered by neither. Keeping it until it either leaves the 100 km disc or
 * loses to the size cap is cheaper, simpler, and never worse — and the LOD
 * budget has the room, because the whole disc is single-digit MB.
 *
 * Promotion, the other direction, is not needed either: a cell entering the
 * inner ring is planned at full detail by planCells, which does not find a
 * `full` entry for it and fetches one. The stale major copy is then redundant
 * and is evicted on distance or size like anything else.
 */
export const LOD_DEMOTION_IS_DELIBERATELY_ABSENT = true;

export { INNER_RADIUS_M, OUTER_RADIUS_M };
