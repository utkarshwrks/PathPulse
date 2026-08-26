import type { StyleSpecification } from 'maplibre-gl';

/**
 * Map style configuration.
 *
 * Deliberately behind a single function so Phase 9 can swap in an offline
 * PMTiles basemap without touching MapView. The key never gets hardcoded —
 * it comes from NEXT_PUBLIC_MAPTILER_KEY, and the app degrades to plain
 * OpenStreetMap raster tiles if it is missing.
 */

export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';

/** Default view: Connaught Place, Delhi. Only used until the first fix. */
export const DEFAULT_CENTER: [number, number] = [77.2167, 28.6315];
export const DEFAULT_ZOOM = 15;
/** Zoom used once we actually know where the vehicle is. */
export const FOLLOW_ZOOM = 17;

export type MapStyleSource = 'maptiler-dark' | 'osm-raster';

export interface ResolvedMapStyle {
  style: StyleSpecification | string;
  source: MapStyleSource;
  /** Raster OSM tiles are light; we darken them in CSS to match the HUD. */
  needsDarkFilter: boolean;
  label: string;
}

/** OpenStreetMap raster fallback — no API key, no account, works offline once cached. */
function osmRasterStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a0e14' } },
      { id: 'osm', type: 'raster', source: 'osm' },
    ],
  };
}

export function resolveMapStyle(): ResolvedMapStyle {
  if (MAPTILER_KEY) {
    return {
      style: `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${MAPTILER_KEY}`,
      source: 'maptiler-dark',
      needsDarkFilter: false,
      label: 'MapTiler dark (vector)',
    };
  }
  return {
    style: osmRasterStyle(),
    source: 'osm-raster',
    needsDarkFilter: true,
    label: 'OpenStreetMap raster (no API key)',
  };
}
