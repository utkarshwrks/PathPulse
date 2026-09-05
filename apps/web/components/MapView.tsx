'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DEFAULT_CENTER, DEFAULT_ZOOM, resolveMapStyle } from '@/config/map';
import { MapContext } from './MapContext';

interface MapViewProps {
  children?: ReactNode;
  onReady?: (map: MapLibreMap) => void;
  /** Fires when the user pans/zooms by hand, so follow mode can disengage. */
  onUserInteract?: () => void;
}

export default function MapView({ children, onReady, onUserInteract }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [styleInfo] = useState(() => resolveMapStyle());
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let instance: MapLibreMap;
    try {
      instance = new maplibregl.Map({
        container: containerRef.current,
        style: styleInfo.style,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: { compact: true },
        // The marker carries heading; a rotating map on top of that is
        // disorienting during a demo.
        pitchWithRotate: false,
        dragRotate: false,
      });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Map failed to initialise.');
      return;
    }

    mapRef.current = instance;
    // Debug handle: lets an attached devtools session read camera state on a
    // real device. Instrumentation only — nothing in the app reads it.
    (window as unknown as { __ppmap?: MapLibreMap }).__ppmap = instance;

    instance.on('load', () => {
      setMap(instance);
      onReady?.(instance);
    });

    // Tiles failing must not take the app down — Golden Rule: degrade, never crash.
    instance.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('[map]', e.error?.message ?? e);
    });

    for (const ev of ['dragstart', 'zoomstart', 'rotatestart'] as const) {
      instance.on(ev, (e: { originalEvent?: unknown }) => {
        // Only user gestures count; programmatic easeTo has no originalEvent.
        if (e.originalEvent) onUserInteract?.();
      });
    }

    // ★ A PINCH IS A USER GESTURE EVEN WHEN THE CAMERA IS ALREADY MOVING ★
    // `zoomstart` only carries an `originalEvent` when the zoom *begins* with
    // the gesture. While follow mode was animating the camera the map was
    // already zooming, so the pinch never produced a fresh zoomstart and
    // following was never released — the user pinched and the camera pulled
    // straight back. A raw two-finger touch is unambiguous: it is the user.
    instance.getCanvasContainer().addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length >= 2) onUserInteract?.();
      },
      { passive: true },
    );

    return () => {
      instance.remove();
      mapRef.current = null;
      setMap(null);
    };
    // Style is captured once; swapping basemaps is a Phase 9 concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0e14] p-6 text-center">
        <p className="text-sm text-neutral-400">
          Map could not load: {failed}
          <br />
          <span className="text-xs text-neutral-600">
            Navigation still runs — the map is presentation only.
          </span>
        </p>
      </div>
    );
  }

  /**
   * Zoom by a whole level, and count as a user gesture.
   *
   * ★ WHY BUTTONS AT ALL ★
   * There were none. Not a broken control — no zoom control of any kind had
   * ever been added, on a full-bleed map whose only other way in is a pinch.
   * A judge handed the phone one-handed, or anyone whose pinch the follow
   * camera was fighting, had no way to change the zoom at all.
   *
   * These go through the same `onUserInteract` path as a pinch so pressing
   * them releases follow mode, rather than being undone by the next camera
   * update the way a pinch used to be.
   */
  const nudgeZoom = (delta: number) => {
    const m = mapRef.current;
    if (!m) return;
    onUserInteract?.();
    m.easeTo({ zoom: m.getZoom() + delta, duration: 200 });
  };

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className="absolute inset-0"
      />

      {/* Left edge, mid-height: clear of the HUD top-left, the menu top-right,
          the Demo bar bottom-centre and the Recenter button bottom-right. */}
      {map ? (
        <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => nudgeZoom(1)}
            className="h-10 w-10 rounded-lg border border-white/15 bg-black/70 text-lg font-semibold leading-none text-neutral-100 backdrop-blur transition active:bg-white/20 hover:bg-black/85"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => nudgeZoom(-1)}
            className="h-10 w-10 rounded-lg border border-white/15 bg-black/70 text-lg font-semibold leading-none text-neutral-100 backdrop-blur transition active:bg-white/20 hover:bg-black/85"
          >
            −
          </button>
        </div>
      ) : null}
      <MapContext.Provider value={map}>{map ? children : null}</MapContext.Provider>
    </div>
  );
}
