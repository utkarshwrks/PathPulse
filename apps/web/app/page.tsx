'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  appendTrailPoint,
  trailDistanceM,
  type TrailPoint,
} from '@pathpulse/nav-core';
import { FOLLOW_ZOOM, resolveMapStyle } from '@/config/map';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useMockTrack } from '@/hooks/useMockTrack';
import { deriveMode } from '@/lib/navMode';
import StatusBar from '@/components/StatusBar';
import PermissionGate from '@/components/PermissionGate';
import VehicleMarker from '@/components/VehicleMarker';
import TrailLayer from '@/components/TrailLayer';

// MapLibre touches window/document at import time, and this app is statically
// exported — so it must never be evaluated during prerender.
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e14]">
      <p className="text-sm text-neutral-500">Loading map…</p>
    </div>
  ),
});

export default function Home() {
  // ?mock=1 drives a synthetic track for development on a machine with no GPS.
  // Superseded by the real SimulationSource in Phase 2.
  const [mockEnabled, setMockEnabled] = useState(false);
  useEffect(() => {
    setMockEnabled(new URLSearchParams(window.location.search).get('mock') === '1');
  }, []);

  const live = useGeolocation(true);
  const mock = useMockTrack(mockEnabled);

  const { status, error, fixCount, start } = live;
  const fix = mockEnabled ? mock.fix : live.fix;
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [following, setFollowing] = useState(true);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleInfo = useMemo(() => resolveMapStyle(), []);

  const mode = mockEnabled ? mock.mode : deriveMode(fix?.accuracyM);

  // Accumulate the trail. appendTrailPoint handles jitter filtering and the
  // 500-point cap; this component just feeds it.
  useEffect(() => {
    if (!fix) return;
    setTrail((prev) =>
      appendTrailPoint(prev, {
        lat: fix.lat,
        lon: fix.lon,
        mode: mockEnabled ? mock.mode : deriveMode(fix.accuracyM),
        t: fix.timestamp,
      }),
    );
  }, [fix, mockEnabled, mock.mode]);

  // Follow the marker, unless the user has taken manual control of the map.
  useEffect(() => {
    if (!fix || !following) return;
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      center: [fix.lon, fix.lat],
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: 700,
    });
  }, [fix, following]);

  const handleReady = useCallback((map: MapLibreMap) => {
    mapRef.current = map;
  }, []);

  const distanceM = useMemo(() => trailDistanceM(trail), [trail]);

  return (
    <main className="relative h-full w-full overflow-hidden">
      <MapView onReady={handleReady} onUserInteract={() => setFollowing(false)}>
        <TrailLayer trail={trail} />
        {fix ? (
          <VehicleMarker
            lat={fix.lat}
            lon={fix.lon}
            headingDeg={fix.headingDeg}
            mode={mode}
            accuracyM={fix.accuracyM}
          />
        ) : null}
      </MapView>

      <StatusBar
        mode={mode}
        fix={fix}
        status={status}
        error={error}
        fixCount={fixCount}
        distanceM={distanceM}
        mapSourceLabel={styleInfo.label}
      />

      {!following ? (
        <button
          type="button"
          onClick={() => setFollowing(true)}
          className="absolute bottom-6 right-4 z-10 rounded-full border border-white/15 bg-black/70 px-4 py-2 text-xs font-medium text-neutral-100 backdrop-blur transition hover:bg-black/85"
        >
          Recenter
        </button>
      ) : null}

      {mockEnabled ? null : (
        <PermissionGate status={status} error={error} onRetry={start} />
      )}
    </main>
  );
}
