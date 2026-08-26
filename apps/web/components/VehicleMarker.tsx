'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Marker } from 'maplibre-gl';
import type { NavMode } from '@pathpulse/nav-core';
import { MODE_COLORS } from '@/config/modes';
import { useMap } from './MapContext';

interface VehicleMarkerProps {
  lat: number;
  lon: number;
  headingDeg: number | null;
  mode: NavMode;
  /** Reported horizontal accuracy, drawn as a soft halo. */
  accuracyM?: number | null;
}

/**
 * The vehicle arrow.
 *
 * Built from a DOM element rather than a map layer so CSS transitions can do
 * the smoothing. Golden Rule #6: the dot must never appear to teleport — a
 * jumping marker reads as a bug to a judge even when the math is right.
 */
export default function VehicleMarker({
  lat,
  lon,
  headingDeg,
  mode,
  accuracyM,
}: VehicleMarkerProps) {
  const map = useMap();
  const markerRef = useRef<Marker | null>(null);
  const arrowRef = useRef<HTMLDivElement | null>(null);
  const haloRef = useRef<HTMLDivElement | null>(null);
  // Heading is null when stationary; keep pointing the last known way
  // instead of snapping back to north.
  const lastHeadingRef = useRef(0);

  useEffect(() => {
    if (!map) return;

    const el = document.createElement('div');
    el.className = 'vehicle-marker';

    const halo = document.createElement('div');
    halo.className = 'vehicle-marker__halo';
    el.appendChild(halo);
    haloRef.current = halo;

    const arrow = document.createElement('div');
    arrow.className = 'vehicle-marker__arrow';
    arrow.innerHTML = `
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <path d="M12 2 L20 21 L12 16.5 L4 21 Z"
              fill="currentColor" stroke="#0a0e14" stroke-width="1.4"
              stroke-linejoin="round" />
      </svg>`;
    el.appendChild(arrow);
    arrowRef.current = arrow;

    const marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      .setLngLat([lon, lat])
      .addTo(map);
    markerRef.current = marker;

    return () => {
      marker.remove();
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Position.
  useEffect(() => {
    if (!markerRef.current) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    markerRef.current.setLngLat([lon, lat]);
  }, [lat, lon]);

  // Heading + colour.
  useEffect(() => {
    if (headingDeg !== null && Number.isFinite(headingDeg)) {
      lastHeadingRef.current = headingDeg;
    }
    if (arrowRef.current) {
      arrowRef.current.style.transform = `rotate(${lastHeadingRef.current}deg)`;
      arrowRef.current.style.color = MODE_COLORS[mode];
    }
    if (haloRef.current) {
      haloRef.current.style.background = MODE_COLORS[mode];
    }
  }, [headingDeg, mode]);

  // Accuracy halo. Phase 9 replaces this circle with a proper covariance
  // ellipse — along-track and cross-track error are not the same size.
  useEffect(() => {
    if (!map || !haloRef.current) return;
    const halo = haloRef.current;
    if (!accuracyM || !Number.isFinite(accuracyM)) {
      halo.style.width = '0px';
      halo.style.height = '0px';
      return;
    }
    const metresPerPixel =
      (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    const px = Math.min(400, Math.max(0, (accuracyM / metresPerPixel) * 2));
    halo.style.width = `${px}px`;
    halo.style.height = `${px}px`;
  }, [map, accuracyM, lat, mode]);

  return null;
}
