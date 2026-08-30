'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  appendTrailPoint,
  buildGpx,
  buildTripGeoJson,
  tripFileName,
  type TrailPoint,
} from '@pathpulse/nav-core';
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
import DemoBar from '@/components/DemoBar';
import PitchScreen from '@/components/PitchScreen';
import Welcome from '@/components/Welcome';
import AppMenu from '@/components/AppMenu';
import TourOverlay from '@/components/TourOverlay';
import { useTour } from '@/hooks/useTour';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useDemoMode } from '@/hooks/useDemoMode';
import { DEMO_CONTROLS, DEMO_OUTAGE_MS } from '@/lib/demoScript';
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
  const [showPitch, setShowPitch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSources, setShowSources] = useState(false);
  /**
   * Bumped by Demo Mode to request a staged start.
   *
   * ★ WHY NOT JUST CALL source.play() ★
   * `useSensorSource` rebuilds its source inside an effect keyed on
   * [kind, routeKey], and effects run after the render that changed them. So
   * pressing Demo while the Live source was selected called `play()` on a
   * simulator that did not exist yet: `simRef` was still null, the web source
   * was started instead, and the fresh simulator arrived a moment later
   * un-started. The result was a demo banner counting down over a dead map —
   * the failure you would only find by pressing the button in front of a
   * judge. Bumping a counter and playing from an effect puts the start after
   * the source it is starting.
   */
  const [demoEpoch, setDemoEpoch] = useState(0);
  const [mapBounds, setMapBounds] = useState<LatLonBounds | null>(null);
  /**
   * Wall-clock epoch of this session's t=0.
   *
   * Sample timestamps are milliseconds since the source started, so without
   * this the export has no way to write a real <time>. Captured where the
   * trail is cleared, which is exactly when a session begins.
   */
  const sessionStartRef = useRef<number>(Date.now());

  // ★ The navigation engine is now the single source of truth for what the
  // map draws. Raw GNSS is only an input to it, never drawn directly — that is
  // what lets the marker keep moving when GNSS disappears.
  const nav = useNavigationEngine();
  const source = useSensorSource(kind, routeKey, nav.feed);
  const live = useGeolocation(false);
  const offline = useOfflineStatus();
  const tour = useTour();

  // ★ 10A: one press sets the whole stage. See lib/demoScript.ts for why the
  // configuration is the shipping one rather than literally "everything on".
  const demo = useDemoMode({
    prepare: () => {
      setKind('simulation');
      setRouteKey('city');
      setShowOffline(false);
      setShowPitch(false);
      setShowMenu(false);
      setShowDebug(false);
      setShowSources(false);
      setShowBenchmarks(false);
      setShowDeviceInfo(false);
      setFollowing(true);
      nav.setControls(DEMO_CONTROLS);
      // The actual start happens in the effect below, once the source for the
      // configuration above actually exists.
      setDemoEpoch((e) => e + 1);
    },
    triggerOutage: () => source.triggerOutage(DEMO_OUTAGE_MS),
  });

  useEffect(() => {
    if (demoEpoch === 0) return;
    source.reset();
    nav.reset();
    setTrail([]);
    sessionStartRef.current = Date.now();
    setFollowing(true);
    source.play();
    // Keyed on the epoch alone: it changes on every start, including a restart
    // where kind and route are already correct and no other dependency moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoEpoch]);

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
    sessionStartRef.current = Date.now();
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

  const downloadText = useCallback((text: string, filename: string, mime: string) => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /**
   * Golden Rule #8 again, in its strongest form: a file the judge opens later,
   * on their own machine, showing our estimate and the raw GNSS reference as
   * two tracks over the same drive. Where they diverge IS the drift, drawn to
   * scale by software we did not write.
   */
  const handleExportTrip = useCallback(
    (format: 'gpx' | 'geojson') => {
      const startedAtEpochMs = sessionStartRef.current;
      const reference = nav.gnssTrail();
      const stem = tripFileName(startedAtEpochMs);
      if (format === 'gpx') {
        downloadText(
          buildGpx({ estimated: trail, reference, startedAtEpochMs }),
          `${stem}.gpx`,
          'application/gpx+xml',
        );
      } else {
        downloadText(
          JSON.stringify(buildTripGeoJson({ estimated: trail, reference, startedAtEpochMs }), null, 2),
          `${stem}.geojson`,
          'application/geo+json',
        );
      }
    },
    [downloadText, nav, trail],
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
      <div data-tour="map" className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2" />

      <MapView onReady={handleReady} onUserInteract={() => setFollowing(false)}>
        {/* Mount order is z-order: layers are added to the map in the order
            their effects run, so the ellipse goes down first and the trail
            draws on top of it rather than being washed out by the fill. */}
        <ErrorBoundary area="Confidence ellipse" fallback={null}>
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
        </ErrorBoundary>
        <ErrorBoundary area="Trail" fallback={null}>
          <TrailLayer trail={trail} />
        </ErrorBoundary>
        {hasPosition ? (
          <VehicleMarker
            lat={shownPosition!.lat}
            lon={shownPosition!.lon}
            headingDeg={navState?.headingDeg ?? 0}
            mode={navState?.mode ?? 'INITIALIZING'}
          />
        ) : null}
      </MapView>

      <ErrorBoundary area="HUD">
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
      </ErrorBoundary>

      {showDebug ? (
      <ErrorBoundary area="Debug panel">
      <TrustPanel
        onClose={() => setShowDebug(false)}
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
        onExportTrip={handleExportTrip}
        tripPointCount={trail.length}
        simulated={kind === 'simulation'}
        imuHz={source.imuHz}
        gnssHz={source.gnssHz}
        updateHz={nav.updateHz}
      />
      </ErrorBoundary>
      ) : null}

      {/* ★ ONE BUTTON, NOT FIVE ★
          The controls had grown to five buttons pinned top-right, on the same
          line as a HUD up to 359 px wide. On a 390 px phone they physically
          could not coexist and they overlapped — each feature had been added
          by appending one more button to a row that was already full. */}
      <div className="absolute right-3 top-3 z-30 flex gap-1.5">
        <button
          type="button"
          data-tour="menu"
          aria-label="Open menu"
          onClick={() => setShowMenu(true)}
          className={`rounded-lg border px-3 py-2 text-sm backdrop-blur transition ${
            offline.online
              ? 'border-white/15 bg-black/70 text-neutral-200 hover:bg-black/85'
              : 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
          }`}
        >
          {offline.online ? '☰' : '✈'}
        </button>
      </div>

      {/* The single primary action, where a thumb reaches it. */}
      {!demo.running ? (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
          <ErrorBoundary area="Demo" fallback={null}>
            <DemoBar
              running={false}
              elapsedMs={0}
              position={demo.position}
              onStart={demo.start}
              onReset={demo.restart}
              onStop={demo.stop}
            />
          </ErrorBoundary>
        </div>
      ) : null}

      {showMenu ? (
        <ErrorBoundary area="Menu" fallback={null}>
          <AppMenu
            onClose={() => setShowMenu(false)}
            items={[
              {
                id: 'demo',
                icon: '▶',
                label: 'Run the demo',
                hint: 'Plays the whole GPS-loss story on its own, about 80 seconds.',
                onSelect: demo.start,
                primary: true,
              },
              {
                id: 'sources',
                icon: '📡',
                label: 'Choose a source',
                hint: 'Simulation, your phone\u2019s real sensors, or the recorded backup.',
                onSelect: () => setShowSources(true),
              },
              {
                id: 'debug',
                icon: '🔧',
                label: 'Live sensors & proof',
                hint: 'Raw readings, the event log, and switches that break the physics on purpose.',
                onSelect: () => setShowDebug(true),
              },
              {
                id: 'offline',
                icon: '⛰',
                label: offline.online ? 'Offline maps' : 'Offline — radio is off',
                hint: 'Store the map area, then try it in aeroplane mode.',
                onSelect: () => setShowOffline(true),
              },
              {
                id: 'benchmarks',
                icon: '📊',
                label: 'Measured results',
                hint: 'The ablation table: one component switched off per row.',
                onSelect: () => setShowBenchmarks(true),
              },
              {
                id: 'pitch',
                icon: '📈',
                label: 'The pitch',
                hint: 'Five slides: problem, approach, results, model, compliance.',
                onSelect: () => setShowPitch(true),
              },
              {
                id: 'device',
                icon: '📱',
                label: 'Device & build',
                hint: 'What this phone exposes, and which build you are running.',
                onSelect: () => setShowDeviceInfo(true),
              },
              {
                id: 'tour',
                icon: '?',
                label: 'Replay the tour',
                hint: 'The six-step walkthrough, again.',
                onSelect: tour.restart,
              },
            ]}
          />
        </ErrorBoundary>
      ) : null}

      {showBenchmarks ? <Benchmarks onClose={() => setShowBenchmarks(false)} /> : null}

      {showPitch ? (
        <ErrorBoundary area="Pitch">
          <PitchScreen onClose={() => setShowPitch(false)} />
        </ErrorBoundary>
      ) : null}

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

      {demo.running ? (
        <div className="absolute bottom-4 left-3 z-20">
          <ErrorBoundary area="Demo bar" fallback={null}>
            <DemoBar
              running
              elapsedMs={demo.elapsedMs}
              position={demo.position}
              onStart={demo.start}
              onReset={demo.restart}
              onStop={demo.stop}
            />
          </ErrorBoundary>
        </div>
      ) : null}

      {/* Manual source controls step aside during a scripted run: the script
          drives them, and leaving them within reach only invites someone to
          fight it mid-demo. */}
      {showSources && !demo.running ? (
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

      {tour.phase === 'loading' ? (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#080b10]">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" />
          <p className="mt-4 text-[11px] uppercase tracking-widest text-neutral-500">
            PathPulse
          </p>
        </div>
      ) : null}

      {tour.phase === 'welcome' ? (
        <ErrorBoundary area="Welcome" fallback={null}>
          <Welcome
            onTour={tour.begin}
            onSkip={tour.skip}
            buildId={process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}
          />
        </ErrorBoundary>
      ) : null}

      {tour.phase === 'tour' ? (
        <ErrorBoundary area="Tour" fallback={null}>
          <TourOverlay
            index={tour.index}
            onNext={tour.next}
            onBack={tour.back}
            onSkip={tour.skip}
          />
        </ErrorBoundary>
      ) : null}
    </main>
  );
}
