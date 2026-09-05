import type { RoadGraph, RoadWay } from '@pathpulse/nav-core';
import { lonLatToTileXY, MERCATOR_MAX_LAT } from './tileCache';

/**
 * The worldwide cell grid that offline coverage is addressed in.
 *
 * ★ WHY A GRID AND NOT A LIST OF BOXES ★
 *
 * lib/roadGraphStore.ts stores one graph per bounding box and answers "do I
 * have this area?" with bboxContains over every stored entry. That works for
 * the three areas this project shipped with and fails for rolling worldwide
 * coverage in two ways at once: overlapping boxes store the same road several
 * times, and the coverage question becomes a linear scan that grows with every
 * region ever visited.
 *
 * A fixed grid fixes both. A cell is either present or it is not, the question
 * is a key lookup, and no road is stored twice — because the grid, not the
 * user's route, decides the boundaries.
 *
 * ★ WHY SLIPPY-MAP TILES SPECIFICALLY ★
 *
 * Because tileCache.ts already computes them, and because the addressing is
 * identical everywhere on Earth. That is the whole answer to "not only for
 * Jabalpur": there is no region list, no bundled index to be missing from, and
 * no special case at any latitude or longitude. A user opening the app in a
 * village nobody has ever tested in gets the same cells by the same arithmetic.
 *
 * ★ TWO LEVELS OF DETAIL, AND WHY IT IS THE WHOLE BUDGET ★
 *
 * Measured on the Jabalpur graph, road classes are not evenly weighted:
 *
 *   residential ......... 73.2 % of nodes
 *   service ............. 10.4 %
 *   tertiary .............. 7.3 %
 *   major (motorway/trunk/primary/secondary + links) ... 4.8 %
 *
 * Detail is almost entirely local streets, and local streets 80 km away are
 * worthless — the vehicle cannot reach one for an hour, and coverage will have
 * rolled by then. So the inner ring carries every class and the outer ring
 * carries only the majors, which is what turns a 100 km radius from ~41 MB into
 * ~3.5 MB at dense-city density, and considerably less in real terrain.
 */

/** Which classes a cell was fetched with. */
export type Lod = 'full' | 'major';

/**
 * Zoom per level of detail.
 *
 * ★ BOTH VALUES COME FROM MEASURED OVERPASS RESPONSE SIZES ★
 *
 * z13 is ~4.5 km across at this latitude, so ~20 km² — just inside the 25 km²
 * full-detail cap, which is itself set by a full query returning 1.8 MB in 10 s.
 *
 * z9 is ~72 km across, so ~5,200 km², which sounds reckless and is not: a
 * major-roads-only query over 10,000 km² measured 3.1 MB in 2.0 seconds. The
 * outer ring is filtered to eight classes carrying under 5 % of the nodes, so
 * area is nearly free there.
 *
 * The consequence is the whole feature's affordability. A 100 km radius is:
 *   outer ring, z9  ..... about 9 cells    (was 97 at z11)
 *   inner ring, z13 ..... about 81 cells
 * against the twelve hundred a uniform 25 km² grid would have needed.
 */
export const LOD_ZOOM: Record<Lod, number> = { full: 13, major: 9 };

/** Radius, metres, inside which cells are held at full detail. */
export const INNER_RADIUS_M = 20_000;
/** Radius, metres, of the whole coverage disc. */
export const OUTER_RADIUS_M = 100_000;

/**
 * The classes an outer-ring cell is fetched with.
 *
 * Deliberately the same list the ablation's road graphs treat as major, so an
 * outer cell promoted to the inner ring is a strict superset rather than a
 * different graph.
 */
export const MAJOR_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
] as const;

export interface CellId {
  z: number;
  x: number;
  y: number;
}

/** Stable string form, usable as a database key. */
export function cellKey(c: CellId, lod: Lod): string {
  return `${lod}/${c.z}/${c.x}/${c.y}`;
}

export function parseCellKey(key: string): { cell: CellId; lod: Lod } | null {
  const parts = key.split('/');
  if (parts.length !== 4) return null;
  const [lod, z, x, y] = parts;
  if (lod !== 'full' && lod !== 'major') return null;
  const nz = Number(z);
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isInteger(nz) || !Number.isInteger(nx) || !Number.isInteger(ny)) return null;
  return { cell: { z: nz, x: nx, y: ny }, lod };
}

