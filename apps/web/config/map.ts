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

export type MapStyleSource = 'maptiler-dark' | 'osm-dark';

export interface ResolvedMapStyle {
  style: StyleSpecification | string;
  source: MapStyleSource;
  label: string;
}

/**
 * ★ THE BASEMAP IS DARKENED ON ITS OWN LAYER, NEVER ON THE CANVAS ★
 *
 * The basemap is OpenStreetMap's standard raster — a LIGHT map — inverted to
 * dark. It was once inverted with a CSS filter on the map canvas:
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
 * so the filter is gone. The inversion is now two raster paint properties on
 * the basemap layer alone — see BASEMAP_PAINT below — and everything drawn on
 * top of it renders in the colour it was authored in.
 *
 * ★ TWO PROVIDERS WERE TRIED IN BETWEEN, AND BOTH FAILED IN THE SAME WAY ★
 * Neither returned an error. Both returned HTTP 200 and a valid PNG.
 *
 * CARTO's dark_matter was the keyless dark basemap here for a release. It
 * still answers keyless — it just draws "API KEY REQUIRED / carto.com/
 * basemaps/apikey" diagonally across every tile now. Nothing throws, no
 * request fails, and the map renders a demand for an account.
 *
 * Esri's Dark Gray Canvas replaced it and lasted a day. Its service metadata
 * advertises levels through z23, and over India it has imagery to z16: at z17
 * and beyond every request returns the same 2,521-byte tile reading "Map data
 * not yet available". The app follows the vehicle at FOLLOW_ZOOM = 17, so the
 * basemap was that placeholder for the whole of a demo. Coverage is regional
 * and the advertised maximum zoom does not describe it.
 *
 * The lesson both times is that a tile provider fails INSIDE THE IMAGE, where
 * no status code, content-type or byte-length check can see it. That is what
 * scripts/measure-tile.mjs reads, and why it reads pixels.
 *
 * So the basemap is OSM standard, whose terms are a usage policy rather than a
 * key that can be revoked, and the light-map problem it comes with is solved
 * per layer instead of per canvas.
 */
/**
 * One host, deliberately.
 *
 * The a/b/c subdomains are deprecated by the OSM operations team — HTTP/2
 * multiplexes over a single connection, so sharding buys nothing and only
 * triples the DNS and TLS work.
 */
const OSM_HOST = 'tile.openstreetmap.org';

/**
 * ★ TILE.OPENSTREETMAP.ORG WILL BLOCK YOU, AND IT BLOCKS YOU IN COLOUR ★
 *
 * These are volunteer-funded servers with a usage policy, and the enforcement
 * is not an HTTP error. A blocked client gets 200 OK and a valid 256×256 PNG
 * that reads "Access blocked — App is not following the tile usage policy of
 * OpenStreetMap's volunteer-run servers: osm.wiki/Blocked". Exactly the shape
 * of the CARTO failure this replaced: the request succeeds, the image decodes,
 * and the map renders a notice instead of a city.
 *
 * What the policy asks of us, and where each part is honoured:
 *
 *   - identify the app in the User-Agent. A browser sends its own, which is
 *     why this works from the app and why scripts/measure-tile.mjs has to set
 *     one explicitly — with a generic UA that script gets the block tile.
 *   - no bulk downloading. The Offline panel caps a pre-cache at
 *     MAX_PRECACHE_TILES over PRECACHE_MIN_ZOOM..PRECACHE_MAX_ZOOM.
 *   - cache what you fetch. public/sw.js does, up to MAX_TILES.
 *   - attribute. The style below does, and the control is always visible.
 *
 * This is a demo at demo volumes and it stays inside that. If the map ever
 * comes up as diagonal stripes and a wall of text, this is the reason, and the
 * fix is a tile provider of our own — not a retry.
 */
const OSM_TILE_TEMPLATE = `https://${OSM_HOST}/{z}/{x}/{y}.png`;

