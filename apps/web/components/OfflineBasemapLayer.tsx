'use client';

import { useEffect, useMemo } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { RoadGraph } from '@pathpulse/nav-core';
import { LABEL_FONT } from '@/config/map';
import { useMap } from './MapContext';

const SOURCE_ID = 'offline-basemap';
const CASING_ID = 'offline-basemap-casing';
const LINE_ID = 'offline-basemap-line';
const LABEL_ID = 'offline-basemap-label';

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

/**
 * ★ THE PALETTE IS MEASURED FROM THE TILES, NOT CHOSEN ★
 *
 * Sampled from a CARTO dark_matter tile, by pixel share:
 *
 *   #090909   95 %   ground
 *   #101010          built-up fill
 *   #abacad          major road fill
 *   #545556 / #414243 / #2e2f2f   descending road classes
 *
 * Which settles a question that used to be answered backwards. These roads
 * were authored DARK — #3a4250 on a black casing — on the reasoning that a
 * dark map wants dark roads. A dark basemap does the opposite: the ground is
 * near-black and the roads are the light part. Drawn dark on #090909 they were
 * very nearly invisible, and the only reason they showed at all was the CSS
 * filter inverting them, which is the accident this is no longer relying on.
 *
 * So the tones below run light-on-dark, matched to the classes CARTO itself
 * uses, and the casing is darker than the ground rather than equal to it —
 * that is what separates two roads meeting at a junction.
 */
const ROAD_TONES = {
  /** Motorway through secondary — CARTO's brightest road fill. */
  major: '#abacad',
  /** Tertiary, unclassified, residential. */
  minor: '#6e6f70',
  /** Service roads and car parks. Present, clearly subordinate. */
  service: '#4a4b4c',
  /**
   * Footways, tracks, paths. Drawn, never matched.
   *
   * Dim on purpose: bright enough to recognise a neighbourhood by, never
   * bright enough to read as a road the vehicle might be on. See renderOnly.
   */
  renderOnly: '#33363a',
  /** Under everything, so junctions read as junctions rather than as a blob. */
  casing: '#050505',
} as const;

/** Which tone a class draws in. Anything unlisted is a minor road. */
const CLASS_TONES: Record<string, string> = {
  motorway: ROAD_TONES.major,
  trunk: ROAD_TONES.major,
  primary: ROAD_TONES.major,
  secondary: ROAD_TONES.major,
  service: ROAD_TONES.service,
};

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
        // Resolved here for the same reason as `weight`: one literal colour per
        // feature beats a `match` expression evaluating a string across ~9,500
        // features on every camera move.
        tone:
          w.renderOnly === true
            ? ROAD_TONES.renderOnly
            : (CLASS_TONES[baseClass(w.highway)] ?? ROAD_TONES.minor),
        // Drawn, never matched. A footpath at full road weight would make a
        // neighbourhood look like a motorway junction, and would also imply the
        // estimator could snap to it — which it cannot. See RoadWay.renderOnly.
        renderOnly: w.renderOnly === true ? 1 : 0,
        // ★ THE LABEL, WHICH IS WHY THE CODEC NOW KEEPS NAMES ★
        // Empty rather than absent: MapLibre's `text-field` renders '' as no
        // label, so unnamed ways need no filter of their own.
        name: w.name ?? '',
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
            'line-color': ROAD_TONES.casing,
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
            // Resolved per feature in toGeoJson, from the tones measured off a
            // real tile. Close to the basemap's own road colour, so the seam
            // between a cached tile and a drawn road is not a visible edge.
            'line-color': ['get', 'tone'],
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

      /*
       * ★ THE NAMES WE WERE ALREADY DOWNLOADING AND THROWING AWAY ★
       *
       * `roadGraphFetch` has always asked Overpass for tags and kept
       * `tags.name`, so every downloaded way arrived carrying its street name —
       * and nothing had ever drawn one. Offline the map was a diagram of
       * unlabelled lines, which tells you the shape of a junction and not which
       * road you are on. That is the difference between a picture of a city and
       * a map you can navigate by, and it cost no extra bytes to fetch.
       *
       * (It did cost bytes to STORE: the compact codec dropped names, so
       * prefetched cells decoded unnamed. See graphCodec's v2 note — measured,
       * they are 0.4 % of the Jabalpur graph.)
       *
       * ★ UNDER THE TILES, LIKE THE ROADS ★
       * Same argument as the lines, plus one of its own: CARTO's tiles carry
       * their own labels, so drawing ours above them would double every street
       * name while online. Underneath, ours appear exactly where a tile did
       * not, which is the same tile-by-tile degradation the rest of this layer
       * is built on.
       */
      map.addLayer(
        {
          id: LABEL_ID,
          type: 'symbol',
          source: SOURCE_ID,
          // Two filters. Unnamed ways carry '' and would otherwise reserve
          // collision space for an empty label, thinning the real ones; and a
          // footpath's name is never what you want to read while driving.
          filter: [
            'all',
            ['!=', ['get', 'name'], ''],
            ['==', ['get', 'renderOnly'], 0],
          ],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': LABEL_FONT,
            // Along the road, not across it — a street name set horizontally
            // over a line is a label floating near a road rather than a label
            // ON it, and on a dense graph they pile up unreadably.
            'symbol-placement': 'line',
            'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12.5],
            // Repeated, because a long road leaving the viewport with its only
            // label at the far end reads as unnamed.
            'symbol-spacing': 260,
            'text-max-angle': 35,
            'text-padding': 4,
            // Labels are the first thing to sacrifice when space runs out: a
            // missing name is a small loss, an unreadable pile-up is a big one.
            'text-allow-overlap': false,
            'text-optional': true,
          },
          paint: {
            'text-color': '#c8c9ca',
            // A halo in the ground colour, not black: this is what keeps a
            // name legible where it crosses its own road, which at these
            // widths is most of the time.
            'text-halo-color': '#090909',
            'text-halo-width': 1.4,
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
        if (map.getLayer(LABEL_ID)) map.removeLayer(LABEL_ID);
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
