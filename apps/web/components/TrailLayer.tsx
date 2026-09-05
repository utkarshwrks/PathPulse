'use client';

import { useEffect } from 'react';
import type { GeoJSONSource } from 'maplibre-gl';
import {
  DEFAULT_TRAIL_SMOOTH_HALF_WINDOW,
  buildTrailSegments,
  type TrailPoint,
} from '@pathpulse/nav-core';
import { MODE_COLORS } from '@/config/modes';
import { useMap } from './MapContext';

const SOURCE_ID = 'pathpulse-trail';
const LAYER_ID = 'pathpulse-trail-line';

interface TrailLayerProps {
  trail: readonly TrailPoint[];
}

/**
 * The travelled path, coloured per mode.
 *
 * The colouring is the point: a judge can see at a glance which stretch was
 * satellite-fixed and which was estimated. Colour comes from a data-driven
 * paint expression on a single layer rather than one layer per segment, so
 * the layer count stays constant however many times the mode flips.
 *
 * Segment splitting itself lives in nav-core (pure, unit tested); this
 * component only renders what it is handed.
 */
export default function TrailLayer({ trail }: TrailLayerProps) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-width': 4,
        'line-opacity': 0.9,
        'line-color': [
          'match',
          ['get', 'mode'],
          'GNSS',
          MODE_COLORS.GNSS,
          'GNSS_DEGRADED',
          MODE_COLORS.GNSS_DEGRADED,
          'DEAD_RECKONING',
          MODE_COLORS.DEAD_RECKONING,
          'RECOVERING',
          MODE_COLORS.RECOVERING,
          'ERROR',
          MODE_COLORS.ERROR,
          MODE_COLORS.INITIALIZING,
        ],
      },
    });

    return () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    // ★ SMOOTHED WHEN DRAWN, RAW WHEN STORED ★
    // The buffer above is exactly what the estimator reported, and the trip
    // export reads that buffer. What goes on screen is averaged over a centred
    // window — see the measurements on DEFAULT_TRAIL_SMOOTH_HALF_WINDOW, which
    // took the drawn line from 45 % longer than the road to 7 %, with
    // cross-track error unchanged and no lag behind the marker.
    const segments = buildTrailSegments(trail, {
      smoothHalfWindow: DEFAULT_TRAIL_SMOOTH_HALF_WINDOW,
    });
    source.setData({
      type: 'FeatureCollection',
      features: segments.map((seg) => ({
        type: 'Feature' as const,
        properties: { mode: seg.mode },
        geometry: { type: 'LineString' as const, coordinates: seg.coordinates },
      })),
    });
  }, [map, trail]);

  return null;
}
