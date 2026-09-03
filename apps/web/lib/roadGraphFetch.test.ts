import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MAX_AREA_SQ_KM,
  RoadGraphFetchError,
  areaSqKm,
  bboxAround,
  boundsToBBox,
  buildOverpassQuery,
  fetchRoadGraph,
  osmToGraph,
  parseMaxspeed,
  type OsmElement,
} from './roadGraphFetch';

/**
 * Downloading a road graph for wherever the vehicle actually is.
 *
 * The bundled graphs cover three bounding boxes chosen months ago. Anywhere
 * else, road snapping silently does nothing — and road snapping is what keeps
 * the marker on the road during an outage. You cannot commit a graph for a
 * location you do not know yet, so it has to be fetchable on the spot.
 */

afterEach(() => vi.unstubAllGlobals());

const JABALPUR = { minLon: 79.92, minLat: 23.15, maxLon: 79.95, maxLat: 23.18 };

describe('bounding boxes', () => {
  it('measures area in square kilometres', () => {
    // ~3.1 x 3.3 km at this latitude.
    const a = areaSqKm(JABALPUR);
    expect(a).toBeGreaterThan(8);
    expect(a).toBeLessThan(12);
  });

  it('builds a box of the requested radius around a point', () => {
    const b = bboxAround(23.16, 79.93, 2000);
    // 4 km across each way, so 16 km^2.
    expect(areaSqKm(b)).toBeGreaterThan(14);
    expect(areaSqKm(b)).toBeLessThan(18);
    expect(b.minLat).toBeLessThan(23.16);
    expect(b.maxLat).toBeGreaterThan(23.16);
  });

  it('converts map bounds without swapping an axis', () => {
    // ★ THE CLASSIC ★ north/south are latitudes and east/west longitudes, and
    // a transposition here would silently query the wrong hemisphere.
    const b = boundsToBBox({ north: 23.18, south: 23.15, east: 79.95, west: 79.92 });
    expect(b).toEqual(JABALPUR);
  });
});

describe('the Overpass query', () => {
  it('asks for the bbox in Overpass order — south, west, north, east', () => {
    const q = buildOverpassQuery(JABALPUR);
    expect(q).toContain('(23.15,79.92,23.18,79.95)');
  });

  it('asks only for road classes a vehicle can be on', () => {
    const q = buildOverpassQuery(JABALPUR);
    expect(q).toContain('motorway');
    expect(q).toContain('residential');
    expect(q).toContain('service');
    // A car is not on a footpath, and offering one as a candidate lets the
    // matcher snap the vehicle onto the pavement beside its actual road.
    expect(q).not.toContain('footway');
    expect(q).not.toContain('cycleway');
  });

  it('returns geometry inline, so no second pass resolves node ids', () => {
    expect(buildOverpassQuery(JABALPUR)).toContain('out geom');
  });
});

describe('parseMaxspeed', () => {
  it('reads plain km/h', () => {
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('60 km/h')).toBe(60);
  });

  it('converts mph', () => {
    expect(parseMaxspeed('30 mph')).toBe(48);
  });

  it('refuses free text rather than inventing a limit', () => {
    // A wrong speed limit is worse than none: it clamps the estimate to a
    // speed the vehicle is not doing, and that error integrates.
    expect(parseMaxspeed('RU:urban')).toBeUndefined();
    expect(parseMaxspeed('none')).toBeUndefined();
    expect(parseMaxspeed(undefined)).toBeUndefined();
  });
});

describe('osmToGraph', () => {
  const osm: { elements: OsmElement[] } = {
    elements: [
      {
        type: 'way',
        id: 1,
        geometry: [
          { lat: 23.16, lon: 79.93 },
          { lat: 23.161, lon: 79.931 },
        ],
        tags: { highway: 'primary', name: 'Main Road', maxspeed: '50', oneway: 'yes' },
      },
      // A node, not a way — must be ignored.
      { type: 'node', id: 2 },
      // A degenerate way with one point — cannot form a segment.
      { type: 'way', id: 3, geometry: [{ lat: 23.16, lon: 79.93 }], tags: {} },
    ],
  };

  it('keeps the ways and drops what cannot be a road', () => {
    const g = osmToGraph(osm, JABALPUR);
    expect(g.ways).toHaveLength(1);
    expect(g.ways[0]!.id).toBe('w1');
    expect(g.ways[0]!.name).toBe('Main Road');
    expect(g.ways[0]!.maxspeed).toBe(50);
    expect(g.ways[0]!.oneway).toBe(true);
  });

  it('stores coordinates as [lon, lat], the order nav-core expects', () => {
    const g = osmToGraph(osm, JABALPUR);
    const [lon, lat] = g.ways[0]!.coords[0]!;
    expect(lon).toBeCloseTo(79.93, 5);
    expect(lat).toBeCloseTo(23.16, 5);
  });

  it('treats oneway="-1" as two-way rather than backwards', () => {
    // "-1" is one-way AGAINST the drawn direction. Recording it as one-way in
    // the drawn direction would be worse than not recording it at all.
    const g = osmToGraph(
      {
        elements: [
          {
            type: 'way',
            id: 9,
            geometry: [
              { lat: 23.16, lon: 79.93 },
              { lat: 23.161, lon: 79.931 },
            ],
            tags: { highway: 'residential', oneway: '-1' },
          },
        ],
      },
      JABALPUR,
    );
    expect(g.ways[0]!.oneway).toBeUndefined();
  });
});

describe('fetchRoadGraph', () => {
  it('refuses an area too large to be polite about', async () => {
    const huge = bboxAround(23.16, 79.93, 20_000);
    expect(areaSqKm(huge)).toBeGreaterThan(MAX_AREA_SQ_KM);
    await expect(fetchRoadGraph(huge)).rejects.toBeInstanceOf(RoadGraphFetchError);
  });

  it('returns a graph on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          elements: [
            {
              type: 'way',
              id: 7,
              geometry: [
                { lat: 23.16, lon: 79.93 },
                { lat: 23.161, lon: 79.931 },
              ],
              tags: { highway: 'primary' },
            },
          ],
        }),
      }),
    );
    const g = await fetchRoadGraph(JABALPUR);
    expect(g.ways).toHaveLength(1);
    expect(g.bbox).toEqual([79.92, 23.15, 79.95, 23.18]);
  });

  it('tries the second mirror when the first fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          elements: [
            {
              type: 'way',
              id: 8,
              geometry: [
                { lat: 23.16, lon: 79.93 },
                { lat: 23.161, lon: 79.931 },
              ],
              tags: { highway: 'primary' },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRoadGraph(JABALPUR)).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an empty answer rather than storing a graph with no roads', async () => {
    // A graph with no ways is indistinguishable at runtime from having no
    // graph at all, except that it stops anything else being downloaded.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) }));
    await expect(fetchRoadGraph(JABALPUR)).rejects.toThrow(/no roads/i);
  });

  it('says the mirrors failed rather than throwing something opaque', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchRoadGraph(JABALPUR)).rejects.toThrow(/mirror/i);
  });
});
