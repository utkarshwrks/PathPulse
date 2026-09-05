import type { StyleSpecification } from 'maplibre-gl';

/**
 * Map style configuration.
 *
 * Deliberately behind a single function so Phase 9 can swap in an offline
 * PMTiles basemap without touching MapView. The key never gets hardcoded —
 * it comes from NEXT_PUBLIC_MAPTILER_KEY, and the app degrades to a keyless
 * dark raster basemap if it is missing.
 */

export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';

/** Default view: Connaught Place, Delhi. Only used until the first fix. */
export const DEFAULT_CENTER: [number, number] = [77.2167, 28.6315];
export const DEFAULT_ZOOM = 15;
/** Zoom used once we actually know where the vehicle is. */
export const FOLLOW_ZOOM = 17;

export type MapStyleSource = 'maptiler-dark' | 'carto-dark';

export interface ResolvedMapStyle {
  style: StyleSpecification | string;
  source: MapStyleSource;
  label: string;
}

/**
 * ★ THE BASEMAP IS DARK AT SOURCE, NOT DARKENED AFTERWARDS ★
 *
 * The keyless fallback used to be OpenStreetMap's standard raster — which is a
 * LIGHT map — inverted back to dark with a CSS filter on the map canvas:
 *
 *     .map-dark-filter .maplibregl-canvas { filter: invert(1) hue-rotate(180deg) ... }
 *
 * That filter cannot tell a tile from anything else. MapLibre draws the raster,
 * the offline road graph, the trail, the matched road and the confidence
 * ellipse into ONE canvas, so inverting the canvas inverted all of them. Every
 * consequence of that was a reported bug:
 *
 *   - the offline basemap is authored dark (#3a4250 on a black casing) so that
 *     it matches the HUD; inverted, it drew as pale roads on a near-white
 *     ground — "the downloaded roads should be in dark mode"
 *   - the background, #0a0e14, inverted to #f5f1eb, so every gap in the tile
 *     cache was a white hole rather than a dark one
 *   - the trail's green, #22c55e, came out as neither green nor any other mode
 *     colour, while the vehicle marker — a DOM element, outside the canvas and
 *     therefore unfiltered — stayed correct. A green marker on a trail that is
 *     not green is exactly the disagreement config/modes.ts exists to prevent.
 *
 * There is no way to exempt a layer from a CSS filter on the canvas they share,
 * and MapLibre's raster paint properties have no invert. So the filter is gone
 * and the tiles are dark to begin with: CARTO's dark_matter, built from the
 * same OpenStreetMap data, keyless and free at demo volumes. Everything we draw
 * on top now renders in the colour it was authored in.
 *
 * As a side effect this also takes the app off tile.openstreetmap.org, whose
 * tile usage policy asks that apps not use it as their basemap.
 */
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'] as const;

/**
 * The tile template the pre-cache downloads.
 *
 * Exported because the Offline panel has to store the tiles the map will
 * actually ask for. It had its own private copy of the OSM template, so any
 * change here silently left the "download this area" button caching one
 * basemap while the map rendered another — which offline looks exactly like a
 * cache that did not work.
 */
export const RASTER_TILE_TEMPLATE = `https://${CARTO_SUBDOMAINS[0]}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`;

/**
 * Where MapLibre fetches the font atlases that label the offline basemap.
 *
 * ★ A STYLE WITH NO `glyphs` CANNOT DRAW TEXT AT ALL ★
 * Not "draws it badly" — a symbol layer with a `text-field` silently renders
 * nothing, which looks exactly like a layer that was never added. The keyless
 * style is hand-built here, so this is the only place it can come from.
 *
 * Latin fits in one 41 KB range; Devanagari is another 27 KB, fetched only if
 * a road is actually named in it. That is cheap enough to cache outright, and
 * caching it is required — a label that needs the network is not an offline
 * label. See the separate font cache in public/sw.js.
 */
const CARTO_GLYPHS = 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf';

/**
 * The font stack the basemap labels with.
 *
 * Two faces, because road names are not all Latin: MapLibre composites the
 * stack, so a name in Devanagari falls through to Noto rather than rendering
 * as a row of empty boxes. Both are served by the endpoint above.
 */
export const LABEL_FONT = ['Open Sans Regular', 'Noto Sans Regular'];

/** Hosts the service worker is allowed to cache. Kept beside the template. */
export const TILE_HOSTS = [
  ...CARTO_SUBDOMAINS.map((s) => `${s}.basemaps.cartocdn.com`),
  'basemaps.cartocdn.com',
  // Glyphs, not tiles — a different host, and easy to miss. Without it the
  // labels work online and vanish offline, which is the one place they matter.
  'tiles.basemaps.cartocdn.com',
  'api.maptiler.com',
];

/** Keyless dark raster basemap — no API key, no account, cacheable offline. */
function cartoDarkStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: CARTO_GLYPHS,
    sources: {
      carto: {
        type: 'raster',
        tiles: CARTO_SUBDOMAINS.map(
          (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`,
        ),
        tileSize: 256,
        maxzoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [
      // Matches the tiles rather than the HUD: this shows through wherever a
      // tile is missing, and a gap should read as unloaded map, not as a hole.
      { id: 'background', type: 'background', paint: { 'background-color': '#0e1116' } },
      { id: 'carto', type: 'raster', source: 'carto' },
    ],
  };
}

export function resolveMapStyle(): ResolvedMapStyle {
  if (MAPTILER_KEY) {
    return {
      style: `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${MAPTILER_KEY}`,
      source: 'maptiler-dark',
      label: 'MapTiler dark (vector)',
    };
  }
  return {
    style: cartoDarkStyle(),
    source: 'carto-dark',
    label: 'CARTO dark (no API key)',
  };
}
