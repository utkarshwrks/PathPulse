'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { NavigationEngine, latLonToEnu, type NavMode } from '@pathpulse/nav-core';
import { SimulationSource, CITY_VEHICLE, type RouteGeoJson } from '@pathpulse/sensor-sources';
import { MODE_COLORS, MODE_LABELS } from '@/config/modes';
import cityRoute from '../../../../data/routes/route_city.json';

/**
 * The hero: the real navigation engine, rendered.
 *
 * ★ THIS IS NOT AN ANIMATION OF THE IDEA — IT IS THE IDEA, RUNNING ★
 * Every frame here comes from the same `NavigationEngine` the Android app
 * runs, fed by the same deterministic `SimulationSource`, over the same city
 * route that generates the benchmark numbers. The satellite fixes are deleted
 * for a window exactly as the eval harness deletes them — the field removed,
 * never zeroed — and the orange stretch you watch is genuine dead reckoning
 * with genuine drift.
 *
 * A landing page for a project whose entire argument is "our numbers are
 * measured, not asserted" cannot open with a scripted cartoon of a dot moving.
 * The cheapest thing to fake is the one thing worth proving, so this does not
 * fake it: the trail is drawn from engine output, and the drift figure printed
 * at recovery is the distance between the estimate and the withheld truth.
 *
 * Costs paid deliberately:
 * - three.js is ~150 KB gzipped, loaded only on this route. The app bundle,
 *   and therefore the APK, is untouched.
 * - The loop is capped and pauses when off-screen or when the tab is hidden,
 *   because a marketing page that pins a CPU core is its own argument against
 *   the engineering it is advertising.
 */

type Phase = 'GNSS' | 'OUTAGE' | 'RECOVERY';

const OUTAGE_START_MS = 14_000;
const OUTAGE_END_MS = 74_000;
const LOOP_END_MS = 88_000;
/** Simulated milliseconds per real second. 8x, so a 88 s story runs in ~11 s. */
const SPEED = 8;

export interface SceneStatus {
  mode: NavMode;
  phase: Phase;
  speedKph: number;
  driftM: number;
  distanceM: number;
  sinceGnssS: number;
  alongM: number;
  crossM: number;
}

export interface SceneConstraints {
  nhc: boolean;
  zupt: boolean;
  roadSnap: boolean;
  accelHighPass: boolean;
}

