import { describe, expect, it } from 'vitest';
import {
  countTilesForBounds,
  estimateBytes,
  formatBytes,
  lonLatToTileXY,
  MAX_PRECACHE_TILES,
  MERCATOR_MAX_LAT,
  tileUrl,
  tilesForBounds,
} from './tileCache';

/**
 * Tile arithmetic.
 *
 * The aeroplane-mode demo is only as good as this list. A box that enumerates
 * the wrong tiles downloads happily, reports success, and then shows a blank
 * map on stage with the radios off — the failure arrives minutes after the
 * mistake, in front of the people it matters to.
 */

const JABALPUR = { north: 23.19, south: 23.15, east: 79.99, west: 79.95 };

describe('lonLatToTileXY', () => {
  it('puts the origin at the top-left of the world at zoom 0', () => {
    const { x, y } = lonLatToTileXY(-180, MERCATOR_MAX_LAT, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('puts (0, 0) at the centre', () => {
    const { x, y } = lonLatToTileXY(0, 0, 1);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(1, 6);
  });

  it('★ clamps beyond the Mercator limit instead of returning Infinity', () => {
    // tan(90°) is infinite. Without the clamp a bounds that touches the pole
    // produces an infinite tile index, and the loop below it never ends.
    for (const lat of [90, -90, 89.9, -89.9]) {
      const { y } = lonLatToTileXY(0, lat, 10);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('matches a known slippy-map tile', () => {
    // Greenwich at zoom 10 is tile 511/340 in the standard scheme.
    const { x, y } = lonLatToTileXY(0.0, 51.5, 10);
    expect(Math.floor(x)).toBe(512);
    expect(Math.floor(y)).toBe(340);
  });
});

describe('tileUrl', () => {
  it('substitutes z, x and y', () => {
    expect(tileUrl('https://t/{z}/{x}/{y}.png', { z: 12, x: 5, y: 9 })).toBe(
      'https://t/12/5/9.png',
    );
  });
});

describe('tilesForBounds', () => {
  it('covers a small area across a zoom range', () => {
    const tiles = tilesForBounds(JABALPUR, 12, 14);
    expect(tiles.length).toBeGreaterThan(3);
    for (const t of tiles) {
      expect(t.z).toBeGreaterThanOrEqual(12);
      expect(t.z).toBeLessThanOrEqual(14);
      expect(Number.isInteger(t.x)).toBe(true);
      expect(Number.isInteger(t.y)).toBe(true);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(Math.pow(2, t.z));
      expect(t.y).toBeLessThan(Math.pow(2, t.z));
    }
  });

  it('orders coarsest first, so an interrupted download still leaves a map', () => {
    const tiles = tilesForBounds(JABALPUR, 12, 15);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i]!.z).toBeGreaterThanOrEqual(tiles[i - 1]!.z);
    }
  });

  it('emits no duplicates', () => {
    const tiles = tilesForBounds(JABALPUR, 12, 15);
    const seen = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    expect(seen.size).toBe(tiles.length);
  });

  it('grows roughly fourfold per zoom level', () => {
    const z13 = tilesForBounds(JABALPUR, 13, 13).length;
    const z15 = tilesForBounds(JABALPUR, 15, 15).length;
    expect(z15).toBeGreaterThan(z13 * 4);
  });

  it('★ does not enumerate the whole world across the antimeridian', () => {
    // A box from 179.9E to -179.9E is 0.2 degrees wide. Walking x numerically
    // from west to east would instead walk the long way round the planet —
    // at zoom 14, some 16,000 columns of tiles.
    const tiles = tilesForBounds(
      { north: 1, south: -1, east: -179.9, west: 179.9 },
      10,
      10,
      Number.MAX_SAFE_INTEGER,
    );
    expect(tiles.length).toBeLessThan(40);
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(Math.pow(2, 10));
    }
  });

  it('accepts a box given corners-swapped rather than returning nothing', () => {
    const normal = tilesForBounds(JABALPUR, 13, 13);
    const flipped = tilesForBounds(
      { north: JABALPUR.south, south: JABALPUR.north, east: JABALPUR.east, west: JABALPUR.west },
      13,
      13,
    );
    expect(flipped.length).toBe(normal.length);
  });

  it('★ respects the cap, so one bad viewport cannot queue 100k requests', () => {
    const world = { north: 80, south: -80, east: 180, west: -180 };
    const tiles = tilesForBounds(world, 0, 12);
    expect(tiles.length).toBeLessThanOrEqual(MAX_PRECACHE_TILES);
  });

  it('terminates on a bounds touching the pole', () => {
    const tiles = tilesForBounds({ north: 90, south: 89, east: 1, west: 0 }, 10, 10);
    expect(Array.isArray(tiles)).toBe(true);
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('returns nothing for non-finite input rather than looping', () => {
    expect(tilesForBounds({ north: NaN, south: 0, east: 1, west: 0 }, 12, 14)).toEqual([]);
    expect(tilesForBounds(JABALPUR, NaN, 14)).toEqual([]);
    expect(tilesForBounds(JABALPUR, 12, Infinity)).toEqual([]);
  });

  it('returns nothing when the zoom range is inverted', () => {
    expect(tilesForBounds(JABALPUR, 15, 12)).toEqual([]);
  });

  it('clamps an absurd zoom rather than producing 2^40 tiles', () => {
    const tiles = tilesForBounds(JABALPUR, 40, 40);
    expect(tiles.length).toBeLessThanOrEqual(MAX_PRECACHE_TILES);
    for (const t of tiles) expect(t.z).toBeLessThanOrEqual(22);
  });

  it('handles a zero-area bounds as a single tile per zoom', () => {
    const point = { north: 23.17, south: 23.17, east: 79.97, west: 79.97 };
    expect(tilesForBounds(point, 14, 14)).toHaveLength(1);
  });
});

describe('countTilesForBounds', () => {
  it('counts past the cap, because the honest answer is the real number', () => {
    const world = { north: 80, south: -80, east: 180, west: -180 };
    expect(countTilesForBounds(world, 0, 12)).toBeGreaterThan(MAX_PRECACHE_TILES);
  });

  it('★ counts a huge area arithmetically instead of running out of memory', () => {
    // This is called on every viewport change. The first version enumerated
    // the list and took its length, so zooming out far enough asked it to
    // materialise billions of objects — the tab died before it could render
    // the number that was meant to warn the area was too big. If this
    // regresses, the whole worker crashes rather than failing an assertion.
    const world = { north: 85, south: -85, east: 180, west: -180 };
    const started = Date.now();
    const count = countTilesForBounds(world, 0, 18);
    expect(count).toBeGreaterThan(1e9);
    expect(Number.isFinite(count)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('agrees with the enumerated list for a small area', () => {
    const enumerated = tilesForBounds(JABALPUR, 12, 15, Number.MAX_SAFE_INTEGER).length;
    expect(countTilesForBounds(JABALPUR, 12, 15)).toBe(enumerated);
  });

  it('is zero for junk input', () => {
    expect(countTilesForBounds({ north: NaN, south: 0, east: 1, west: 0 }, 12, 14)).toBe(0);
    expect(countTilesForBounds(JABALPUR, 15, 12)).toBe(0);
  });
});

describe('estimateBytes / formatBytes', () => {
  it('scales with tile count', () => {
    expect(estimateBytes(100)).toBe(100 * 20 * 1024);
    expect(estimateBytes(0)).toBe(0);
    expect(estimateBytes(-5)).toBe(0);
  });

  it('reads as a size a person can act on', () => {
    expect(formatBytes(0)).toBe('0 kB');
    expect(formatBytes(50 * 1024)).toBe('50 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(NaN)).toBe('0 kB');
  });
});
