/**
 * Slippy-map tile arithmetic, for pre-caching an area before it is needed.
 *
 * ★ WHY THIS EXISTS ★
 * The demo's strongest moment is aeroplane mode: the vehicle keeps navigating
 * with every radio off. That only lands if the *map* is still there too, and a
 * basemap streamed from tile.openstreetmap.org is not. Browsing the area once
 * beforehand and hoping the right tiles got cached is not a plan — it fails
 * silently, on stage, and looks exactly like the app being broken.
 *
 * So the area is enumerated deliberately and fetched on request. This file is
 * the arithmetic half: which tiles cover a bounding box, at which zooms, and
 * how many that is before anyone commits to downloading them. No browser APIs,
 * so it is unit tested rather than trusted.
 */

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface LatLonBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Web Mercator cannot represent the poles, and clamps at this latitude — the
 * value where the projected map becomes square. Feeding it anything beyond
 * produces an infinite y.
 */
export const MERCATOR_MAX_LAT = 85.05112878;

/**
 * Hard ceiling on a single pre-cache request.
 *
 * A bounding box one zoom level too wide is thousands of tiles, which is tens
 * of megabytes, several minutes, and a tile server that will rightly start
 * refusing. Better to refuse locally, with a number, than to half-download an
 * area and believe it is covered.
 */
export const MAX_PRECACHE_TILES = 1500;

const clampLat = (lat: number): number =>
  Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));

/** Longitude/latitude to fractional tile coordinates at a zoom level. */
export function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const clampedLat = clampLat(lat);
  const latRad = (clampedLat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Substitute {z}/{x}/{y} into a tile URL template. */
export function tileUrl(template: string, tile: TileCoord): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/**
 * Every tile covering `bounds` between `minZoom` and `maxZoom` inclusive.
 *
 * Returns them ordered from the coarsest zoom outwards, so a download that is
 * interrupted partway still leaves a usable — if blurry — map rather than a
 * sharp patch surrounded by nothing.
 */
interface ZoomRange {
  z: number;
  n: number;
  xStart: number;
  /** Number of columns, already accounting for an antimeridian wrap. */
  columns: number;
  yMin: number;
  yMax: number;
}

/** The tile index ranges covering `bounds` at each zoom, or [] for junk input. */
function zoomRanges(bounds: LatLonBounds, minZoom: number, maxZoom: number): ZoomRange[] {
  if (
    !Number.isFinite(bounds.north) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(minZoom) ||
    !Number.isFinite(maxZoom)
  ) {
    return [];
  }

  // Accept a box given either way round rather than silently returning
  // nothing: a caller that swaps north and south gets the area they meant.
  const north = Math.max(bounds.north, bounds.south);
  const south = Math.min(bounds.north, bounds.south);
  const lo = Math.max(0, Math.min(22, Math.floor(minZoom)));
  const hi = Math.max(0, Math.min(22, Math.floor(maxZoom)));
  if (hi < lo) return [];

  const ranges: ZoomRange[] = [];
  for (let z = lo; z <= hi; z++) {
    const n = Math.pow(2, z);
    const topLeft = lonLatToTileXY(bounds.west, north, z);
    const bottomRight = lonLatToTileXY(bounds.east, south, z);

    // Both ends need clamping into [0, n-1], not just one. At exactly the
    // Mercator limit the projection lands a hair below zero — floor() turns
    // that into -1, `yMax` stays -1, and the row loop never runs: a bounds
    // touching the pole silently yields no tiles at all. Clamping only the
    // top hides it, because the top is the end that reads as obviously wrong.
    const yMin = Math.max(0, Math.min(n - 1, Math.floor(topLeft.y)));
    const yMax = Math.max(0, Math.min(n - 1, Math.floor(bottomRight.y)));

    // A box crossing the antimeridian has west > east. Walking x from west to
    // east numerically would enumerate the entire rest of the world instead of
    // the strip actually wanted, so wrap through the seam explicitly.
    const xStart = Math.floor(topLeft.x);
    const xEnd = Math.floor(bottomRight.x);
    const columns = (xEnd >= xStart ? xEnd - xStart : n - xStart + xEnd) + 1;

    ranges.push({ z, n, xStart, columns, yMin, yMax });
  }
  return ranges;
}

export function tilesForBounds(
  bounds: LatLonBounds,
  minZoom: number,
  maxZoom: number,
  limit = MAX_PRECACHE_TILES,
): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (const r of zoomRanges(bounds, minZoom, maxZoom)) {
    for (let i = 0; i < r.columns; i++) {
      const x = (((r.xStart + i) % r.n) + r.n) % r.n;
      for (let y = r.yMin; y <= r.yMax; y++) {
        if (tiles.length >= limit) return tiles;
        tiles.push({ z: r.z, x, y });
      }
    }
  }
  return tiles;
}

/**
 * How many tiles an area would cost, without building the list.
 *
 * ★ ARITHMETIC, NOT ENUMERATION ★
 * This used to call `tilesForBounds` with an unbounded limit and take the
 * length. The panel calls it on every viewport change, so zooming out far
 * enough asked it to materialise an array of billions of objects — the tab
 * died before it could render the number that was meant to warn the user the
 * area was too big. The count is a product of two ranges; it never needed the
 * list.
 *
 * Counts past the cap on purpose: the honest answer to "how big is this area"
 * is the real number, even when it is refused.
 */
export function countTilesForBounds(
  bounds: LatLonBounds,
  minZoom: number,
  maxZoom: number,
): number {
  let total = 0;
  for (const r of zoomRanges(bounds, minZoom, maxZoom)) {
    total += r.columns * (r.yMax - r.yMin + 1);
  }
  return total;
}

/** Rough download size for a raster tile set. OSM PNGs average ~20 KB. */
export function estimateBytes(tileCount: number): number {
  return Math.max(0, Math.round(tileCount * 20 * 1024));
}

/** "25.4 MB" / "812 kB" — for a confirmation the user can act on. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 kB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
