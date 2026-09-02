'use client';

import { useEffect, useMemo } from 'react';
import type { GeoJSONSource } from 'maplibre-gl';
import type { RoadGraph } from '@pathpulse/nav-core';
import { useMap } from './MapContext';

const SOURCE_ID = 'matched-road';
const GLOW_ID = 'matched-road-glow';
const LINE_ID = 'matched-road-line';

interface MatchedRoadLayerProps {
  graph: RoadGraph | null;
  /** Way id the engine snapped to on the latest state, or null for no match. */
  wayId: string | null;
}

/**
 * Highlights the road the estimator believes it is on.
 *
 * ★ WHY THIS IS WORTH A LAYER ★
 * Map matching is the constraint doing the most visible work and the least
 * visible explaining. The debug panel could already name the matched road, and
 * the marker moved sideways onto it, but nothing on the map said *which* road
 * had been chosen — so a snap that worked and a snap that picked the wrong
 * parallel street looked identical. Drawing it turns an assertion into
 * something an observer can check against the basemap in one glance.
 *
 * It is also the honest counterpart to the confidence ellipse: the ellipse
 * says how wrong we might be, and this says what we are betting on.
 *
 * Presentation only. Nothing here feeds the estimator, and the layer is empty
 * whenever there is no match — an unmatched position is a real state (car
 * parks, private land, outside the graph) and inventing a road for it would
 * be exactly the lie road snapping must never tell.
 */
export default function MatchedRoadLayer({ graph, wayId }: MatchedRoadLayerProps) {
  const map = useMap();

  // Index once per graph rather than scanning ~9,500 ways on every state.
  const byId = useMemo(() => {
    if (!graph) return null;
    const m = new Map<string, Array<[number, number]>>();
    for (const w of graph.ways) m.set(w.id, w.coords);
    return m;
  }, [graph]);

  useEffect(() => {
    if (!map) return;

    const ensure = () => {
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Two strokes: a wide soft glow under a crisp core, which is what makes
      // a thin line read as "highlighted" on a dark basemap rather than as
      // just another road.
      map.addLayer({
        id: GLOW_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 13,
          'line-blur': 9,
          'line-opacity': 0.4,
        },
      });
      map.addLayer({
        id: LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#7dd3fc', 'line-width': 4, 'line-opacity': 0.9 },
      });
    };

    if (map.isStyleLoaded()) ensure();
    else map.once('load', ensure);

    return () => {
      // Style teardown can race a hot reload; removing a layer that is already
      // gone throws and would take the map down with it.
      try {
        if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
        if (map.getLayer(GLOW_ID)) map.removeLayer(GLOW_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        /* map already torn down */
      }
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!src) return;

    const coords = wayId && byId ? byId.get(wayId) : undefined;
    src.setData(
      coords && coords.length > 1
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { wayId },
                geometry: { type: 'LineString', coordinates: coords },
              },
            ],
          }
        : { type: 'FeatureCollection', features: [] },
    );
  }, [map, wayId, byId]);

  return null;
}
