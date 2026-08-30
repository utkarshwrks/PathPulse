'use client';

import { useEffect } from 'react';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import { buildConfidenceRing, type NavMode } from '@pathpulse/nav-core';
import { MODE_COLORS } from '@/config/modes';
import { useMap } from './MapContext';

const SOURCE_ID = 'pathpulse-confidence';
const FILL_ID = 'pathpulse-confidence-fill';
const LINE_ID = 'pathpulse-confidence-outline';

interface ConfidenceEllipseProps {
  lat: number;
  lon: number;
  /** Semi-axis along the direction of travel, metres. */
  alongM: number;
  /** Semi-axis across the direction of travel, metres. */
  crossM: number;
  headingDeg: number | null;
  mode: NavMode;
}

/**
 * The uncertainty ellipse under the vehicle marker.
 *
 * ★ WHY A GEOJSON POLYGON AND NOT THE OLD CSS HALO ★
 * The halo this replaces was a DOM circle sized in pixels from the current
 * zoom. It could not rotate to a heading, it could not show along and cross
 * track as different sizes, and — because nothing recomputed it on `zoom` —
 * it silently stopped representing any real distance the moment the user
 * pinched. A polygon in geographic coordinates is sized in metres by the map
 * itself, so it stays truthful at every zoom for free.
 *
 * The shape is genuinely what the engine believes: `covariance.alongM` grows
 * with unaided speed integration through an outage, `crossM` is bounded by NHC
 * and capped outright once a road is matched, and both ease back down during
 * recovery. All this component does is draw them.
 *
 * The ring math lives in nav-core, unit tested, because a shape that is subtly
 * wrong on a map looks exactly like a shape that is right.
 */
export default function ConfidenceEllipse({
  lat,
  lon,
  alongM,
  crossM,
  headingDeg,
  mode,
}: ConfidenceEllipseProps) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // Colour is data-driven off the feature's own mode, matching TrailLayer,
    // so the ellipse can never disagree with the trail about what mode we are
    // in — the layer paint is set once and never touched again.
    const modeColor: ExpressionSpecification = [
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
    ];

    map.addLayer({
      id: FILL_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': modeColor,
        // Faint on purpose. This sits under the marker and the trail; an
        // uncertainty region that competes with the position it qualifies is
        // worse than no uncertainty region.
        'fill-opacity': 0.15,
      },
    });

    map.addLayer({
      id: LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': modeColor,
        'line-width': 1.5,
        'line-opacity': 0.65,
      },
    });

    return () => {
      if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
      if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const ring = buildConfidenceRing(
      { lat, lon },
      { alongM, crossM, headingDeg: headingDeg ?? 0 },
    );

    if (ring.length === 0) {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    source.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { mode },
          geometry: { type: 'Polygon', coordinates: [ring] },
        },
      ],
    });
  }, [map, lat, lon, alongM, crossM, headingDeg, mode]);

  return null;
}
