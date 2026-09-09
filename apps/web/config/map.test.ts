import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolveMapStyle reads NEXT_PUBLIC_MAPTILER_KEY at module load, so each
 * branch needs a fresh module registry rather than a re-import.
 */
async function loadWithKey(key: string | undefined) {
  vi.resetModules();
  if (key === undefined) delete process.env.NEXT_PUBLIC_MAPTILER_KEY;
  else process.env.NEXT_PUBLIC_MAPTILER_KEY = key;
  return import('./map');
}

const ORIGINAL = process.env.NEXT_PUBLIC_MAPTILER_KEY;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_MAPTILER_KEY;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_MAPTILER_KEY;
  else process.env.NEXT_PUBLIC_MAPTILER_KEY = ORIGINAL;
});

describe('resolveMapStyle — no API key', () => {
  it('falls back to a keyless raster basemap instead of failing', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const r = resolveMapStyle();
    expect(r.source).toBe('osm-dark');
    // The demo must work on a machine that has never seen a MapTiler key.
    expect(typeof r.style).toBe('object');
  });

  it('labels the basemap by what it is, not by the key it does not need', async () => {
    // The label is printed in the HUD footer and the Offline panel's "map
    // source" row. "(no API key)" was read there as "an API key is required
    // and missing", so the wording names the data and the renderer instead.
    const { resolveMapStyle } = await loadWithKey(undefined);
    const { label } = resolveMapStyle();
    expect(label).toMatch(/OpenStreetMap/i);
    expect(label).not.toMatch(/api key/i);
  });

  it('exposes no dark-filter flag, because nothing may filter the canvas', async () => {
    // The filter this replaced inverted every layer MapLibre draws, not just
    // the tiles — see the argument in config/map.ts. Re-introducing the flag
    // is how that regression would come back, so its absence is asserted.
    const { resolveMapStyle } = await loadWithKey(undefined);
    expect('needsDarkFilter' in resolveMapStyle()).toBe(false);
  });

  it('emits a valid style spec with a background under the raster layer', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      version: number;
      sources: Record<string, { type: string; tiles: string[]; attribution?: string }>;
      layers: Array<{ id: string; type: string }>;
    };
    expect(style.version).toBe(8);
    expect(style.sources.basemap?.type).toBe('raster');
    expect(style.sources.basemap?.tiles.length).toBeGreaterThan(0);
    // Background first, raster on top — otherwise gaps flash white.
    expect(style.layers[0]?.type).toBe('background');
    expect(style.layers.some((l) => l.id === 'basemap')).toBe(true);
  });

  it('paints the background dark, so a missing tile is a dark hole', async () => {
    // The old background was #0a0e14 and was inverted to near-white by the
    // canvas filter, which is what made every gap in the tile cache flash.
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      layers: Array<{ id: string; paint?: Record<string, unknown> }>;
    };
    const bg = style.layers[0]!.paint!['background-color'] as string;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    expect(Math.max(r!, g!, b!)).toBeLessThan(64);
  });

  it('credits OpenStreetMap, which their tile policy requires', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { attribution?: string }>;
    };
    expect(style.sources.basemap?.attribution).toMatch(/OpenStreetMap/i);
  });

  it('never asks a provider that fails inside the image', async () => {
    // Neither of these returned an error when they broke. CARTO drew "API KEY
    // REQUIRED" across a valid 200 PNG; Esri served a 2,521-byte "Map data not
    // yet available" tile for every z17+ request over India, which is the zoom
    // the app follows at. No status check catches either, so the hosts
    // themselves are what is asserted against.
    const { resolveMapStyle, RASTER_TILE_TEMPLATE, TILE_HOSTS } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    for (const t of [...style.sources.basemap!.tiles, RASTER_TILE_TEMPLATE]) {
      expect(t).not.toContain('basemaps.cartocdn.com');
      expect(t).not.toContain('arcgisonline.com');
    }
    // The glyph host is a different service on the CARTO domain and is still
    // keyless and unwatermarked, so it stays — this asserts tile hosts only.
    expect(TILE_HOSTS.filter((h) => h.endsWith('basemaps.cartocdn.com'))).toEqual([
      'tiles.basemaps.cartocdn.com',
    ]);
  });

  it('asks one host, because the a/b/c subdomains are deprecated', async () => {
    // HTTP/2 multiplexes over a single connection, so sharding buys nothing
    // and only triples the DNS and TLS work against volunteer-run servers.
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    expect(style.sources.basemap!.tiles).toEqual(['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
  });

  it('stops at zoom 19, which is as far as OSM standard renders', async () => {
    // Asking for 20 does not return a sharper tile, it returns a 404 per tile
    // and a hole in the map at exactly the zoom the demo follows through.
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { maxzoom?: number }>;
    };
    expect(style.sources.basemap?.maxzoom).toBe(19);
  });

  it('inverts the raster on its own layer, never on the shared canvas', async () => {
    // The whole argument in config/map.ts: a CSS filter on the canvas also
    // inverted the trail, the road graph and the ellipse, because MapLibre
    // draws all of them into it. Paint properties reach one layer.
    const { resolveMapStyle, BASEMAP_PAINT } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      layers: Array<{ id: string; paint?: Record<string, unknown> }>;
    };
    const raster = style.layers.find((l) => l.id === 'basemap')!;
    expect(raster.paint).toEqual({ ...BASEMAP_PAINT });
  });

  it('★ inverts by setting brightness-min ABOVE brightness-max', async () => {
    // This is the non-obvious part, and the part a well-meaning cleanup would
    // "fix" by swapping them back. MapLibre rescales each channel into
    // [min, max] and does not require min < max, so min 1 / max 0 evaluates
    // 1 - c. Swap them and the map is light again, with no error anywhere.
    const { BASEMAP_PAINT } = await loadWithKey(undefined);
    expect(BASEMAP_PAINT['raster-brightness-min']).toBe(1);
    expect(BASEMAP_PAINT['raster-brightness-max']).toBe(0);
    // Inversion alone leaves every hue opposite: parks come out magenta.
    expect(BASEMAP_PAINT['raster-hue-rotate']).toBe(180);
  });

  it('inverts to something darker than the roads drawn on top of it', async () => {
    // Measured, not assumed: the Connaught Place tile at z15 is mean luma 217,
    // so inverted it is 38 — under OfflineBasemapLayer's #3a4250 road tone at
    // 65, which keeps the light-on-dark relationship that layer asserts.
    const { BASEMAP_PAINT } = await loadWithKey(undefined);
    const OSM_MEAN_LUMA = 217;
    const OFFLINE_ROAD_LUMA = 0.299 * 0x3a + 0.587 * 0x42 + 0.114 * 0x50;
    const min = BASEMAP_PAINT['raster-brightness-min'];
    const max = BASEMAP_PAINT['raster-brightness-max'];
    const inverted = 255 * (min + (OSM_MEAN_LUMA / 255) * (max - min));
    expect(inverted).toBeLessThan(OFFLINE_ROAD_LUMA);
  });

});

