import { describe, expect, it } from 'vitest';
import type { RoadGraph, RoadWay } from '@pathpulse/nav-core';
import {
  cellsCovering,
  cellKey,
  parseCellKey,
  cellCentre,
  cellBBox,
  approxDistanceM,
  mergeGraphs,
  lodFor,
  LOD_ZOOM,
  INNER_RADIUS_M,
  OUTER_RADIUS_M,
} from './graphCells';
import {
  GraphCellStore,
  MemoryCellBackend,
  requestPersistentStorage,
} from './graphCellStore';

/**
 * The cell grid and its store.
 *
 * ★ WHY THIS IS TESTED HEADLESSLY AND HEAVILY ★
 * This is the layer that makes offline coverage work anywhere on Earth rather
 * than only where someone happened to test. Every failure mode it has is
 * geographic — the antimeridian, the poles, the southern hemisphere — and none
 * of them is reachable from a desk in Jabalpur. If they are not covered here
 * they are not covered at all.
 */

const JABALPUR = { lat: 23.1686, lon: 79.9339 };

function way(id: string, coords: Array<[number, number]>, extra: Partial<RoadWay> = {}): RoadWay {
  return { id, coords, ...extra };
}
function graphOf(ways: RoadWay[], bbox: RoadGraph['bbox'] = [79.8, 23.1, 80.0, 23.3]): RoadGraph {
  return { bbox, ways };
}

