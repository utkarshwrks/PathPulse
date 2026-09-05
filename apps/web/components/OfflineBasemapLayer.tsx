'use client';

import { useEffect, useMemo } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { RoadGraph } from '@pathpulse/nav-core';
import { useMap } from './MapContext';

const SOURCE_ID = 'offline-basemap';
const CASING_ID = 'offline-basemap-casing';
const LINE_ID = 'offline-basemap-line';

interface OfflineBasemapLayerProps {
  graph: RoadGraph | null;
}

/**
 * The basemap, drawn from the road graph instead of downloaded as pictures.
 *
 * ★ THE MAP THAT COSTS NOTHING, BECAUSE IT IS ALREADY HERE ★
 *
 * Field report, repeatedly: "I switch off the internet and the map doesn't
 * load... it's blank... this is the biggest drawback, because the whole point
 * is that it works offline." Entirely fair — an offline navigation system that
 * shows a grey rectangle has failed the only test that matters.
 *
 * The obvious fix is to pre-download map tiles, and it is a bad one. Measured
 * for a 100 km radius at street-level zoom that is roughly 10,400 raster tiles
 * — about 150 MB — which is more than the rest of the app by two orders of
 * magnitude, has to be re-downloaded whenever the user goes somewhere new, and
 * is 150 MB of PICTURES OF ROADS.
 *
 * We already have the roads. The estimator cannot work without them: snapping,
 * map matching and the particle filter all read `RoadGraph`, so the geometry of
 * every road around the vehicle is in memory whenever navigation is working at
 * all. Rendering it is free. Measured on the Jabalpur graph — 9,462 ways over
 * 143 km² of dense city — the same coverage is:
 *
 *   raster tiles, z11-14 .......... ~150 MB
 *   road graph, compact + gzip .... ~190 KB      (~800x smaller)
 *
 * So this layer draws them. No download, no cache, no tile server, and it
 * cannot go stale independently of the data the estimator is using, because it
 * IS that data — which also makes it an honest picture: a road drawn here is a
 * road the matcher can actually snap to, and a blank area is genuinely an area
 * the estimator knows nothing about. A raster basemap will happily show a
 * street the graph has never heard of.
 *
 * ★ WHY IT IS ALWAYS ON, AND UNDERNEATH ★
 *
 * There is no online/offline switch here, deliberately. The layer is inserted
 * BELOW the raster tiles, which are opaque, so while tiles are arriving they
 * simply cover it and nothing changes visually. When a tile is missing — no
 * network, a gap in the cache, a region never visited — MapLibre draws nothing
 * for it and these roads show through the hole.
 *
 * That is worth more than a mode switch, because the failure it fixes was never
 * clean: the reported bug is tiles that vanish and do not come back, and
 * partially-cached areas where some tiles load and others do not. Detecting
 * "are we offline" answers the wrong question — `navigator.onLine` is true on a
 * connection that carries nothing, which is exactly what a dead cell area is.
 * Being underneath means the map degrades tile by tile instead of all at once,
 * and needs no detection at all.
 */

/** Road classes, thickest first. Anything unlisted draws as a minor road. */
const CLASS_WIDTHS: Record<string, number> = {
  motorway: 1,
  trunk: 0.9,
  primary: 0.8,
  secondary: 0.65,
  tertiary: 0.55,
  unclassified: 0.4,
  residential: 0.4,
  service: 0.28,
  // Drawn only. Thin, because they are context rather than the subject.
  track: 0.2,
  path: 0.16,
  footway: 0.16,
  cycleway: 0.16,
  steps: 0.14,
  pedestrian: 0.2,
};

/** Strip the OSM `_link` suffix so slip roads inherit their parent's weight. */
function baseClass(highway: string | undefined): string {
  if (!highway) return 'residential';
  return highway.endsWith('_link') ? highway.slice(0, -5) : highway;
}

function toGeoJson(graph: RoadGraph) {
  return {
    type: 'FeatureCollection' as const,
    features: graph.ways.map((w) => ({
      type: 'Feature' as const,
      // `weight` is precomputed rather than expressed as a MapLibre `match`
      // expression on the class string: one number interpolated by zoom is far
      // cheaper to evaluate per frame than a string lookup across ~9,500
      // features, and this layer redraws on every camera move.
      properties: {
        weight: CLASS_WIDTHS[baseClass(w.highway)] ?? 0.4,
        // Drawn, never matched. A footpath at full road weight would make a
        // neighbourhood look like a motorway junction, and would also imply the
        // estimator could snap to it — which it cannot. See RoadWay.renderOnly.
        renderOnly: w.renderOnly === true ? 1 : 0,
      },
      geometry: { type: 'LineString' as const, coordinates: w.coords },
    })),
  };
}

/**
 * The id of the layer these should be drawn beneath.
 *
 * Anything that is not the background — the first real content layer, whether
 * that is the OSM raster or MapTiler's own vector styling. Returning undefined
 * appends, which is the correct fallback: visible, just over the top.
 */
function firstContentLayerId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type !== 'background') return l.id;
  }
  return undefined;
}

export default function OfflineBasemapLayer({ graph }: OfflineBasemapLayerProps) {
  const map = useMap();

  const data = useMemo(() => (graph ? toGeoJson(graph) : null), [graph]);

  useEffect(() => {
    if (!map || !data) return;

    const ensure = () => {
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, { type: 'geojson', data });

      const before = firstContentLayerId(map);

      // Two strokes, like a real basemap: a darker casing under a lighter
      // fill. Without the casing, roads meeting at a junction merge into an
      // indistinct blob and the result reads as a scribble rather than a map.
      map.addLayer(
        {
          id: CASING_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#000000',
            'line-opacity': 0.9,
            'line-width': [
              'interpolate',
              ['exponential', 2],
              ['zoom'],
              10,
              ['*', ['get', 'weight'], 1.5],
              17,
              ['*', ['get', 'weight'], 18],
            ],
          },
        },
        before,
      );
      map.addLayer(
        {
          id: LINE_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            // Close to the raster basemap's own road colour, so the seam
            // between a cached tile and a drawn road is not a visible edge.
            // Render-only ways sit back visually: present enough to recognise a
            // neighbourhood by, never bright enough to read as a road the
            // vehicle might be on.
            'line-color': ['case', ['==', ['get', 'renderOnly'], 1], '#2b313b', '#3a4250'],
            'line-width': [
              'interpolate',
              ['exponential', 2],
              ['zoom'],
              10,
              ['*', ['get', 'weight'], 0.8],
              17,
              ['*', ['get', 'weight'], 13],
            ],
          },
        },
        before,
      );
    };

    if (map.isStyleLoaded()) ensure();
    else map.once('styledata', ensure);

    const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (src) src.setData(data);

    return () => {
      // Guarded: the map may already be torn down, and removing a layer that
      // is not there throws rather than no-opping.
      try {
        if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
        if (map.getLayer(CASING_ID)) map.removeLayer(CASING_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Nothing to clean up.
      }
    };
  }, [map, data]);

  return null;
}