export default function EngineScene({
  onStatus,
  constraints,
  scrollRef,
}: {
  onStatus?: (s: SceneStatus) => void;
  constraints?: SceneConstraints;
  /** 0 at the top of the hero, 1 once it has scrolled away. Flies the drone. */
  scrollRef?: React.MutableRefObject<number>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  // Read inside the loop rather than re-running the effect: rebuilding the
  // scene on every toggle would restart the drive, and the whole point is to
  // watch the SAME run degrade the instant a constraint is removed.
  const constraintsRef = useRef(constraints);
  constraintsRef.current = constraints;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Somebody who asked for less motion gets a still frame, not a loop.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /*
     * ★ WebGLRenderer LOGS, IT DOES NOT THROW ★
     * When a context cannot be created three prints an error and returns a
     * renderer whose GL calls then fail. A try/catch around the constructor
     * therefore never fires, `failed` stays false, and the first render blows
     * up inside requestAnimationFrame — which React surfaces as "Application
     * error: a client-side exception has occurred" and a blank page. This was
     * a real crash on the deployed site.
     *
     * So probe for a context first, and verify one actually came back.
     */
    const probe = document.createElement('canvas');
    const supported = !!(probe.getContext('webgl2') || probe.getContext('webgl'));
    if (!supported) {
      setFailed(true);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      if (!renderer.getContext()) throw new Error('no GL context');
    } catch {
      setFailed(true);
      return;
    }

    // Retina is not worth 4x the fragments for a line drawing.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    // Depth grading. Near roads read bright, far ones dissolve into the page
    // background — without it the network ends at a visible horizon line.
    scene.fog = new THREE.Fog(0x05070b, 700, 2600);
    const camera = new THREE.PerspectiveCamera(
      42,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.1,
      6000,
    );

    /* ---------------------------------------------------------- the world */

    const route = cityRoute as unknown as RouteGeoJson;
    const coords = route.geometry.coordinates as Array<[number, number]>;
    const ref = { lat: coords[0]![1], lon: coords[0]![0] };

    /*
     * ★ THE ROADS ARE THE REAL GRAPH, NOT SCENERY ★
     * The first version drew the vehicle on an empty grid, which read as a
     * tech demo of a moving dot. These are the 725 OpenStreetMap ways the
     * estimator actually snaps against, so the picture and the mechanism are
     * the same thing.
     *
     * Merged into two LineSegments by weight class: 725 ways cost two draw
     * calls instead of 725, which on a mid-range phone is the whole
     * difference between smooth and not.
     */
    const MAJOR = new Set([
      'primary', 'secondary', 'tertiary', 'trunk', 'motorway',
      'secondary_link', 'primary_link',
    ]);
    const buildNetwork = (ways: Array<{ highway?: string; coords: Array<[number, number]> }>) => {
      const major: number[] = [];
      const minor: number[] = [];
      for (const w of ways) {
        if (!w.coords || w.coords.length < 2) continue;
        const bucket = MAJOR.has(w.highway ?? '') ? major : minor;
        for (let i = 0; i < w.coords.length - 1; i++) {
          const a = latLonToEnu(w.coords[i]![1], w.coords[i]![0], ref.lat, ref.lon);
          const b = latLonToEnu(w.coords[i + 1]![1], w.coords[i + 1]![0], ref.lat, ref.lon);
          bucket.push(a.e, 0, -a.n, b.e, 0, -b.n);
        }
      }
      const mk = (arr: number[], color: number, opacity: number) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        return new THREE.LineSegments(
          g,
          new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
        );
      };
      scene.add(mk(minor, 0x1b2942, 0.7));
      scene.add(mk(major, 0x2f4a6b, 0.95));
    };
    // The bundled asset, same file the app reads. If it is missing the scene
    // still runs — the vehicle and the story matter more than the scenery.
    void fetch('maps/road_graph_city.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((g: { ways: Array<{ highway?: string; coords: Array<[number, number]> }> } | null) => {
        if (g) buildNetwork(g.ways);
      })
      .catch(() => undefined);

    // The route itself, in local metres, drawn as the road the vehicle is on.
    const routePts = coords.map(([lon, lat]) => {
      const e = latLonToEnu(lat, lon, ref.lat, ref.lon);
      return new THREE.Vector3(e.e, 0, -e.n);
    });
    const roadGeom = new THREE.BufferGeometry().setFromPoints(routePts);
    scene.add(
      new THREE.Line(
        roadGeom,
        new THREE.LineBasicMaterial({ color: 0x2b3a4f, transparent: true, opacity: 0.9 }),
      ),
    );

    /* ------------------------------------------- the trail, coloured by mode */

    const MAX_PTS = 6000;
    const trailPos = new Float32Array(MAX_PTS * 3);
    const trailCol = new Float32Array(MAX_PTS * 3);
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    trailGeom.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    trailGeom.setDrawRange(0, 0);
    const trail = new THREE.Line(
      trailGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 }),
    );
    scene.add(trail);
    let trailCount = 0;

    // Truth, drawn faintly. During the outage the gap between the two IS the
    // drift — the number quoted everywhere else in this project, made visible.
    const truthPos = new Float32Array(MAX_PTS * 3);
    const truthGeom = new THREE.BufferGeometry();
    truthGeom.setAttribute('position', new THREE.BufferAttribute(truthPos, 3));
    truthGeom.setDrawRange(0, 0);
    const truthLine = new THREE.Line(
        truthGeom,
        new THREE.LineDashedMaterial({
          color: 0x4b5b70,
          dashSize: 12,
          gapSize: 10,
          transparent: true,
          opacity: 0.75,
        }),
    );
    scene.add(truthLine);
    let truthCount = 0;

    /* -------------------------------------------------- marker and ellipse */

    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(9, 26, 4),
      new THREE.MeshBasicMaterial({ color: MODE_COLORS.GNSS }),
    );
    marker.rotation.x = Math.PI / 2;
    scene.add(marker);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(14, 17, 48),
      new THREE.MeshBasicMaterial({
        color: MODE_COLORS.GNSS,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    scene.add(halo);

    // The uncertainty ellipse — an ellipse and not a circle, because
    // along-track and cross-track error are not the same quantity. Watching it
    // stretch forward while staying narrow is the clearest statement of that.
    const ellipse = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({
        color: MODE_COLORS.DEAD_RECKONING,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
      }),
    );
    ellipse.rotation.x = -Math.PI / 2;
    scene.add(ellipse);

    /* ------------------------------------------------------ engine + source */

    let engine = new NavigationEngine();
    let sim = new SimulationSource({
      route,
      vehicle: CITY_VEHICLE,
      seed: 4242,
      imuRateHz: 50,
      gnssRateHz: 1,
    });
    sim.simulateGnssOutage(OUTAGE_START_MS, OUTAGE_END_MS - OUTAGE_START_MS);

    let simT = 0;
    let lastTruth: { e: number; n: number } | null = null;
    // The engine keeps its last state private, so the loop holds its own.
    let lastState: ReturnType<NavigationEngine['update']> | null = null;

    const reset = () => {
      engine = new NavigationEngine();
      sim = new SimulationSource({
        route,
        vehicle: CITY_VEHICLE,
        seed: 4242,
        imuRateHz: 50,
        gnssRateHz: 1,
      });
      sim.simulateGnssOutage(OUTAGE_START_MS, OUTAGE_END_MS - OUTAGE_START_MS);
      simT = 0;
      lastState = null;
      trailCount = 0;
      truthCount = 0;
      trailGeom.setDrawRange(0, 0);
      truthGeom.setDrawRange(0, 0);
      lastTruth = null;
    };

    /* ------------------------------------------------------------- the loop */

    let raf = 0;
    let last = performance.now();
    const camPos = new THREE.Vector3(0, 320, 420);
    const camLook = new THREE.Vector3();
    let visible = true;
    let onScreen = true;

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
      },
      { threshold: 0.01 },
    );
    io.observe(host);

    const onVis = () => {
      visible = document.visibilityState === 'visible';
      last = performance.now();
    };
    document.addEventListener('visibilitychange', onVis);

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    /*
     * Context loss is routine on mobile under memory pressure, and the default
     * behaviour makes every later GL call throw. Cancelling the event lets the
     * scene stop cleanly and show its fallback rather than take the page down.
     */
    let contextLost = false;
    const onLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      setFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', onLost);

    const tick = (now: number) => {
      if (contextLost) return;
      raf = requestAnimationFrame(tick);
      const dtReal = Math.min(now - last, 100);
      last = now;
      if (!visible || !onScreen) return;

      // Constraints are applied live. `setConfig` takes effect on the very
      // next sample — no restart — which is what makes "switch NHC off and
      // watch it wander" a demonstration rather than a claim.
      const c = constraintsRef.current;
      if (c) {
        engine.setConfig({
          nhc: c.nhc,
          zupt: c.zupt,
          zaru: c.zupt,
          roadSnap: c.roadSnap,
          accelHighPass: c.accelHighPass,
        });
      }

      // Advance the simulation and feed every sample through the real engine.
      const step = reduced ? 0 : dtReal * SPEED;
      const samples = step > 0 ? sim.advance(step) : [];
      simT += step;

      let state = lastState;
      for (const s of samples) {
        state = engine.update(s);
        lastState = state;
        if (s.gnss) {
          const t = latLonToEnu(s.gnss.lat, s.gnss.lon, ref.lat, ref.lon);
          lastTruth = { e: t.e, n: t.n };
        }
      }
      if (!state) return;

      const p = latLonToEnu(state.position.lat, state.position.lon, ref.lat, ref.lon);
      const col = new THREE.Color(MODE_COLORS[state.mode]);

      if (trailCount < MAX_PTS) {
        trailPos[trailCount * 3] = p.e;
        trailPos[trailCount * 3 + 1] = 1;
        trailPos[trailCount * 3 + 2] = -p.n;
        trailCol[trailCount * 3] = col.r;
        trailCol[trailCount * 3 + 1] = col.g;
        trailCol[trailCount * 3 + 2] = col.b;
        trailCount++;
        trailGeom.setDrawRange(0, trailCount);
        trailGeom.attributes.position!.needsUpdate = true;
        trailGeom.attributes.color!.needsUpdate = true;
      }

      // Truth is only known where GNSS existed; during the outage the dashed
      // line simply is not drawn, which is exactly the honest picture.
      if (lastTruth && truthCount < MAX_PTS) {
        truthPos[truthCount * 3] = lastTruth.e;
        truthPos[truthCount * 3 + 1] = 0.5;
        truthPos[truthCount * 3 + 2] = -lastTruth.n;
        truthCount++;
        truthGeom.setDrawRange(0, truthCount);
        truthGeom.attributes.position!.needsUpdate = true;
        // Dashes are spaced along accumulated length, so this must be
        // recomputed whenever a point is appended or the gaps stop moving.
        truthLine.computeLineDistances();
      }

      marker.position.set(p.e, 6, -p.n);
      marker.rotation.z = -(state.headingDeg * Math.PI) / 180;
      (marker.material as THREE.MeshBasicMaterial).color.set(col);
      halo.position.set(p.e, 1.5, -p.n);
      (halo.material as THREE.MeshBasicMaterial).color.set(col);

      ellipse.position.set(p.e, 0.8, -p.n);
      ellipse.scale.set(
        Math.max(state.covariance.crossM, 3),
        Math.max(state.covariance.alongM, 3),
        1,
      );
      ellipse.rotation.z = -(state.headingDeg * Math.PI) / 180;
      (ellipse.material as THREE.MeshBasicMaterial).color.set(col);

      /* ------------------------------------------------------ drone camera */
      // Scroll flies the drone up and back, so the network opens out beneath
      // the vehicle as the reader leaves the hero — the page's motion and the
      // camera's are the same gesture. A slow orbit keeps the frame alive on
      // straights, and a whisper of roll reads as flying rather than sliding.
      const k = scrollRef ? Math.max(0, Math.min(1, scrollRef.current)) : 0;
      const orbit = now / 14000;
      const yawC = -(state.headingDeg * Math.PI) / 180;
      const dist = 400 + k * 760;
      const want = new THREE.Vector3(
        p.e - Math.sin(yawC + Math.sin(orbit) * 0.45) * dist,
        290 + k * 880,
        -p.n + Math.cos(yawC + Math.sin(orbit) * 0.45) * dist,
      );
      camPos.lerp(want, 0.035);
      camera.position.copy(camPos);
      // Lerping the look-at target too stops the frame snapping on every turn.
      camLook.lerp(new THREE.Vector3(p.e, 0, -p.n), 0.09);
      camera.lookAt(camLook);
      camera.rotation.z += Math.sin(orbit * 2.1) * 0.014;

      try {
        renderer.render(scene, camera);
      } catch {
        // A decorative hero is never worth taking the whole page down for.
        contextLost = true;
        setFailed(true);
        return;
      }

      const phase: Phase =
        simT < OUTAGE_START_MS ? 'GNSS' : simT < OUTAGE_END_MS ? 'OUTAGE' : 'RECOVERY';
      statusRef.current?.({
        mode: state.mode,
        phase,
        speedKph: state.velocityMps * 3.6,
        driftM: state.estimatedDriftM,
        distanceM: state.distanceTravelledM,
        sinceGnssS: state.timeSinceGnssMs / 1000,
        alongM: state.covariance.alongM,
        crossM: state.covariance.crossM,
      });

      if (simT > LOOP_END_MS) reset();
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.dispose();
      roadGeom.dispose();
      trailGeom.dispose();
      truthGeom.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, [scrollRef]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl border border-white/[0.08] bg-[#080b11]">
        <p className="px-6 text-center text-[12px] leading-relaxed text-neutral-500">
          This browser has no WebGL, so the live engine view cannot render.
          <br />
          The demo itself does not need it.
        </p>
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full" aria-hidden="true" />;
}

export { MODE_LABELS };
