# PathPulse — Code Map

Every source file in the project, what it does, and why it exists.

**~49,200 lines** of TypeScript across 5 packages, **710** lines of Java,
**3,481** lines of Python, **1,204** lines of build tooling, **91 test files /
1,464 tests**.

Companion to [PROJECT_REPORT.md](PROJECT_REPORT.md), which covers *results*.
This one covers *code*.

---

## Layout

```
packages/nav-core         14,474 lines   the estimator. Pure. No I/O.
packages/sensor-sources    1,544 lines   where samples come from
packages/eval              1,621 lines   how every number is produced
packages/edge-engine       1,388 lines   the 200 Hz deployable engine
apps/web                  11,229 lines   the app, the APK shell, the landing page
apps/web/android             710 lines   Java: foreground service + plugin
ml                         3,481 lines   Python: four models, end to end
scripts                    1,204 lines   build, road graphs, purity check
```

---

# 1 · `packages/nav-core` — the estimator

**The rule:** no `window`, `document`, `fetch`, `navigator`, `localStorage`,
React, or any Node API. Pure functions only. Enforced by
`scripts/check-core-purity.mjs`, which has caught three real violations.

That rule is why the identical code runs in a browser, in the APK, in headless
replay, in the ablation harness and in the 200 Hz edge engine.

### `types.ts` — 152 lines
The contracts everything else agrees on. `SensorSample` (IMU, GNSS, baro, mag),
`NavigationState` (what the UI gets at 10 Hz), `NavMode`, `Vec3`, `Quaternion`,
`EnuPoint`. Every field carries a comment about *provenance* — e.g.
`constellationsSimulated` travels with the counts, because the UI cannot be
trusted to join provenance on at render time.

### `engine/NavigationEngine.ts` — 3,240 lines
**The orchestrator.** One `update(sample)` per IMU sample, nine numbered steps:

| Step | What happens |
|---|---|
| 1 | Reject stale/duplicate samples (a backwards clock sends the position flying) |
| 2–4 | Condition the IMU: attitude, filters, stationarity, ZUPT/ZARU harvest, alignment, motion classifier |
| 5 | Propagate dead reckoning — **always, in every mode** (shadow mode) |
| 5b | GNSS anomaly detection + Model 4 fix-quality classification |
| 6 | Step the state machine |
| 7 | Reconcile with GNSS according to mode (adopt / seed / blend) |
| 7b | Phase 13 Model 3 residual correction |
| 7c | Phase 17 particle filter + turn relocalisation |
| 8 | Road snapping — the last constraint before emit |
| 9 | Emit `NavigationState` |

Shadow mode is the reason the GNSS→dead-reckoning switch costs **0 ms**: the
estimator was already running and already corrected.

### `deadreckoning/DeadReckoningEngine.ts` — 506 lines
Integrates position from inertial data. Carries velocity as a **2-D ENU
vector**, not a scalar speed — with a scalar, motion can only ever be along the
heading, NHC is satisfied by construction, and switching it off in the ablation
would change nothing. Speed priority: GNSS Doppler → step model → ML model →
decayed integration. `distanceFloorMps` exists because a path length only ever
grows, so 0.2 m/s of residual jitter at 60 Hz banks 12 m a minute.

### `state/`
- **`NavigationStateMachine.ts` (370)** — the six modes and every transition.
  Adaptive fix timeout: tracks the receiver's *actual* cadence instead of
  assuming 1 Hz, because a 0.2 Hz handset was being told it had lost GNSS.
- **`SessionStats.ts` (181)** — session totals for the stats tab.
- **`events.ts` (105)** — the event log taxonomy. 20 event types, each
  documented with why it must never be silent.

### `fusion/RecoveryBlender.ts` — 225 lines
GNSS returning must not teleport the marker. Bounds the **rate** (60 m/s peak),
not the duration — a 600 m correction over a fixed 2 s moves the marker at
300 m/s, which is a teleport with better manners. Past 400 m it resets and
*says so*, because a fake smooth correction is worse than an explicit jump.