/**
 * ★ THE INVERT LIVES ON THE RASTER LAYER, NOT ON THE CANVAS ★
 *
 * OpenStreetMap's standard style is a LIGHT map — the tile at Connaught Place
 * measures mean luma 217 — and this app is dark. The first attempt at that was
 * a CSS filter on the canvas, and the block comment above records everything
 * it broke, ending in the claim that "MapLibre's raster paint properties have
 * no invert". That claim was wrong, and it is why the app spent a release on a
 * different basemap.
 *
 * MapLibre rescales each channel to [brightness-min, brightness-max]. Nothing
 * requires min < max. Setting min = 1 and max = 0 evaluates 1 - c, which is an
 * invert, and `raster-hue-rotate` then puts the hues back — the same
 * `invert(1) hue-rotate(180deg)` as before, expressed as paint properties.
 *
 * The difference is reach. A CSS filter applies to the canvas, and MapLibre
 * draws the basemap, the offline road graph, the trail, the matched road and
 * the confidence ellipse into ONE canvas, so it inverted all of them. Paint
 * properties apply to the layer they are written on. Everything drawn above
 * this raster keeps the colour it was authored in, which is what the bugs
 * listed above were all asking for.
 *
 * Inverted, the tile measures mean 38 · p95 93, against #0e1116 (17) for the
 * background and #3a4250 (65) for the offline roads that draw on top of it.
 * Re-measure with `node scripts/measure-tile.mjs` before touching these.
 */
export const BASEMAP_PAINT = {
  'raster-brightness-min': 1,
  'raster-brightness-max': 0,
  'raster-hue-rotate': 180,
} as const;

/**
 * The tile template the pre-cache downloads.
 *
 * Exported because the Offline panel has to store the tiles the map will
 * actually ask for. It had its own private copy of the OSM template, so any
 * change here silently left the "download this area" button caching one
 * basemap while the map rendered another — which offline looks exactly like a
 * cache that did not work.
 */
export const RASTER_TILE_TEMPLATE = OSM_TILE_TEMPLATE;

/**
 * Where MapLibre fetches the font atlases that label the offline basemap.
 *
 * ★ A STYLE WITH NO `glyphs` CANNOT DRAW TEXT AT ALL ★
 * Not "draws it badly" — a symbol layer with a `text-field` silently renders
 * nothing, which looks exactly like a layer that was never added. The keyless
 * style is hand-built here, so this is the only place it can come from.
 *
 * This is still CARTO's font endpoint even though the tiles are not: it keeps
 * answering keyless and unwatermarked, and it carries both faces below, which
 * OpenFreeMap's otherwise-equivalent /fonts does not (no Open Sans there).
 * Checked whenever the tiles are — if it ever gates too, that endpoint serves
 * Noto Sans Regular and the stack can drop to one face.
 *
 * Latin fits in one 41 KB range; Devanagari is another 27 KB, fetched only if
 * a road is actually named in it. That is cheap enough to cache outright, and
 * caching it is required — a label that needs the network is not an offline
 * label. See the separate font cache in public/sw.js.
 */
const GLYPHS = 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf';

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
  OSM_HOST,
  // Glyphs, not tiles — a different host, and easy to miss. Without it the
  // labels work online and vanish offline, which is the one place they matter.
  'tiles.basemaps.cartocdn.com',
  'api.maptiler.com',
];

/**
 * Keyless dark raster basemap — no API key, no account, cacheable offline.
 *
 * ★ THE LABEL SAYS WHAT THE MAP IS, NOT WHAT IT LACKS ★
 * This string is printed in the HUD footer and in the Offline panel's "map
 * source" row, so it is the only thing most people ever read about the
 * basemap. It used to be "CARTO dark (no API key)", which was accurate and
 * still misread: a parenthesised "API key" next to a map is taken as a
 * requirement that has not been met, not as the absence of one. It names the
 * data and the styling instead — OpenStreetMap is what the roads are, and it
 * does not ask for a key.
 */
function osmDarkStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [OSM_TILE_TEMPLATE],
        tileSize: 256,
        // OSM standard renders to 19. Asking for 20 does not get a sharper
        // tile, it gets a 404 per tile and a hole in the map at close zoom.
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      // Matches the tiles rather than the HUD: this shows through wherever a
      // tile is missing, and a gap should read as unloaded map, not as a hole.
      { id: 'background', type: 'background', paint: { 'background-color': '#0e1116' } },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        // Scoped to this layer. Never move this to the canvas — see above.
        paint: { ...BASEMAP_PAINT },
      },
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
    style: osmDarkStyle(),
    source: 'osm-dark',
    label: 'OpenStreetMap (dark)',
  };
}
