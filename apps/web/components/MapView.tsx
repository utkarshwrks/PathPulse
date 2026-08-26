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

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className={`absolute inset-0 ${styleInfo.needsDarkFilter ? 'map-dark-filter' : ''}`}
      />
      <MapContext.Provider value={map}>{map ? children : null}</MapContext.Provider>
    </div>
  );
}