### `alignment/`
- **`attitude.ts` (339)** — the single most important fix in the project.
  Yaw is rotation about the *measured vertical*, `-(ω · up̂)`, not about device
  Z. Complementary filter: gyro for the short term, accelerometer as a slow
  anchor, gated so a motorway on-ramp cannot drag the vertical with it.
- **`autoAlign.ts` (Phase 12)** — PCA over straight-line acceleration finds the
  forward axis; the sign comes from the speed derivative. Watches gravity to
  notice the phone being knocked.
- **`altimeter.ts`** — barometric altitude, **relative only**. A phone
  barometer cannot measure altitude (weather moves sea-level pressure by
  hundreds of metres of apparent height) but is excellent at *change*.
- **`simpleAlignment.ts` (115)**, **`gravity.ts` (30)**.

### `constraints/` — the physics that makes it work
- **`nhc.ts` (101)** — a vehicle cannot slide sideways. **57.5 % → 33.5 %**.
- **`zupt.ts` (151)** — stopped means exactly zero, plus free accel-bias
  calibration at every red light.
- **`zaru.ts` (126)** — stopped means the gyro reading is pure bias. 0.01 rad/s
  of bias is 113° of heading error over a 197 s outage.
- **`speedclamp.ts` (80)** — plausibility ceiling and the coasting decay: an
  accelerometer cannot tell a parked car from one cruising at 50 km/h.
- **`roadsnap.ts` (364)** — cross-track only, *bounded* along-track. Full
  strength during dead reckoning, rate-limited to 60 m/s, widened search when
  the ordinary one finds nothing.
- **`forwardBias.ts` (186)** — **ships off**, documented negative result.

### `eskf/` — Phase 11
- **`ErrorStateKalmanFilter.ts` (545)** — 15 states, Joseph form, reset
  Jacobian, seven measurement updates.
- **`matrix.ts` (213)** — dense linear algebra, zero dependencies. Gauss-Jordan
  inverse that *throws* rather than returning Infinity into a Kalman gain.
- **`quaternion.ts` (131)** — Hamilton convention, stated once and relied on.
- **`noise.ts` (122)** — three IMU grades. The noise model *is* the filter.

### `mapmatch/`
- **`RoadIndex.ts` (251)** — 100 m grid, segments stamped into every cell they
  cross (a 1 km road would otherwise be invisible from its middle). Plus
  `positionAt(way, arc)` by binary search, for the particle filter.
- **`RoadTopology.ts` (300)** — Phase 14. Junctions recovered **exactly** from
  shared OSM coordinates hashed to a centimetre grid — no tolerance to tune,
  and no welding a flyover to the road beneath it. Bounded Dijkstra + cache.
- **`hmm.ts` (440)** — Newson-Krumm. Emission = Gaussian on perpendicular
  distance; transition = |route − straight-line|, which is what makes a
  parallel carriageway implausible. Viterbi over a sliding window.
- **`turnDetector.ts` (269)** — classifies completed turns from the same
  corrected yaw rate the estimate integrates.

### `particle/` — Phase 17 ★
- **`ParticleFilter.ts` (735)** — 500 hypotheses in typed arrays. Branches
  randomly at junctions (weighted by road class and turn sharpness), reweights
  on heading / speed-limit / dead-reckoning agreement, **resamples stratified
  by hypothesis** so a 40 % branch keeps 40 % of the particles.
- **`TurnRelocaliser.ts` (306)** — searches the graph for the turn sequence just
  driven. Declines far more often than it answers: three turns, a unique match,
  distances that agree.

### `ml/` — the on-device inference layer
- **`cnn.ts` (425)** — the pure-TypeScript network runner. **One
  implementation, four models.** No ONNX Runtime: 14 MB of WASM to multiply
  26,081 parameters would take the APK from 5.4 to ~20 MB.
- **`speedModel.ts` (238)** — Model 1 plumbing, ring buffer, smoother.
- **`motionModel.ts` (355)** — Model 2: 8 classes, softmax, and `MotionGate`,
  which holds a prediction to a confidence floor *and* consecutive agreement
  before the engine may act on it.
- **`residualModel.ts` (238)** — Model 3 + `clampResidual`, the guard that
  turned a −837 % failure into −49 %.
