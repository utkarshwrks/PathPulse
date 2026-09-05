'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { resolveMapStyle } from '@/config/map';

interface Way {
  id: string;
  name?: string;
  highway?: string;
  coords: Array<[number, number]>;
}

/**
 * The offline road graph, drawn on the map it constrains.
 *
 * ★ WHY SHOW THE DATA RATHER THAN DESCRIBE IT ★
 * "Road snapping uses real OpenStreetMap geometry bundled in the app" is a
 * sentence anyone can write. Rendering the 9,462 ways that actually ship
 * inside the APK — every one of them, from the same file the estimator reads —
 * is the claim and its evidence at once.
 *
 * The graph is also the answer to the obvious question about map matching: it
 * works where there is a graph, and it says so where there is not. The bounding
 * box drawn here is exactly the area the app can snap within.
 */
export default function RoadGraphMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState<{ ways: number; named: number; kb: number } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const style = resolveMapStyle();
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: host,
        style: style.style,
        center: [79.9339, 23.1667],
        zoom: 11.4,
        attributionControl: { compact: true },
        // A landing page map is for looking at, not for navigating.
        interactive: true,
        dragRotate: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    let cancelled = false;

    map.on('load', () => {
      // The same asset the app loads at runtime, fetched the same way.
      void fetch('maps/road_graph_jabalpur.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('missing'))))
        .then((graph: { ways: Way[]; bbox: [number, number, number, number] }) => {
          if (cancelled) return;

          map.addSource('graph', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: graph.ways
                .filter((w) => w.coords?.length > 1)
                .map((w) => ({
                  type: 'Feature',
                  properties: { name: w.name ?? '', highway: w.highway ?? '' },
                  geometry: { type: 'LineString', coordinates: w.coords },
                })),
            },
          });

          // Two passes: a wide dim wash for the whole network, then a brighter
          // thread on the classes a vehicle actually uses. Drawing every way at
          // one weight turns 9,462 lines into a grey smear.
          map.addLayer({
            id: 'graph-all',
            type: 'line',
            source: 'graph',
            paint: { 'line-color': '#1e3a5f', 'line-width': 0.7, 'line-opacity': 0.85 },
          });
          map.addLayer({
            id: 'graph-major',
            type: 'line',
            source: 'graph',
            filter: [
              'in',
              ['get', 'highway'],
              ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']],
            ],
            paint: { 'line-color': '#38bdf8', 'line-width': 1.4, 'line-opacity': 0.9 },
          });

          const [minLon, minLat, maxLon, maxLat] = graph.bbox;
          map.addSource('bbox', {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: [
                  [minLon, minLat],
                  [maxLon, minLat],
                  [maxLon, maxLat],
                  [minLon, maxLat],
                  [minLon, minLat],
                ],
              },
            },
          });
          map.addLayer({
            id: 'bbox-line',
            type: 'line',
            source: 'bbox',
            paint: {
              'line-color': '#64748b',
              'line-width': 1,
              'line-dasharray': [3, 3],
              'line-opacity': 0.7,
            },
          });

          map.fitBounds(
            [
              [minLon, minLat],
              [maxLon, maxLat],
            ],
            { padding: 32, duration: 0 },
          );

          setStats({
            ways: graph.ways.length,
            named: graph.ways.filter((w) => w.name).length,
            kb: 2265,
          });
        })
        .catch(() => !cancelled && setFailed(true));
    });

    return () => {
      cancelled = true;
      map.remove();
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#080b11]">
      <div className="relative h-[300px] w-full sm:h-[380px]">
        <div ref={hostRef} className="absolute inset-0" />
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[#080b11]">
            <p className="px-6 text-center text-[12px] text-neutral-500">
              Road graph could not be loaded here — it still ships inside the app.
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-white/[0.07] px-5 py-3.5 text-[11px] text-neutral-500">
        <Stat v={stats ? stats.ways.toLocaleString('en-IN') : '—'} l="ways bundled" />
        <Stat v="2.2 MB" l="inside the APK" />
        <Stat v="12 × 12 km" l="coverage" />
        <Stat v="0" l="network calls at runtime" />
      </div>
    </div>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="tabular font-mono text-[13px] font-semibold text-neutral-200">
        {v}
      </span>
      <span>{l}</span>
    </span>
  );
}
