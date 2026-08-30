'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { appendTrailPoint, type TrailPoint } from '@pathpulse/nav-core';
import { FOLLOW_ZOOM, resolveMapStyle } from '@/config/map';
import { resolveShownPosition, shouldJumpCamera } from '@/lib/shownPosition';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useNavigationEngine } from '@/hooks/useNavigationEngine';
import { useSensorSource, type RouteKey, type SourceKind } from '@/hooks/useSensorSource';
import Hud from '@/components/Hud';
import TrustPanel from '@/components/TrustPanel';
import SourcePanel from '@/components/SourcePanel';
import PermissionGate from '@/components/PermissionGate';
import DeviceInfo from '@/components/DeviceInfo';
import Benchmarks from '@/components/Benchmarks';
import VehicleMarker from '@/components/VehicleMarker';
import TrailLayer from '@/components/TrailLayer';
import ConfidenceEllipse from '@/components/ConfidenceEllipse';
import OfflinePanel from '@/components/OfflinePanel';
import { useOfflineStatus } from '@/hooks/useOfflineStatus';
import type { LatLonBounds } from '@/lib/tileCache';

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
  const [showDeviceInfo, setShowDeviceInfo] = useState(false);
  const [showBenchmarks, setShowBenchmarks] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [mapBounds, setMapBounds] = useState<LatLonBounds | null>(null);

  // ★ The navigation engine is now the single source of truth for what the
  // map draws. Raw GNSS is only an input to it, never drawn directly — that is
  // what lets the marker keep moving when GNSS disappears.
  const nav = useNavigationEngine();
  const source = useSensorSource(kind, routeKey, nav.feed);
  const live = useGeolocation(false);
  const offline = useOfflineStatus();

  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [following, setFollowing] = useState(true);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleInfo = useMemo(() => resolveMapStyle(), []);

  const navState = nav.state;

  // Which position to draw, and whether it is a navigation solution or a raw
  // fix. See lib/shownPosition.ts — this was the "Live does not find me" bug.
  const shownPosition = resolveShownPosition(navState, nav.lastGnss?.gnss);
  const hasPosition = shownPosition !== null;

  useEffect(() => {
    if (!navState) return;
    // ★ NOTHING TO DRAW UNTIL THERE IS A REAL POSITION ★
    // While ACQUIRING the engine has no ENU origin, so it reports (0, 0).
    // Appending that produced a grey line stretching from the previous
    // source's location to wherever the first real fix landed — the
    // "white line from Delhi" seen after switching from simulation to live.
    if (navState.mode === 'INITIALIZING') return;
    if (!Number.isFinite(navState.position.lat) || !Number.isFinite(navState.position.lon)) return;
    if (navState.position.lat === 0 && navState.position.lon === 0) return;
    setTrail((prev) =>
      appendTrailPoint(prev, {
        lat: navState.position.lat,
        lon: navState.position.lon,
        mode: navState.mode,
        t: navState.t,
      }),
    );
  }, [navState]);

  useEffect(() => {
    setTrail([]);
    nav.reset();
    // ★ RE-ENGAGE THE CAMERA WHEN THE SOURCE CHANGES. ★
    // Any pan, zoom or rotate sets `following` false and it stays false until
    // the user finds the recentre button. Explore the map during a simulation —
    // which is the natural thing to do — then switch to Live, and the camera
    // stays put no matter how good the fix is. Choosing a source is an explicit
    // "show me this" and has to override a stale manual pan.
    setFollowing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, routeKey]);

  useEffect(() => {
    if (!following || !shownPosition) return;
    if (shownPosition.lat === 0 && shownPosition.lon === 0) return;
    const map = mapRef.current;
    if (!map) return;
    // The first fix is a jump, not a glide: easing 800 km from the default
    // centre would spend seconds flying over India. Once we are actually near
    // the vehicle, ease so the marker does not appear to teleport.
    const c = map.getCenter();
    const jump = shouldJumpCamera({ lat: c.lat, lon: c.lng }, shownPosition);
    map.easeTo({
      center: [shownPosition.lon, shownPosition.lat],
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: jump ? 0 : 400,
    });
  }, [shownPosition, following]);

  const readBounds = useCallback((map: MapLibreMap) => {
    const b = map.getBounds();
    setMapBounds({
      north: b.getNorth(),
      south: b.getSouth(),
      east: b.getEast(),
      west: b.getWest(),
    });
  }, []);

  const handleReady = useCallback(
    (map: MapLibreMap) => {
      mapRef.current = map;
      readBounds(map);
      // The download button offers whatever is on screen, so the viewport has
      // to be current when the panel opens — not whatever it was at startup.
      map.on('moveend', () => readBounds(map));
    },
    [readBounds],
  );

  // Golden Rule #8: if the run can be exported it can be checked afterwards,
  // which is worth more to a judge than any claim made during the demo.
  const handleExportEvents = useCallback(() => {
    const blob = new Blob([nav.exportEventsJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pathpulse_events_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [nav]);


  return (
    <main className="relative h-full w-full overflow-hidden">
      <MapView onReady={handleReady} onUserInteract={() => setFollowing(false)}>
        {/* Mount order is z-order: layers are added to the map in the order
            their effects run, so the ellipse goes down first and the trail
            draws on top of it rather than being washed out by the fill. */}
        {hasPosition ? (
          <ConfidenceEllipse
            lat={shownPosition!.lat}
            lon={shownPosition!.lon}
            alongM={shownPosition!.alongM}
            crossM={shownPosition!.crossM}
            headingDeg={navState?.headingDeg ?? 0}
            mode={navState?.mode ?? 'INITIALIZING'}
          />
        ) : null}
        <TrailLayer trail={trail} />
        {hasPosition ? (
          <VehicleMarker
            lat={shownPosition!.lat}
            lon={shownPosition!.lon}
            headingDeg={navState?.headingDeg ?? 0}
            mode={navState?.mode ?? 'INITIALIZING'}
          />
        ) : null}
      </MapView>

      <Hud
        speedSource={nav.diagnostics.speedSource}
        navState={navState}
        error={kind === 'live' ? live.error : null}
        mapSourceLabel={styleInfo.label}
        sourceName={source.sourceName}
        updateHz={nav.updateHz}
        imuHz={source.imuHz}
        gnssHz={source.gnssHz}
        events={nav.events}
        walkingMode={nav.controls.walkingMode}
      />

      <TrustPanel
        modelInfo={nav.modelInfo}
        sample={nav.lastSample}
        lastGnss={nav.lastGnss}
        roadGraphEntry={nav.roadGraphEntry}
        diagnostics={nav.diagnostics}
        stats={nav.stats}
        events={nav.events}
        controls={nav.controls}
        onControlsChange={nav.setControls}
        onExportEvents={handleExportEvents}
        simulated={kind === 'simulation'}
        imuHz={source.imuHz}
        gnssHz={source.gnssHz}
        updateHz={nav.updateHz}
      />

      <div className="absolute right-3 top-3 z-10 flex gap-1.5">
        <button
          type="button"
          onClick={() => setShowOffline(true)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium backdrop-blur transition ${
            offline.online
              ? 'border-white/15 bg-black/70 text-neutral-200 hover:bg-black/85'
              : 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
          }`}
        >
          {offline.online ? 'Offline' : 'OFFLINE ✈'}
        </button>
        <button
          type="button"
          onClick={() => setShowBenchmarks(true)}
          className="rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/85"
        >
          Benchmarks
        </button>
        <button
          type="button"
          onClick={() => setShowDeviceInfo(true)}
          className="rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/85"
        >
          Device
        </button>
      </div>

      {showBenchmarks ? <Benchmarks onClose={() => setShowBenchmarks(false)} /> : null}

      {showOffline ? (
        <OfflinePanel
          status={offline}
          bounds={mapBounds}
          mapSourceLabel={styleInfo.label}
          onClose={() => setShowOffline(false)}
        />
      ) : null}

      {showDeviceInfo ? (
        <DeviceInfo
          imuHz={source.imuHz}
          gnssHz={source.gnssHz}
          sourceName={source.sourceName}
          onClose={() => setShowDeviceInfo(false)}
        />
      ) : null}

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
        onReset={() => {
          source.reset();
          nav.reset();
          setTrail([]);
          setFollowing(true);
        }}
        onSpeed={source.setSpeed}
        onOutage={() => source.triggerOutage(60_000)}
        onDownload={source.downloadRecording}
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

      {kind === 'live' ? (
        <PermissionGate status={live.status} error={live.error} onRetry={live.start} />
      ) : null}
    </main>
  );
}
