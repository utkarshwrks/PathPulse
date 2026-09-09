'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Marker } from 'maplibre-gl';
import type { NavMode } from '@pathpulse/nav-core';
import { MODE_COLORS } from '@/config/modes';
import { positionDisplay } from '@/lib/positionDisplay';
import { useMap } from './MapContext';

/**
 * Time constant of the position easing, ms.
 *
 * At ~150 ms the marker reaches 63% of a step in one constant and is visually
 * settled inside half a second — smooth at 10 Hz, and still smooth on a
 * handset fixing every five seconds, which is the case that actually looked
 * broken. Raising it looks silkier and lags the truth further; this is the
 * point where motion reads as continuous without the marker visibly trailing.
 */
const SMOOTHING_TAU_MS = 150;

/** Beyond this the engine has logged a reset, so snap instead of gliding, m. */
const SNAP_THRESHOLD_M = 400;

interface VehicleMarkerProps {
  lat: number;
  lon: number;
  headingDeg: number | null;
  mode: NavMode;
  /**
   * Along-track and cross-track 1-sigma uncertainty, metres.
   *
   * The marker degrades as these grow — see `lib/positionDisplay.ts`. At the
   * end of the field ride's 52 s outage the estimator was reporting 88/5 and
   * this component was still drawing a crisp arrow at a point.
   */
  alongM?: number;
  crossM?: number;
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
  alongM,
  crossM,
}: VehicleMarkerProps) {
  const map = useMap();
  const markerRef = useRef<Marker | null>(null);
  const arrowRef = useRef<HTMLDivElement | null>(null);
  // Heading is null when stationary; keep pointing the last known way
  // instead of snapping back to north.
  const lastHeadingRef = useRef(0);
  /** Where the engine says we are — updated on every state. */
  const targetRef = useRef<{ lat: number; lon: number } | null>(null);
  /** Where the marker is actually drawn — eased toward the target each frame. */
  const shownRef = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!map) return;

    const el = document.createElement('div');
    el.className = 'vehicle-marker';

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

  /**
   * Position, eased every frame rather than set on every state.
   *
   * ★ WHY CSS CANNOT DO THIS ONE ★
   * The heading above is smoothed by a CSS transition, but a MapLibre marker's
   * position is not a CSS property — `setLngLat` moves it immediately, and the
   * comment claiming the camera eased it only held while the camera was
   * following. So the marker stepped: once per state at 10 Hz, and on a
   * handset delivering a fix every five to twenty seconds, one visible jump
   * per fix. That is the jerk on screen, and it is presentation, not estimate.
   *
   * Exponential smoothing toward the latest state, framerate-independent, so
   * it always converges and never runs ahead of the truth. It adds display lag
   * of roughly one time constant — deliberately small, because the marker
   * showing where the engine said it was 150 ms ago is honest, while a marker
   * that teleports reads as broken however right the mathematics is.
   */
  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    targetRef.current = { lat, lon };
    if (!shownRef.current) {
      shownRef.current = { lat, lon };
      markerRef.current?.setLngLat([lon, lat]);
      return;
    }

    // ★ AN EXPLICIT RESET MUST NOT BE EASED ★
    // Beyond the recovery blender's own reset threshold the engine has already
    // decided the old position was worthless and logged POSITION_RESET.
    // Gliding the marker across that distance would animate a jump the engine
    // deliberately labelled as one — and at 150 ms of smoothing it would streak
    // across the map. Snap, and let the event log carry the explanation.
    const shown = shownRef.current;
    const dLat = (lat - shown.lat) * 111_320;
    const dLon =
      (lon - shown.lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) > SNAP_THRESHOLD_M) {
      shownRef.current = { lat, lon };
      markerRef.current?.setLngLat([lon, lat]);
    }
  }, [lat, lon]);

  // The easing loop itself. One rAF for the marker's lifetime.
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(now - last, 100); // a backgrounded tab must not lurch
      last = now;
      const target = targetRef.current;
      const shown = shownRef.current;
      if (!target || !shown || !markerRef.current) return;

      // Framerate-independent exponential approach: the same visual speed at
      // 60 fps and at 30, which a fixed per-frame fraction would not give.
      const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU_MS);
      const nextLat = shown.lat + (target.lat - shown.lat) * alpha;
      const nextLon = shown.lon + (target.lon - shown.lon) * alpha;
      shownRef.current = { lat: nextLat, lon: nextLon };
      markerRef.current.setLngLat([nextLon, nextLat]);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  // Heading + colour.
  useEffect(() => {
    if (headingDeg !== null && Number.isFinite(headingDeg)) {
      lastHeadingRef.current = headingDeg;
    }
    if (arrowRef.current) {
      arrowRef.current.style.transform = `rotate(${lastHeadingRef.current}deg)`;
      arrowRef.current.style.color = MODE_COLORS[mode];
      // The arrow fades rather than vanishing, for the same reason the marker
      // eases rather than teleporting: a thing that disappears reads as a bug.
      arrowRef.current.style.transition =
        'transform 220ms ease-out, color 300ms linear, opacity 300ms linear';
    }
  }, [headingDeg, mode]);

  /**
   * ★ THE ARROW STOPS CLAIMING WHAT THE FILTER NO LONGER KNOWS ★
   *
   * `ConfidenceEllipse` already draws the covariance honestly — a polygon in
   * geographic coordinates, sized in metres, rotated to the heading. What it
   * could not do is stop the arrow sitting on top of it, and an arrow is a
   * claim to a POINT. At the end of the field ride's outage the estimator was
   * reporting 88 m of along-track uncertainty, the ellipse was drawing a smear
   * the length of a city block, and the arrow in the middle of it was still
   * saying "here".
   *
   * So above `bandOnlyM` the arrow fades out and the ellipse speaks alone. It
   * fades rather than vanishing for the same reason the marker eases rather
   * than teleporting: a thing that disappears reads as a bug.
   *
   * Presentation only. The estimator does not know this exists.
   */
  useEffect(() => {
    const arrow = arrowRef.current;
    if (!arrow) return;
    const d = positionDisplay(alongM ?? Number.NaN, crossM ?? Number.NaN);
    arrow.style.opacity = d.showMarker ? '1' : '0';
  }, [alongM, crossM]);

  return null;
}
