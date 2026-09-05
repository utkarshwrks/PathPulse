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
    expect(r.source).toBe('carto-dark');
    // The demo must work on a machine that has never seen a MapTiler key.
    expect(typeof r.style).toBe('object');
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
    expect(style.sources.carto?.type).toBe('raster');
    expect(style.sources.carto?.tiles.length).toBeGreaterThan(0);
    // Background first, raster on top — otherwise gaps flash white.
    expect(style.layers[0]?.type).toBe('background');
    expect(style.layers.some((l) => l.id === 'carto')).toBe(true);
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
    expect(style.sources.carto?.attribution).toMatch(/OpenStreetMap/i);
  });

  it('credits CARTO, whose basemap this is', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { attribution?: string }>;
    };
    expect(style.sources.carto?.attribution).toMatch(/CARTO/i);
  });

  it('uses several subdomains to avoid serialising tile requests', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    expect(style.sources.carto!.tiles.length).toBeGreaterThanOrEqual(2);
    for (const t of style.sources.carto!.tiles) {
      expect(t).toContain('{z}/{x}/{y}');
    }
  });

  it('pre-caches the same tiles the map renders', async () => {
    // These were two independent literals, and the Offline panel's copy still
    // named OpenStreetMap after the map had moved on — which stores one
    // basemap and draws another, and offline is indistinguishable from a
    // cache that silently did not work.
    const { resolveMapStyle, RASTER_TILE_TEMPLATE } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    const host = new URL(RASTER_TILE_TEMPLATE.replace(/\{[zxy]\}/g, '0')).hostname;
    const hosts = style.sources.carto!.tiles.map(
      (t) => new URL(t.replace(/\{[zxy]\}/g, '0')).hostname,
    );
    expect(hosts).toContain(host);
  });

  it('lets the service worker cache every subdomain the style requests', async () => {
    const { resolveMapStyle, TILE_HOSTS } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    for (const t of style.sources.carto!.tiles) {
      expect(TILE_HOSTS).toContain(new URL(t.replace(/\{[zxy]\}/g, '0')).hostname);
    }
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
    expect(resolveMapStyle().source).toBe('carto-dark');
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