- **`gnssQualityModel.ts` (294)** — Model 4 + the tracker that computes the
  baselines identically in training and inference.

### `twowheeler/` — Phase 18B
- **`lean.ts` (115)** — `sin(lean) = v·ω/g`, closed form, no extra sensor.
- **`VehicleTypeDetector.ts` (154)** — does the *sensor* follow the force?
  Car ≈ 1, bike ≈ 0. Defaults to CAR and needs real evidence to leave it.

### The rest
`filters/` (lowpass, median, stationarity) · `geo/` (WGS84 ENU via Bowring's
closed form — no convergence loop in a 10 Hz budget) · `detect/spoofing.ts`
(three rules, advisory, never gates a fix) · `motion/` (pedestrian context and
step model) · `gnss/constellations.ts` (NavIC breakdown with provenance) ·
`confidence/ellipse.ts` · `trail/` · `trip/export.ts` (GPX + GeoJSON).

---

# 2 · `packages/sensor-sources` — where samples come from

One interface, six implementations. Swapping the source never touches
`nav-core`.

| File | Lines | Purpose |
|---|---|---|
| `types.ts` | 41 | `SensorSource`. `hasGyro?: undefined` means *not measured yet*, never *no gyroscope* |
| `simulation/SimulationSource.ts` | 289 | A virtual vehicle — pure physics, usable in tests |
| `simulation/vehicle.ts` | 170 | Kinematics |
| `simulation/imu.ts` | 106 | Synthetic IMU — **and the reason the ML models don't transfer** |
| `simulation/route.ts` | 120 | Route following |
| `simulation/rng.ts` | 43 | Seeded, so every run reproduces |
| `web/WebSource.ts` | 152 | DeviceMotion + `navigator.geolocation` |
| `native/NativeSource.ts` | 173 | Capacitor plugins — throttled with the screen off |
| `native/ForegroundSource.ts` | 259 | **Phase 15.** Batches from the native service. The only source that can honestly set `constellationsSimulated: false` |
| `replay/ReplaySource.ts` | 113 | A recorded log, with original timing |
| `recording/RecordingWrapper.ts` | 78 | Wraps any source and writes JSONL |

---

# 3 · `packages/eval` — where every number comes from

**Nothing in this project claims a number it cannot reproduce.**

| File | Lines | Produces |
|---|---|---|
| `harness.ts` | 187 | Replays a log, punches a software outage, scores it. *The withheld GNSS is the truth, so it cannot have been fitted to.* |
| `metrics.ts` | 267 | Drift %, along/cross decomposition, CEP95, recovery time |
| `ablation.ts` | 111 | `pnpm ablation` → the headline table |
| `report.ts` | 268 | Markdown, CSV, JSON and the SVG chart |
| `offroad.ts` | 174 | `pnpm eval:offroad` — **the metric drift cannot see** |
| `alignment.ts` | 223 | `pnpm eval:alignment` — rotates the IMU by a known angle |
| `drift-dataset.ts` | 95 | Training rows for Model 3, read through `engine.driftFeatures` |
| `gnss-quality-dataset.ts` | 258 | Training rows for Model 4 — modelled corruptions of *real* fixes |
| `paths.ts` · `cli.ts` · `record.ts` | 308 | Config loading, single-run CLI, recording |

---

# 4 · `packages/edge-engine` — the 200 Hz deliverable

Contains **no navigation mathematics of its own.** Adapters, a driven loop and
a report; every line of estimation is the byte-for-byte code the handset runs.

| File | Lines | Purpose |
|---|---|---|
| `runner.ts` | 117 | The driven loop. The engine owns the clock, so replay runs as fast as the CPU allows |
| `cli.ts` | 193 | `pnpm edge` — grades, rates, inputs, outputs |
| `bench.ts` | 192 | The sustained-rate and latency benchmark |
| `grades.ts` | 110 | PHONE_MEMS / TACTICAL / FOG. *We do not own the hardware, and say so* |
| `output.ts` | 124 | File · stdout · UDP broadcast · fan-out. Streamed, so an interrupted run isn't empty |
| `sources/UdpImuSource.ts` | 129 | JSON datagrams. **UDP not TCP:** a retransmitted IMU sample arrives late and is discarded anyway |
| `sources/SerialImuSource.ts` | 164 | UART, JSON or bare CSV. `serialport` optional — it builds a native addon |
| `sources/FogSimulatorSource.ts` | 164 | Datasheet-grade synthetic IMU |
| `sources/ReplayFileSource.ts` | 137 | Recorded logs |
| `Dockerfile` | — | Builds from the repo root, because `nav-core` is a workspace sibling |