describe('cell addressing', () => {
  it('round-trips a cell key', () => {
    const parsed = parseCellKey(cellKey({ z: 13, x: 5901, y: 3653 }, 'full'));
    expect(parsed).toEqual({ cell: { z: 13, x: 5901, y: 3653 }, lod: 'full' });
  });

  it('rejects malformed keys instead of guessing', () => {
    expect(parseCellKey('nonsense')).toBeNull();
    expect(parseCellKey('full/13/5901')).toBeNull();
    expect(parseCellKey('bogus/13/1/1')).toBeNull();
    expect(parseCellKey('full/13/x/1')).toBeNull();
  });

  it('uses the configured zoom per level of detail', () => {
    expect(cellsCovering(JABALPUR.lat, JABALPUR.lon, 1000, 'full')[0]!.z).toBe(LOD_ZOOM.full);
    expect(cellsCovering(JABALPUR.lat, JABALPUR.lon, 1000, 'major')[0]!.z).toBe(LOD_ZOOM.major);
  });

  it('returns integer tile coordinates', () => {
    // lonLatToTileXY returns FRACTIONAL tiles; using them unfloored would make
    // every cell key unique and the store would never register a hit.
    for (const c of cellsCovering(JABALPUR.lat, JABALPUR.lon, 5000, 'full')) {
      expect(Number.isInteger(c.x)).toBe(true);
      expect(Number.isInteger(c.y)).toBe(true);
    }
  });

  it('covers a bigger radius with more cells, and a point with at least one', () => {
    const one = cellsCovering(JABALPUR.lat, JABALPUR.lon, 100, 'full');
    const many = cellsCovering(JABALPUR.lat, JABALPUR.lon, 40_000, 'full');
    expect(one.length).toBeGreaterThanOrEqual(1);
    expect(many.length).toBeGreaterThan(one.length);
  });

  it('the covering set actually contains the queried point', () => {
    const cells = cellsCovering(JABALPUR.lat, JABALPUR.lon, 1000, 'full');
    const hit = cells.some((c) => {
      const [minLon, minLat, maxLon, maxLat] = cellBBox(c);
      return (
        JABALPUR.lon >= minLon &&
        JABALPUR.lon <= maxLon &&
        JABALPUR.lat >= minLat &&
        JABALPUR.lat <= maxLat
      );
    });
    expect(hit).toBe(true);
  });

  it('★ works in every hemisphere, not just the one we live in', () => {
    const places = [
      { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
      { name: 'Quito', lat: -0.1807, lon: -78.4678 },
      { name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
      { name: 'Jabalpur', lat: 23.1686, lon: 79.9339 },
    ];
    for (const p of places) {
      const cells = cellsCovering(p.lat, p.lon, 5000, 'full');
      expect(cells.length, p.name).toBeGreaterThan(0);
      const hit = cells.some((c) => {
        const [minLon, minLat, maxLon, maxLat] = cellBBox(c);
        return p.lon >= minLon && p.lon <= maxLon && p.lat >= minLat && p.lat <= maxLat;
      });
      expect(hit, p.name).toBe(true);
    }
  });

  it('★ wraps across the antimeridian rather than clipping at the seam', () => {
    // A user at +179.99 must get cells on both sides. Without wrapping, the
    // span is computed as negative and collapses — a bug only reachable from
    // Fiji, which is to say never reproduced and always present.
    const cells = cellsCovering(-16.5, 179.99, 30_000, 'major');
    const n = 2 ** LOD_ZOOM.major;
    const xs = new Set(cells.map((c) => c.x));
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(n);
    }
    // Cells from both ends of the x range, which is what "wrapped" looks like.
    expect([...xs].some((x) => x < 10) && [...xs].some((x) => x > n - 10)).toBe(true);
  });

  it('does not explode near the poles', () => {
    const cells = cellsCovering(89.9, 10, 50_000, 'major');
    const n = 2 ** LOD_ZOOM.major;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(n * n);
    for (const c of cells) {
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThan(n);
    }
  });

  it('returns nothing for nonsense input rather than throwing', () => {
    expect(cellsCovering(Number.NaN, 0, 1000, 'full')).toEqual([]);
    expect(cellsCovering(0, 0, 0, 'full')).toEqual([]);
    expect(cellsCovering(0, 0, -5, 'full')).toEqual([]);
  });

  it('cellCentre lands inside cellBBox', () => {
    for (const c of cellsCovering(JABALPUR.lat, JABALPUR.lon, 20_000, 'major')) {
      const { lat, lon } = cellCentre(c);
      const [minLon, minLat, maxLon, maxLat] = cellBBox(c);
      expect(lon).toBeGreaterThanOrEqual(minLon);
      expect(lon).toBeLessThanOrEqual(maxLon);
      expect(lat).toBeGreaterThanOrEqual(minLat);
      expect(lat).toBeLessThanOrEqual(maxLat);
    }
  });
});

describe('level of detail', () => {
  it('assigns full detail inside the inner ring and major beyond it', () => {
    expect(lodFor(0)).toBe('full');
    expect(lodFor(INNER_RADIUS_M - 1)).toBe('full');
    expect(lodFor(INNER_RADIUS_M + 1)).toBe('major');
    expect(lodFor(OUTER_RADIUS_M - 1)).toBe('major');
    expect(lodFor(OUTER_RADIUS_M + 1)).toBeNull();
  });
});

describe('mergeGraphs', () => {
  it('★ dedupes a way that straddles a cell boundary', () => {
    // Overpass returns the WHOLE way for anything intersecting the query box,
    // so a road crossing a boundary arrives complete in both cells. Two copies
    // with one id would give findRoadMatch the same road twice at the same
    // distance, and lastWayId could then match a copy that is not the one
    // scored next sample — a matching bug dressed as a memory problem.
    const a = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]]), way('w2', [[79.9, 23.1], [79.91, 23.11]])]);
    const b = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]]), way('w3', [[80.0, 23.2], [80.1, 23.3]])]);
    const merged = mergeGraphs([a, b]);
    expect(merged.ways.map((w) => w.id).sort()).toEqual(['w1', 'w2', 'w3']);
  });

  it('keeps the first copy, so inner-first merging keeps the fullest version', () => {
    const full = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]], { highway: 'residential', maxspeed: 30 })]);
    const major = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]], { highway: 'residential' })]);
    const merged = mergeGraphs([full, major]);
    expect(merged.ways).toHaveLength(1);
    expect(merged.ways[0]!.maxspeed).toBe(30);
  });

  it('unions the bounding boxes', () => {
    const merged = mergeGraphs([
      graphOf([way('a', [[0, 0], [1, 1]])], [0, 0, 1, 1]),
      graphOf([way('b', [[2, 2], [3, 3]])], [2, 2, 3, 3]),
    ]);
    expect(merged.bbox).toEqual([0, 0, 3, 3]);
  });

  it('handles an empty list', () => {
    expect(mergeGraphs([]).ways).toEqual([]);
  });
});

