'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { appendTrailPoint, trailDistanceM, type TrailPoint } from '@pathpulse/nav-core';
import { FOLLOW_ZOOM, resolveMapStyle } from '@/config/map';
import { useGeolocation } from '@/hooks/useGeolocation';
import {
  useSensorSource,
  type RouteKey,
  type SourceKind,
} from '@/hooks/useSensorSource';
import StatusBar from '@/components/StatusBar';
import SourcePanel from '@/components/SourcePanel';
import PermissionGate from '@/components/PermissionGate';
import DeviceInfo from '@/components/DeviceInfo';
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
  const [kind, setKind] = useState<SourceKind>('simulation');
  const [routeKey, setRouteKey] = useState<RouteKey>('city');
  const source = useSensorSource(kind, routeKey);

  // Still used for the live-mode permission UI; the source itself handles data.
  const live = useGeolocation(false);

  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [following, setFollowing] = useState(true);
  const [showDeviceInfo, setShowDeviceInfo] = useState(false);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleInfo = useMemo(() => resolveMapStyle(), []);

  const { fix, mode } = source;

  useEffect(() => {
    if (!fix) return;
    setTrail((prev) =>
      appendTrailPoint(prev, { lat: fix.lat, lon: fix.lon, mode, t: fix.timestamp }),
    );
  }, [fix, mode]);

  // Clear the trail when the source or route changes — mixing two drives into
  // one path would be actively misleading.
  useEffect(() => {
    setTrail([]);
  }, [kind, routeKey]);

  useEffect(() => {
    if (!fix || !following) return;
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      center: [fix.lon, fix.lat],
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: 500,
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
            accuracyM={source.inOutage ? null : fix.accuracyM}
          />
        ) : null}
      </MapView>

      <StatusBar
        mode={mode}
        fix={fix}
        status={kind === 'live' ? live.status : 'watching'}
        error={kind === 'live' ? live.error : null}
        fixCount={Math.round(source.gnssHz * 100) / 100}
        distanceM={distanceM}
        mapSourceLabel={styleInfo.label}
        sourceName={source.sourceName}
        inOutage={source.inOutage}
      />

      <SourcePanel
        kind={kind}
        routeKey={routeKey}
        isRunning={source.isRunning}
        inOutage={source.inOutage}
        progress={source.progress}
        imuHz={source.imuHz}
        gnssHz={source.gnssHz}
        recordedCount={source.recordedCount}
        onKindChange={setKind}
        onRouteChange={setRouteKey}
        onPlay={() => {
          if (kind === 'live') live.start();
          source.play();
        }}
        onPause={source.pause}
        onReset={source.reset}
        onSpeed={source.setSpeed}
        onOutage={() => source.triggerOutage(60_000)}
        onDownload={source.downloadRecording}
      />

      <button
        type="button"
        onClick={() => setShowDeviceInfo(true)}
        className="absolute right-3 top-3 z-10 rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/85"
      >
        Device
      </button>

      {showDeviceInfo ? (
        <DeviceInfo
          imuHz={source.imuHz}
          gnssHz={source.gnssHz}
          sourceName={source.sourceName}
          onClose={() => setShowDeviceInfo(false)}
        />
      ) : null}

      {!following ? (
        <button
          type="button"
          onClick={() => setFollowing(true)}
          className="absolute bottom-6 right-4 z-10 rounded-full border border-white/15 bg-black/70 px-4 py-2 text-xs font-medium text-neutral-100 backdrop-blur transition hover:bg-black/85"
        >
          Recenter
        </button>
      ) : null}

      {kind === 'live' ? (
        <PermissionGate status={live.status} error={live.error} onRetry={live.start} />
      ) : null}
    </main>
  );
}