---

# 5 · `apps/web` — the application

### Routes
- **`app/page.tsx` (672)** — the navigation screen: map, HUD, panels, source
  selection, permission gating, error boundaries.
- **`app/about/page.tsx` (561)** — the landing page.

### Hooks — where the app's state actually lives
| File | Lines | Purpose |
|---|---|---|
| `useNavigationEngine.ts` | 585 | Owns the engine. Loads **four models** in four independent effects, so one broken network never disables the others |
| `useSensorSource.ts` | 470 | Source selection: `ForegroundSource` → `NativeSource` → `WebSource`, each **checked** rather than assumed |
| `useGeolocation.ts` | 157 | Permission and fix plumbing |
| `useOfflineStatus.ts` | 100 | Radio state, worker state, cached tiles |
| `useDemoMode.ts` (88) · `useTour.ts` (69) · `useKeepAlive.ts` (33) | | Demo script, guided tour, server keep-alive |

### Components
`TrustPanel.tsx` (970) is the anti-fake evidence panel — raw sensors,
constraint toggles, all four models, alignment, event log, stats.
`Hud.tsx` (300), `MapView.tsx`, `VehicleMarker.tsx` (159, with the confidence
ellipse), `MatchedRoadLayer.tsx`, `TrailLayer.tsx`, `OfflinePanel.tsx` (313,
downloads roads + tiles), `PitchScreen.tsx` (246, the in-app deck),
`SourcePicker.tsx`, `PermissionGate.tsx`, `TourOverlay.tsx`, `Splash.tsx`,
`Sheet.tsx`, `ErrorBoundary.tsx`, plus `landing/` (1,179 lines: live engine
hero, generated ablation table, road-graph map).

### Lib
| File | Lines | Purpose |
|---|---|---|
| `roadGraph.ts` | 119 | Graph lookup — bundled **and** downloaded, indistinguishable at use |
| `roadGraphFetch.ts` | 210 | Overpass query at runtime, same road classes as the build script |
| `roadGraphStore.ts` | 119 | IndexedDB. A city graph is 1–3 MB: too big for `localStorage` |
| `tileCache.ts` | 187 | Slippy-map arithmetic — which tiles cover a box, and how many |
| `offline.ts` | 140 | Service-worker registration and pre-cache messaging |
| `ml/*.ts` | 268 | Four model loaders. Fetch and parse only; the maths is in `nav-core` |
| `shownPosition.ts` · `demoScript.ts` · `pitch.ts` · `tour.ts` · `platform.ts` · `navMode.ts` · `keepAlive.ts` | | |

### `public/sw.js`
Cache-first tile worker with an explicit **host allowlist** (not a URL pattern —
that would eventually cache something that isn't a tile and serve it stale
forever), a 2,000-tile cap, and pre-caching with bounded concurrency.

---

# 6 · `apps/web/android` — Phase 15, native

| File | Lines | Purpose |
|---|---|---|
| `SensorLoopService.java` | 567 | Foreground service, PARTIAL wake lock, dedicated thread. Accel+gyro 100 Hz, barometer 5 Hz, magnetometer 10 Hz, `GnssStatus` with **C/N0 mean and spread**. Ring buffer of 2,000, oldest dropped *and counted* |
| `PathPulseSensorsPlugin.java` | 126 | The bridge. Deliberately thin — anything holding state would lose it exactly when the WebView is throttled |
| `MainActivity.java` | 17 | Registers the plugin **before** `super.onCreate` |