describe('resolveMapStyle — with API key', () => {
  it('uses the MapTiler dark vector style', async () => {
    const { resolveMapStyle } = await loadWithKey('test_key_123');
    const r = resolveMapStyle();
    expect(r.source).toBe('maptiler-dark');
    expect(typeof r.style).toBe('string');
    expect(r.style as string).toContain('test_key_123');
    expect(r.style as string).toMatch(/dark/);
  });

  it('treats an empty key as absent rather than building a broken URL', async () => {
    const { resolveMapStyle } = await loadWithKey('');
    expect(resolveMapStyle().source).toBe('osm-dark');
  });
});

describe('map defaults', () => {
  it('centres on Delhi in [lon, lat] order', async () => {
    const { DEFAULT_CENTER } = await loadWithKey(undefined);
    const [lon, lat] = DEFAULT_CENTER;
    // Swapping these is the classic GeoJSON bug — it would put the map at sea.
    expect(lon).toBeGreaterThan(68);
    expect(lon).toBeLessThan(98);
    expect(lat).toBeGreaterThan(6);
    expect(lat).toBeLessThan(38);
  });

  it('zooms in closer once the vehicle is actually located', async () => {
    const { DEFAULT_ZOOM, FOLLOW_ZOOM } = await loadWithKey(undefined);
    expect(FOLLOW_ZOOM).toBeGreaterThan(DEFAULT_ZOOM);
  });
});