describe('GraphCellStore', () => {
  const cell = (x: number, y: number) => ({ z: LOD_ZOOM.major, x, y });

  function storeAt(maxBytes?: number) {
    return new GraphCellStore(new MemoryCellBackend(), maxBytes);
  }

  it('stores and retrieves a cell through the compact codec', async () => {
    const s = storeAt();
    const g = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]], { highway: 'primary', oneway: true })]);
    expect(await s.has(cell(1, 1), 'major')).toBe(false);
    await s.put(cell(1, 1), 'major', g);
    expect(await s.has(cell(1, 1), 'major')).toBe(true);
    const back = await s.get(cell(1, 1), 'major');
    expect(back!.ways[0]!.id).toBe('w1');
    expect(back!.ways[0]!.oneway).toBe(true);
  });

  it('keeps the two levels of detail apart', async () => {
    const s = storeAt();
    await s.put(cell(1, 1), 'major', graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]])]));
    expect(await s.has(cell(1, 1), 'major')).toBe(true);
    expect(await s.has(cell(1, 1), 'full')).toBe(false);
  });

  it('★ deletes a corrupt cell rather than reporting the area as covered', async () => {
    // A truncated write can only be corruption, the codec refuses to guess at
    // it, and leaving it in place would tell the prefetcher this area is done
    // while every read of it throws.
    const backend = new MemoryCellBackend();
    const s = new GraphCellStore(backend);
    await backend.put({
      key: 'major/11/1/1',
      lod: 'major',
      bytes: new Uint8Array([1, 2, 3]),
      fetchedAt: 0,
      lastUsedAt: 0,
    });
    expect(await s.get(cell(1, 1), 'major')).toBeNull();
    expect(await s.has(cell(1, 1), 'major')).toBe(false);
  });

  it('evicts cells outside the radius', async () => {
    const s = storeAt();
    const near = cellsCovering(JABALPUR.lat, JABALPUR.lon, 1000, 'major')[0]!;
    const far = cellsCovering(-33.8688, 151.2093, 1000, 'major')[0]!;
    const g = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]])]);
    await s.put(near, 'major', g);
    await s.put(far, 'major', g);

    const res = await s.evict(JABALPUR.lat, JABALPUR.lon, OUTER_RADIUS_M);
    expect(res.removed).toBe(1);
    expect(await s.has(near, 'major')).toBe(true);
    expect(await s.has(far, 'major')).toBe(false);
  });

  it('★ never evicts a cell named in keep, whatever the cap says', async () => {
    // The cell under the vehicle. Evicting it removes the graph the estimator
    // is snapping to at that instant, and snapping disengaging mid-drive for no
    // observable reason is far worse than being briefly over a self-imposed cap.
    const s = storeAt(1); // cap of one byte: everything is over budget
    const here = cellsCovering(JABALPUR.lat, JABALPUR.lon, 500, 'major')[0]!;
    await s.put(here, 'major', graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]])]));
    await s.evict(JABALPUR.lat, JABALPUR.lon, OUTER_RADIUS_M, { keep: [cellKey(here, 'major')] });
    expect(await s.has(here, 'major')).toBe(true);
  });

  it('trims to the size cap, oldest-used first', async () => {
    const s = storeAt(1);
    const cells = cellsCovering(JABALPUR.lat, JABALPUR.lon, 30_000, 'major').slice(0, 3);
    expect(cells.length).toBeGreaterThanOrEqual(2);
    const g = graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]])]);
    for (let i = 0; i < cells.length; i++) await s.put(cells[i]!, 'major', g, 1000 + i);

    await s.evict(JABALPUR.lat, JABALPUR.lon, OUTER_RADIUS_M);
    // Over cap with nothing kept: everything goes, oldest first.
    expect(await s.totalBytes()).toBeLessThanOrEqual(1);
  });

  it('reports total bytes', async () => {
    const s = storeAt();
    expect(await s.totalBytes()).toBe(0);
    await s.put(cell(1, 1), 'major', graphOf([way('w1', [[79.9, 23.1], [79.95, 23.15]])]));
    expect(await s.totalBytes()).toBeGreaterThan(0);
  });

  it('drops entries whose key is not ours', async () => {
    const backend = new MemoryCellBackend();
    const s = new GraphCellStore(backend);
    await backend.put({
      key: 'garbage',
      lod: 'major',
      bytes: new Uint8Array([1]),
      fetchedAt: 0,
      lastUsedAt: 0,
    });
    const res = await s.evict(JABALPUR.lat, JABALPUR.lon, OUTER_RADIUS_M);
    expect(res.removed).toBe(1);
  });
});

describe('requestPersistentStorage', () => {
  it('reports unsupported rather than throwing when the API is absent', async () => {
    // jsdom has no StorageManager. The caller must be able to surface "we could
    // not ask" as distinct from "we asked and were refused".
    await expect(requestPersistentStorage()).resolves.toBe('unsupported');
  });
});

describe('approxDistanceM', () => {
  it('is zero at a point and grows with separation', () => {
    expect(approxDistanceM(23.1, 79.9, 23.1, 79.9)).toBe(0);
    const near = approxDistanceM(23.1, 79.9, 23.11, 79.9);
    const far = approxDistanceM(23.1, 79.9, 23.2, 79.9);
    expect(far).toBeGreaterThan(near);
    // One hundredth of a degree of latitude is about 1.1 km.
    expect(near).toBeGreaterThan(900);
    expect(near).toBeLessThan(1300);
  });
});