**One monotonic clock throughout.** `SensorEvent.timestamp` and
`Location.getElapsedRealtimeNanos()` are both elapsed-realtime;
`System.currentTimeMillis()` jumps on network time correction.

---

# 7 · `ml` — four models, end to end

| File | Lines | Purpose |
|---|---|---|
| `config.py` | — | Single source of truth. Window, rate, channels, splits, class lists, thresholds |
| `data/download.py` | 212 | IO-VNBD via the Git LFS batch API — 215 MB, not the 40-hour repo |
| `data/preprocess.py` | 292 | Model 1 windows. Augmentation: **plausible** phone mountings, not uniform SO(3) |
| `data/preprocess_motion.py` | 468 | Model 2 windows, CAN-bus labels, and the **rigid-mount screen** that dropped 24 of 26 sequences |
| `models/speed_cnn.py` (83) · `models/motion_cnn.py` (61) | | The two convolutional architectures |
| `train.py` (178) | | Model 1 + ridge + constant baselines |
| `train_motion.py` (237) | | Model 2. **Macro-F1, not accuracy** — 63 % of windows are STRAIGHT |
| `train_residual.py` (264) | | Model 3. Route-disjoint, both directions, clamped and unclamped |
| `train_gnss_quality.py` (241) | | Model 4. Prints *why the score means almost nothing* above the score |
| `export*.py` (595) | | ONNX + folded-weights JSON, verified against PyTorch to 1e-6 |
| `evaluate_position.py` (384) | | The ISRO screening artefact — the position plot |
| `check_sim_transfer.py` | — | **Do the models transfer to our simulated logs?** No, and this is the proof |

---

# 8 · `scripts` — build and data tooling

| File | Lines | Purpose |
|---|---|---|
| `check-core-purity.mjs` | 118 | **Golden Rule #1.** Strips comments and strings, then scans. Caught three real violations |
| `android-toolchain.mjs` | 186 | Finds a JDK 17–21 and the SDK **without Android Studio**. Names the missing thing instead of throwing a Gradle trace |
| `android-build.mjs` | 45 | Runs Gradle with that toolchain in its environment only |
| `strip-apk-from-assets.mjs` | 44 | Stops the APK containing the previous APK (12.8 → 25.1 MB in one build) |
| `build-road-graph.mjs` | 263 | OSM → road graph. Excludes footways: a car is not on the pavement |
| `make-routes.mjs` (172) · `make-demo-log.mjs` (81) · `make-offline-brief.mjs` (167) | | Demo assets |
| `publish-apk.mjs` (60) · `apk-path.mjs` (14) · `clean-dupes.mjs` (54) | | Release plumbing |

---

# 9 · Tests — 91 files, 1,464 tests

| Suite | Tests | What it guards |
|---|---|---|
| `nav-core` | 701 | The estimator, every constraint, every model contract |
| `apps/web` | 469 | UI, hooks, panels, offline |
| `eval` | 158 | The ablation itself, off-road, alignment |
| `sensor-sources` | 107 | Sources, the native bridge |
| `edge-engine` | 29 | Runner, grades, UDP, serial, sinks |

**The four that matter most:**

- **`invariants.test.ts`** — determinism, no non-finite output, and *Golden
  Rule #6* across every configuration **and** with a road graph that forces a
  way change mid-outage. It caught four regressions during this work, two of
  them introduced by fixes for something else.
- **`ablation.test.ts`** — asserts the published table, including that
  forward-bias, ESKF, HMM and the particle filter behave as documented. A
  component that stops earning its place fails a test.
- **`offroad.test.ts`** — asserts the marker is *on a road*, which no drift
  figure can.
- **Model contract tests** — load the **actual exported weights** and assert
  the class list and feature order match the engine. A reordered class list
  does not throw: the model stays 90 % accurate and every answer is wrong.

---

## How to read this codebase

1. **`types.ts`** — the contracts.
2. **`NavigationEngine.update()`** — the nine steps, in order.
3. **`constraints/`** — the physics, one file per idea.
4. **`packages/eval`** — where every number comes from.

The comments are the design record. Where something is surprising, the comment
says what was measured and what the alternative cost — most of them exist
because the obvious thing was tried first and was worse.
