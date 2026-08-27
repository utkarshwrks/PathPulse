import { latLonToEnu } from '../geo/enu.js';
import type { RoadGraph, RoadWay } from './types.js';

/** One road segment, pre-projected into the engine's ENU frame. */
export interface RoadSegment {
  wayId: string;
  /** Index of this segment's first point within the way. */
  index: number;
  e1: number;
  n1: number;
  e2: number;
  n2: number;
  /** Distance along the way to this segment's start, metres. */
  arcStartM: number;
  lengthM: number;
  /** Bearing from start to end, degrees clockwise from north. */
  bearingDeg: number;
}

export interface RoadIndexConfig {
  /** Grid cell size, metres. */
  cellSizeM: number;
}

export const DEFAULT_ROAD_INDEX_CONFIG: RoadIndexConfig = {
  // 100 m, as the build guide specifies. Large enough that a 50 m query touches
  // at most a 3x3 block of cells; small enough that a cell holds few segments.
  cellSizeM: 100,
};

/**
 * Grid-based spatial index over a road graph.
 *
 * ★ WHY A GRID AND NOT AN R-TREE ★
 * The query is always "what is near this point", never "what intersects this
 * arbitrary polygon", and it runs at every sample inside a 10 Hz budget. A
 * uniform grid answers that in constant time with no tree traversal and no
 * allocation per query, and it is fifty lines instead of five hundred. Phase 14
 * swaps in an R-tree when HMM map matching needs range queries over a whole
 * city rather than a demo bbox.
 *
 * Everything is projected into ENU **once**, at construction, against the same
 * origin the engine uses. Projecting per query would put a trigonometric
 * conversion inside the hot loop for no benefit, and would risk the index and
 * the engine disagreeing about where the origin is.
 */
export class RoadIndex {
  private readonly config: RoadIndexConfig;
  private readonly cells = new Map<string, RoadSegment[]>();
  private readonly waysById = new Map<string, RoadWay>();
  private segmentCount = 0;

  /**
   * @param graph  road graph, in lon/lat
   * @param originLat,originLon the ENU origin — must be the engine's origin
   */
  constructor(
    graph: RoadGraph,
    private readonly originLat: number,
    private readonly originLon: number,
    config: Partial<RoadIndexConfig> = {},
  ) {
    this.config = { ...DEFAULT_ROAD_INDEX_CONFIG, ...config };
    for (const way of graph.ways) this.addWay(way);
  }

  get size(): number {
    return this.segmentCount;
  }

  get wayCount(): number {
    return this.waysById.size;
  }

  getWay(id: string): RoadWay | undefined {
    return this.waysById.get(id);
  }

  private addWay(way: RoadWay): void {
    if (!way.coords || way.coords.length < 2) return;
    this.waysById.set(way.id, way);

    let arc = 0;
    let prev: { e: number; n: number } | null = null;

    for (const [lon, lat] of way.coords) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        // A malformed coordinate breaks the chain: drop it and restart the run
        // rather than drawing a segment across the map to the next good point.
        prev = null;
        continue;
      }
      const p = latLonToEnu(lat, lon, this.originLat, this.originLon);
      if (prev) {
        const dx = p.e - prev.e;
        const dy = p.n - prev.n;
        const len = Math.hypot(dx, dy);
        // Duplicate points appear in OSM data and would give a zero-length
        // segment with an undefined bearing.
        if (len > 0.01) {
          const seg: RoadSegment = {
            wayId: way.id,
            index: this.segmentCount,
            e1: prev.e,
            n1: prev.n,
            e2: p.e,
            n2: p.n,
            arcStartM: arc,
            lengthM: len,
            bearingDeg: normaliseDeg((Math.atan2(dx, dy) * 180) / Math.PI),
          };
          this.insert(seg);
          this.segmentCount++;
          arc += len;
        }
      }
      prev = { e: p.e, n: p.n };
    }
  }

  /**
   * Register a segment in every cell it passes through.
   *
   * Walking the segment rather than just stamping its endpoints matters: a
   * 400 m dual carriageway between two junctions would otherwise be invisible
   * to a query standing in the middle of it, which is exactly where a vehicle
   * usually is.
   */
  private insert(seg: RoadSegment): void {
    const cs = this.config.cellSizeM;
    const steps = Math.max(1, Math.ceil(seg.lengthM / (cs / 2)));
    let lastKey = '';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const e = seg.e1 + (seg.e2 - seg.e1) * t;
      const n = seg.n1 + (seg.n2 - seg.n1) * t;
      const key = this.cellKey(e, n);
      if (key === lastKey) continue;
      lastKey = key;
      const bucket = this.cells.get(key);
      if (bucket) {
        if (!bucket.includes(seg)) bucket.push(seg);
      } else {
        this.cells.set(key, [seg]);
      }
    }
  }

  private cellKey(e: number, n: number): string {
    const cs = this.config.cellSizeM;
    return `${Math.floor(e / cs)},${Math.floor(n / cs)}`;
  }

  /**
   * Segments whose cell block covers a disc of `radiusM` around the point.
   *
   * Returns candidates, not matches: a segment in a neighbouring cell can still
   * be further away than the radius. Caller filters on true distance.
   */
  nearbySegments(e: number, n: number, radiusM: number): RoadSegment[] {
    const cs = this.config.cellSizeM;
    const reach = Math.max(1, Math.ceil(radiusM / cs));
    const ce = Math.floor(e / cs);
    const cn = Math.floor(n / cs);

    const out: RoadSegment[] = [];
    const seen = new Set<number>();
    for (let de = -reach; de <= reach; de++) {
      for (let dn = -reach; dn <= reach; dn++) {
        const bucket = this.cells.get(`${ce + de},${cn + dn}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (seen.has(seg.index)) continue;
          seen.add(seg.index);
          out.push(seg);
        }
      }
    }
    return out;
  }
}

/** Wrap to [0, 360). */
export function normaliseDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Smallest signed difference a - b, in [-180, 180). */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