/** Metres per degree of longitude at a given latitude. */
function metresPerLonDeg(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

const METRES_PER_LAT_DEG = 110_574;

/** Tile x wrapped into [0, 2^z), so a query spanning the antimeridian works. */
function wrapX(x: number, z: number): number {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}

/**
 * Every cell whose tile intersects the disc of `radiusM` around a point.
 *
 * ★ THE ANTIMERIDIAN IS NOT AN EDGE CASE, IT IS A PLACE ★
 * Longitude wraps and tile x must wrap with it, or a user near +/-180 gets a
 * coverage set clipped at the seam — which would be a bug reachable only by
 * someone in Fiji or the Chukotka coast, i.e. one nobody would ever reproduce.
 * Latitude does NOT wrap: Mercator is undefined past ~85 degrees, so y is
 * clamped instead, which is the correct treatment of a genuine boundary.
 */
export function cellsCovering(lat: number, lon: number, radiusM: number, lod: Lod): CellId[] {
  const z = LOD_ZOOM[lod];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) return [];

  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const dLat = radiusM / METRES_PER_LAT_DEG;
  // Guard the pole: cos(lat) tends to zero and the longitude span blows up.
  const mPerLon = Math.max(1, metresPerLonDeg(clampedLat));
  const dLon = radiusM / mPerLon;

  const north = Math.min(MERCATOR_MAX_LAT, clampedLat + dLat);
  const south = Math.max(-MERCATOR_MAX_LAT, clampedLat - dLat);

  // lonLatToTileXY returns FRACTIONAL tile coordinates — it is written for
  // computing tile ranges, not for naming one tile — so these must be floored
  // before they are used as identities.
  const topLeft = lonLatToTileXY(lon - dLon, north, z);
  const bottomRight = lonLatToTileXY(lon + dLon, south, z);

  const n = 2 ** z;
  const y0 = Math.floor(Math.min(topLeft.y, bottomRight.y));
  const y1 = Math.floor(Math.max(topLeft.y, bottomRight.y));
  const yMin = Math.max(0, y0);
  const yMax = Math.min(n - 1, y1);

  const xStart = Math.floor(topLeft.x);
  const xEnd = Math.floor(bottomRight.x);
  // Width in tiles, computed before wrapping, so a span crossing the seam is
  // still a span rather than a range from 0 to n-1.
  const rawSpan = xEnd - xStart + 1;
  const spanX = dLon * 2 >= 360 ? n : Math.min(n, rawSpan > 0 ? rawSpan : rawSpan + n);

  const cells: CellId[] = [];
  for (let i = 0; i < spanX; i++) {
    const x = wrapX(xStart + i, z);
    for (let y = yMin; y <= yMax; y++) cells.push({ z, x, y });
  }
  return cells;
}

/** Great-circle-ish distance in metres. Flat earth is fine at these ranges. */
export function approxDistanceM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = (bLat - aLat) * METRES_PER_LAT_DEG;
  const dLon = (bLon - aLon) * metresPerLonDeg((aLat + bLat) / 2);
  return Math.hypot(dLat, dLon);
}

/** Centre of a cell, in degrees. */
export function cellCentre(c: CellId): { lat: number; lon: number } {
  const n = 2 ** c.z;
  const lon = ((c.x + 0.5) / n) * 360 - 180;
  const t = Math.PI - 2 * Math.PI * ((c.y + 0.5) / n);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  return { lat, lon };
}

/** Bounding box of a cell as [minLon, minLat, maxLon, maxLat]. */
export function cellBBox(c: CellId): [number, number, number, number] {
  const n = 2 ** c.z;
  const lonMin = (c.x / n) * 360 - 180;
  const lonMax = ((c.x + 1) / n) * 360 - 180;
  const latOf = (y: number) => {
    const t = Math.PI - 2 * Math.PI * (y / n);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  return [lonMin, latOf(c.y + 1), lonMax, latOf(c.y)];
}

/**
 * Merge decoded cells into the single graph the engine consumes.
 *
 * ★ DEDUPE IS NOT AN OPTIMISATION HERE ★
 * Overpass returns the WHOLE way for any way intersecting the query box, so a
 * road crossing a cell boundary arrives complete in both cells. Concatenating
 * would hand RoadIndex two identical ways with the same id, and that is not
 * merely wasteful: findRoadMatch's continuity bonus keys on wayId, and the
 * scorer would see the same road twice at the same distance — one copy winning
 * arbitrarily, and `lastWayId` matching a way that may not be the one scored
 * next sample. Duplicated geometry is a matching bug wearing the costume of a
 * memory problem.
 *
 * The first copy of an id wins. Cells are merged inner-first by the caller, so
 * "first" means the fullest available version of the way.
 */
export function mergeGraphs(graphs: readonly RoadGraph[]): RoadGraph {
  const seen = new Set<string>();
  const ways: RoadWay[] = [];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const g of graphs) {
    for (const w of g.ways) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      ways.push(w);
    }
    if (g.bbox) {
      minLon = Math.min(minLon, g.bbox[0]);
      minLat = Math.min(minLat, g.bbox[1]);
      maxLon = Math.max(maxLon, g.bbox[2]);
      maxLat = Math.max(maxLat, g.bbox[3]);
    }
  }

  const bbox: [number, number, number, number] = Number.isFinite(minLon)
    ? [minLon, minLat, maxLon, maxLat]
    : [0, 0, 0, 0];
  return { bbox, ways };
}

/** Which level of detail a cell should be held at, given the vehicle's position. */
export function lodFor(distanceM: number): Lod | null {
  if (distanceM <= INNER_RADIUS_M) return 'full';
  if (distanceM <= OUTER_RADIUS_M) return 'major';
  return null;
}
