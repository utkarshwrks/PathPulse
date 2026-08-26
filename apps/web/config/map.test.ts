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
  it('falls back to OSM raster instead of failing', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const r = resolveMapStyle();
    expect(r.source).toBe('osm-raster');
    // The demo must work on a machine that has never seen a MapTiler key.
    expect(typeof r.style).toBe('object');
  });

  it('asks for the CSS dark filter, because raster OSM tiles are light', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    expect(resolveMapStyle().needsDarkFilter).toBe(true);
  });

  it('emits a valid style spec with a background under the raster layer', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      version: number;
      sources: Record<string, { type: string; tiles: string[]; attribution?: string }>;
      layers: Array<{ id: string; type: string }>;
    };
    expect(style.version).toBe(8);
    expect(style.sources.osm?.type).toBe('raster');
    expect(style.sources.osm?.tiles.length).toBeGreaterThan(0);
    // Background first, raster on top — otherwise gaps flash white.
    expect(style.layers[0]?.type).toBe('background');
    expect(style.layers.some((l) => l.id === 'osm')).toBe(true);
  });

  it('credits OpenStreetMap, which their tile policy requires', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { attribution?: string }>;
    };
    expect(style.sources.osm?.attribution).toMatch(/OpenStreetMap/i);
  });

  it('uses several subdomains to avoid serialising tile requests', async () => {
    const { resolveMapStyle } = await loadWithKey(undefined);
    const style = resolveMapStyle().style as {
      sources: Record<string, { tiles: string[] }>;
    };
    expect(style.sources.osm!.tiles.length).toBeGreaterThanOrEqual(2);
    for (const t of style.sources.osm!.tiles) {
      expect(t).toContain('{z}/{x}/{y}');
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

  it('skips the CSS filter — the vector style is already dark', async () => {
    const { resolveMapStyle } = await loadWithKey('test_key_123');
    expect(resolveMapStyle().needsDarkFilter).toBe(false);
  });

  it('treats an empty key as absent rather than building a broken URL', async () => {
    const { resolveMapStyle } = await loadWithKey('');
    expect(resolveMapStyle().source).toBe('osm-raster');
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
