# PathPulse — The Complete Project Report

**AI-ML based Intelligent Dead Reckoning for Seamless Navigation**
Smart India Hackathon · Problem Statement **SIH26168** · Sponsor **ISRO** · Team **Avinya**

> This document is the exhaustive one. It covers the problem, the architecture,
> every package, every source file, every algorithm with its formulas and
> default constants, every workflow (development, build, Android, ML, eval,
> deployment), every measured number and every negative result.
>
> Companions: [`docs/PROJECT_REPORT.md`](docs/PROJECT_REPORT.md) (results
> narrative), [`docs/CODE_MAP.md`](docs/CODE_MAP.md) (file index),
> [`PROJECT_STATUS.md`](PROJECT_STATUS.md) (phase-by-phase build log),
> [`README.md`](README.md) (usage).

---

## Table of contents

1. [The problem and the thesis](#1-the-problem-and-the-thesis)
2. [System architecture](#2-system-architecture)
3. [The golden rules](#3-the-golden-rules)
4. [Repository layout, in full](#4-repository-layout-in-full)
5. [Data contracts — `types.ts`](#5-data-contracts--typests)
6. [`packages/nav-core` — the estimator](#6-packagesnav-core--the-estimator)
   - 6.1 [The per-sample workflow: `NavigationEngine.update()`](#61-the-per-sample-workflow-navigationengineupdate)
   - 6.2 [Engine configuration — every flag and constant](#62-engine-configuration--every-flag-and-constant)
   - 6.3 [Geodesy](#63-geodesy)
   - 6.4 [Filters](#64-filters)
   - 6.5 [Attitude and alignment](#65-attitude-and-alignment)
   - 6.6 [Dead reckoning](#66-dead-reckoning)
   - 6.7 [The state machine](#67-the-state-machine)
   - 6.8 [Recovery blending](#68-recovery-blending)
   - 6.9 [The constraints](#69-the-constraints)
   - 6.10 [The Error-State Kalman Filter](#610-the-error-state-kalman-filter)
   - 6.11 [Map matching](#611-map-matching)
   - 6.12 [The particle filter and turn relocalisation](#612-the-particle-filter-and-turn-relocalisation)
   - 6.13 [On-device ML inference](#613-on-device-ml-inference)
   - 6.14 [Two-wheeler support](#614-two-wheeler-support)
   - 6.15 [Detection, GNSS, confidence, trail, trip export](#615-detection-gnss-confidence-trail-trip-export)
7. [`packages/sensor-sources` — where samples come from](#7-packagessensor-sources--where-samples-come-from)
8. [`packages/eval` — where every number comes from](#8-packageseval--where-every-number-comes-from)
9. [`packages/edge-engine` — the 200 Hz deliverable](#9-packagesedge-engine--the-200-hz-deliverable)
10. [`apps/web` — the application](#10-appsweb--the-application)
11. [`apps/web/android` — the native layer](#11-appswebandroid--the-native-layer)
12. [`ml` — four models, end to end](#12-ml--four-models-end-to-end)
13. [`scripts` — build and data tooling](#13-scripts--build-and-data-tooling)
14. [`configs` and `data` — the ablation inputs](#14-configs-and-data--the-ablation-inputs)
15. [Results](#15-results)
16. [Tests](#16-tests)
17. [Workflows, end to end](#17-workflows-end-to-end)
18. [Deployment](#18-deployment)
19. [What ships disabled, and why](#19-what-ships-disabled-and-why)
20. [Honesty ledger](#20-honesty-ledger)
21. [Problem-statement compliance](#21-problem-statement-compliance)
22. [What remains](#22-what-remains)
23. [Command reference](#23-command-reference)

---

## 1 · The problem and the thesis

### 1.1 What breaks

GNSS fails exactly where navigation matters most: tunnels, underpasses,
basement car parks, urban canyons, dense foliage. India has roughly 300 million
vehicles and no fallback for any of them.

Google Maps handles this by **interpolating along a route it planned**. It
works, and it fails in one specific way: take an unplanned turn inside a tunnel
and it is confidently wrong, because with no route there is nothing to
interpolate along.

### 1.2 What PathPulse does instead

Estimate motion from **physics**, then constrain that estimate with facts that
are always true:

| Constraint | The physics | Measured worth |
|---|---|---|
| **NHC** | a vehicle cannot slide sideways or fly | 57.5 % → 33.5 % drift |
| **ZUPT** | a stopped vehicle has *exactly* zero velocity | 57.7 % → 57.5 %, and it re-calibrates accel bias free |
| **ZARU** | a stopped vehicle's gyro reading is *pure bias* | 59.3 % → 57.7 %; 0.01 rad/s of bias is 113° over a 197 s outage |
| **Road snapping** | a vehicle is on a road, and that fact is perpendicular to it | off-road error 15.7 m → 0.8 m mean |
| **Accel high-pass** | real acceleration averages to zero over a minute; tilt error does not | 30.2 % → 14.6 % |

No route required. No network required. No special hardware.

### 1.3 What the problem statement demands

> "The final deliverable must be a working mobile application **and** an Edge
> deployable software engine."

Not *or*. Both — and in this project they are the same estimator, byte for
byte, differing only in the adapters wrapped around it.

---

## 2 · System architecture

```
                    nav-core   (pure TypeScript, zero I/O, zero dependencies)
                                          │
        ┌─────────────────┬───────────────┼───────────────┬──────────────────┐
        │                 │               │               │                  │
   Browser          Android APK      Replay tests    Ablation harness    Node edge engine
   (1 s reload)    (real sensors)     (headless)      (the numbers)     (200 Hz, UDP/serial)
```

### 2.1 The layered view

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PRESENTATION      apps/web            Next.js 14 · React 18 · MapLibre   │
│                   app/page.tsx        map, HUD, panels, permission gate  │
│                   components/         TrustPanel, Hud, OfflinePanel, …   │
│                   hooks/              useNavigationEngine, useSensorSource│
└──────────────────────────────────────────────────────────────────────────┘
                                   │ NavigationState @ 10 Hz
┌──────────────────────────────────────────────────────────────────────────┐
│ ESTIMATION        packages/nav-core   NavigationEngine.update(sample)     │
│                   pure functions      constraints · ESKF · HMM · particles│
│                   no window/fetch/fs  four ML models, pure-TS inference   │
└──────────────────────────────────────────────────────────────────────────┘
                                   ▲ SensorSample
┌──────────────────────────────────────────────────────────────────────────┐
│ ACQUISITION       packages/sensor-sources                                 │
│                   Simulation · Web · Native · Foreground · Replay · Record│
└──────────────────────────────────────────────────────────────────────────┘
                                   ▲
┌──────────────────────────────────────────────────────────────────────────┐
│ PLATFORM          apps/web/android    SensorLoopService (Java)            │
│                   foreground service · wake lock · GnssStatus · 100 Hz IMU│
└──────────────────────────────────────────────────────────────────────────┘

SIDE CHANNELS
  packages/eval        replay + artificial outage + scoring → docs/benchmarks.md
  packages/edge-engine  the same engine at 200 Hz over UDP / serial / Docker
  ml                    PyTorch training → ONNX + folded-JSON weights → nav-core
```

### 2.2 Why the layering is exactly this

- **The estimator has no I/O**, so the same instructions run in five hosts.
  A bug reproduced in a headless test is the bug on the phone.
- **The acquisition layer is swappable**, so the app can be developed against a
  deterministic simulator and shipped against a foreground service.
- **The evaluation layer is separate from both**, so a number can never be
  produced by the code that benefits from it. Ground truth is the log's own
  withheld GNSS.

---

## 3 · The golden rules

These are the constraints the codebase is written under. Each has a mechanical
enforcement or a test.

### Rule 1 — `nav-core` is pure

Nothing in `packages/nav-core` may reference `window`, `document`, `fetch`,
`navigator`, `localStorage`, React, or any Node API.

```bash
pnpm lint:core-purity     # ✔ nav-core is pure — 69 files, 0 violations
```

`scripts/check-core-purity.mjs` strips comments and string literals first, then
scans. It has caught three genuine violations — each time a local variable
named `window` shadowing the browser global, and each time the clearer name
(`stretch`, `imuWindow`, `observations`) was better anyway.

That rule is why the edge engine took days instead of weeks.

### Rule 2 — the engine is deterministic and driven by `sample.t`

Not by wall clock. Asserted in `packages/nav-core/test/invariants.test.ts`:
identical input produces byte-identical output. This is the property that makes
Phase 15's batched native sensor loop correct — ten buffered samples delivered
in one burst produce *exactly* the estimate ten samples at 10 Hz would.

### Rule 3 — measure, don't assert

Every claim in this repository has a command next to it that reproduces it.

### Rule 4 — ship the negative results

Four components are disabled by default with published numbers explaining why
(§19). A judge asking "what did you build that didn't work?" gets four numbers.

### Rule 5 — provenance travels with the number

`constellationsSimulated` rides inside the same object as the constellation
counts, because the UI cannot be trusted to join provenance on at render time —
that flips one render before a stale fix is cleared, and for that frame an
invented sky is labelled MEASURED.

### Rule 6 — the dot never teleports

Enforced by tests that measure the largest single-sample marker movement across
every configuration. It caught four separate regressions, two of which were
introduced by *fixes for something else*.

### Rule 7 — a detector never gates the fix it is suspicious of

Spoofing detection and Model 4 are advisory. They may lower the confidence bar.
They may not reject a fix, move the position, or change what is integrated. A
false positive would otherwise turn a suspicion into a navigation failure.

---

## 4 · Repository layout, in full

```
PathPulse/
├── apps/
│   └── web/                     Next.js 14 static export + Capacitor APK shell
│       ├── app/                 routes: / (navigation), /about (landing)
│       ├── components/          38 components incl. landing/
│       ├── hooks/               8 hooks — the app's state lives here
│       ├── lib/                 road graph, tiles, offline, ML loaders, export
│       ├── config/              map.ts, modes.ts
│       ├── public/              models, maps, benchmarks, replay, sw.js, APK
│       └── android/             Capacitor Android project + 3 Java files
├── packages/
│   ├── nav-core/                the estimator — pure TypeScript (14,474 lines)
│   ├── sensor-sources/          six SensorSource implementations (1,544)
│   ├── eval/                    harness, metrics, ablation, reports (1,621)
│   └── edge-engine/             the 200 Hz deployable engine (1,388)
├── ml/                          Python: four models end to end (3,481)
│   ├── data/                    download, preprocess, preprocess_motion
│   ├── models/                  speed_cnn.py, motion_cnn.py
│   ├── results/                 metrics JSON, plots, .pt checkpoints
│   └── export/                  ONNX + folded-weights JSON
├── scripts/                     build, road graphs, purity check (1,204)
├── configs/                     12 ablation configurations
├── data/
│   ├── replay/                  4 committed simulated logs (JSONL)
│   ├── maps/                    3 road graphs + index
│   └── routes/                  city and highway routes
├── docs/                        report, code map, benchmarks, protocols
├── .github/workflows/           keepalive.yml
├── server.mjs                   zero-dependency static server with /health
├── render.yaml                  deployment
├── pnpm-workspace.yaml          apps/* and packages/*
└── tsconfig.base.json           strict, noUncheckedIndexedAccess, ES2022
```

### 4.1 Size

| Area | Lines |
|---|---|
| `packages/nav-core` | 14,474 |
| `apps/web` | 11,229 |
| `packages/eval` | 1,621 |
| `packages/sensor-sources` | 1,544 |
| `packages/edge-engine` | 1,388 |
| `apps/web/android` (Java) | 710 |
| `ml` (Python) | 3,481 |
| `scripts` | 1,204 |
| **Total source** | **~49,200 TS + 3,481 Py + 710 Java + 1,204 tooling** |
| Tests | 91 files, 1,464 tests |

### 4.2 Toolchain

| Thing | Version / choice | Why |
|---|---|---|
| Package manager | pnpm 10.11.0, workspaces | `onlyBuiltDependencies: [esbuild]` lives in `pnpm-workspace.yaml`, because pnpm 10 ignores the `package.json` field with a warning on every command |
| Node | ≥ 20 (Render pins 22) | `next build` and `tsx` |
| TypeScript | 5.6, `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals` | indexing a typed array returns `T | undefined`, which is what caught several off-by-one reads |
| Test runner | Vitest 2.1 | one config per package |
| UI | Next 14 (`output: 'export'`), React 18, Tailwind 3.4, MapLibre GL 5, three.js | static export is set on day one so a stray server component fails the *web* build, not the APK |
| Mobile | Capacitor 6 (Android) | wraps `out/` |
| ML | PyTorch → ONNX + folded-weights JSON | inference is pure TypeScript in nav-core |
| Runtime deps in `nav-core` | **zero** | including the linear algebra |

---

## 5 · Data contracts — `types.ts`

`packages/nav-core/src/types.ts` (152 lines) is the agreement every other file
holds to. Every field carries a comment about *provenance*.

### 5.1 `SensorSample` — what goes in

```ts
interface SensorSample {
  t: number;                 // monotonic ms. NOT wall clock. Must never go backwards.
  gnss?: {
    lat, lon: number;
    accuracyM: number;       // horizontal 1-sigma, metres
    speedMps?: number;       // Doppler, when the receiver reports it
    headingDeg?: number;
    satCount?: number;
    meanCn0?: number;        // dB-Hz. Low ⇒ multipath.
    cn0Spread?: number;      // std across tracked sats — native only
    hdop?: number;
    constellations?: Partial<Record<string, number>>;   // GPS/GLONASS/Galileo/BeiDou/NavIC/QZSS
    constellationsSimulated?: boolean;                  // provenance, travels with the counts
  };
  imu?: {
    ax, ay, az: number;      // specific force, m/s², DEVICE frame, gravity INCLUDED
    gx, gy, gz: number;      // angular rate, rad/s, DEVICE frame, RIGHT-HAND RULE
    quat?: Quaternion;       // [w,x,y,z] if the device exposes a rotation vector
  };
  baro?: { pressureHpa: number };
}
```

Two contract points that cost real bugs to learn:

- **`cn0Spread` is the field the mean cannot replace.** A signal bounced off a
  building arrives weak while its neighbours arrive normally, so multipath
  *widens* the spread while lowering the mean. A spoofer transmitting one clean
  signal to every channel does the opposite: the spread *collapses*. Model 4
  reads both, and neither alone separates the two cases. It needs Android's
  `GnssStatus`, so it exists only on the Phase 15 native source.
- **Gyro axes must not be pre-converted to a compass sense.** nav-core resolves
  yaw by projecting the gyro vector onto measured gravity, which needs the raw
  axes; converting early also assumes the phone is lying flat. Viewed from
  above with +Z out of the screen, a right turn is *negative*.

### 5.2 `NavigationState` — what comes out, at 10 Hz

```ts
interface NavigationState {
  t: number;
  mode: NavMode;                     // INITIALIZING | GNSS | GNSS_DEGRADED
                                     // | DEAD_RECKONING | RECOVERING | ERROR
  position: { lat, lon };
  velocityMps: number;
  headingDeg: number;
  covariance: { alongM, crossM, headingDeg };   // decomposed, not a radius
  confidence: number;                           // 0..1
  distanceTravelledM: number;
  timeSinceGnssMs: number;
  estimatedDriftM: number;
  matchedRoad?: { wayId, arcLengthM, name? };
  lastTurn?: { t, kind, deltaDeg, label };      // "RIGHT 87°", pre-formatted
  gnssAnomaly?: { t, kind, message };           // ADVISORY ONLY
  biases: { accel: Vec3; gyro: Vec3 };
}
```

**Why covariance is along/cross and not one radius.** Road snapping bounds
cross-track error while along-track error keeps growing. That asymmetry is the
whole story of an outage, and it is why the UI draws an *ellipse*.

### 5.3 Supporting types

`NavMode`, `Quaternion = [w,x,y,z]`, `Vec3 = [x,y,z]`, `EnuPoint = {e,n,u?}`,
`LatLon = {lat,lon}`.

---

## 6 · `packages/nav-core` — the estimator

69 source files, 14,474 lines, zero dependencies, zero I/O. Barrel exports in
`src/index.ts` re-export every subsystem, so consumers write
`import { NavigationEngine } from '@pathpulse/nav-core'`.

Package structure:

```
src/
├── types.ts                    the contracts
├── engine/NavigationEngine.ts  3,240 lines — the orchestrator
├── geo/                        angles, constants, distance, enu
├── filters/                    lowpass, median, stationarity
├── alignment/                  attitude, autoAlign, simpleAlignment, gravity, altimeter
├── deadreckoning/              DeadReckoningEngine
├── state/                      NavigationStateMachine, SessionStats, events
├── fusion/                     RecoveryBlender
├── constraints/                nhc, zupt, zaru, speedclamp, roadsnap, forwardBias
├── eskf/                       ErrorStateKalmanFilter, matrix, quaternion, noise
├── mapmatch/                   RoadIndex, RoadTopology, hmm, turnDetector, types
├── particle/                   ParticleFilter, TurnRelocaliser
├── ml/                         cnn, speedModel, motionModel, residualModel, gnssQualityModel
├── twowheeler/                 lean, VehicleTypeDetector
├── motion/                     context, steps
├── detect/                     spoofing
├── gnss/                       constellations
├── confidence/                 ellipse
├── trail/                      trail accumulation
└── trip/                       export (GPX + GeoJSON)
```

### 6.1 The per-sample workflow: `NavigationEngine.update()`

One call per IMU sample. Nine numbered steps, in this order, every time, in
every mode.

```
                       SensorSample
                            │
 ┌──────────────────────────▼──────────────────────────────────────────┐
 │ 1  GUARD          reject stale / duplicate / backwards-clock samples │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 1b BAROMETER      fed first — both consumers below need it this step │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 2  DESPIKE        median(5) then low-pass(5 Hz @ 50 Hz) on accel     │
 │                   step detector reads the RAW magnitude, not this    │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 3  ATTITUDE       complementary filter; yaw about MEASURED vertical  │
 │                   plane-frame components taken BEFORE vehicle frame  │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 4  STATIONARITY   → ZUPT (zero velocity + accel-bias harvest)        │
 │                   → ZARU (gyro bias harvest)                         │
 │                   → auto-alignment PCA window                        │
 │                   → motion classifier (Model 2), gated               │
 │                   → two-wheeler lean compensation, before integration│
 │                   → accel high-pass DC, tracked in the PLANE frame   │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 5  PROPAGATE      dead reckoning — ALWAYS. This is shadow mode.      │
 │                   speed priority: GNSS Doppler → steps → ML → decay  │
 │                   ESKF runs in parallel on every sample regardless   │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 5b GNSS HEALTH    three-rule spoofing detector + Model 4 quality     │
 │                   both ADVISORY — neither may gate a fix             │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 6  STATE MACHINE  hysteresis, adaptive fix timeout, mode transition  │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 7  RECONCILE      GNSS: adopt a FRACTION of the gap (gain 0.25)      │
 │                   stationary: hold inside a 12 m radius              │
 │                   RECOVERING: rate-bounded blend, 60 m/s ceiling     │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 7b RESIDUAL       Model 3 correction, clamped to own covariance (off)│
 ├─────────────────────────────────────────────────────────────────────┤
 │ 7c PARTICLES      500 hypotheses + turn relocalisation (off)         │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 8  ROAD SNAP      cross-track only; along-track bounded to 25 m      │
 │                   HMM chooses the WAY, the snap chooses WHERE on it  │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 9  EMIT           build NavigationState, update covariance, confidence│
 └─────────────────────────────────────────────────────────────────────┘
```

#### Why shadow mode is the answer to "seamless handover in milliseconds"

Dead reckoning is **not started when GNSS fails**. It runs continuously in
every mode, being reset by each good fix. When GNSS drops there is nothing to
spin up and nothing to initialise — the estimate is already running and already
corrected. **The handover costs 0 ms because there is no handover.**

#### Step-by-step, with the reasons

**Step 1 — reject stale samples.** A backwards clock sends the position flying.
`lastSampleT` gates it. Duplicates are dropped.

**Step 2 — condition the IMU.** `Vec3MedianFilter(5)` removes pothole impulses;
`Vec3LowPassFilter(5 Hz, 50 Hz)` removes engine vibration. The **step detector
deliberately reads the raw magnitude**, because filtering removes exactly the
signal it looks for.

**Step 3 — attitude.** See §6.5. The single most important fix in the project:
yaw is `-(ω · up̂)`, rotation about the *measured vertical*, not about device Z.

**Step 4 — stationarity and everything hanging off it.**
- ZUPT is **interlocked**: a ZUPT asserted while the vehicle is moving is far
  more damaging than one missed while it is stopped.
- Model 2 may call a stop the thresholds miss, held to a *higher* confidence
  bar (0.85 vs 0.6) because the measured IDLING precision is 0.70.
- A pothole sample is **held, not zeroed** — the last good acceleration is
  reused rather than substituting zero, which would itself be a measurement.
- The 40 s tilt mean **freezes through corners**, because a corner's lateral
  acceleration is not tilt.
- Lean compensation runs **before anything integrates the yaw rate**.

**Step 5 — propagate.** Always. Speed source priority is
`GNSS Doppler → step model → ML model → decayed integration`, surfaced on the
HUD as `SpeedSource` so "is the AI actually doing anything?" has an on-screen
answer.

Two subtleties:
- **Doppler is held between fixes** for the receiver's own cadence
  (`gnssSpeedHoldMs` 3 s, capped at `gnssSpeedHoldMaxMs` 12 s). Before this,
  a 0.2 Hz receiver meant 299 samples in 300 carried no fix and the engine was
  dead reckoning for 99.7 % of a run *while the badge said GNSS*.
- **The model declines outside its training domain.** `mlVehicleOnly` restricts
  the IO-VNBD car model to vehicle motion; asked about a swinging hand it
  answers confidently at the plausibility ceiling and the HUD reads a flat
  11 km/h whether the carrier is walking or the phone is on a table.

**Step 5b — GNSS health.** Three readable rules (§6.15) plus Model 4. Both
advisory.

**Step 6 — the state machine.** §6.7.

**Step 7 — reconcile.**
- **Do not teleport onto every fix.** `gnssPositionGain` 0.25 takes a quarter of
  the gap; dead reckoning carries the rest, which averages receiver noise out
  over a few fixes without letting a real error stand.
- **Hold still while stopped.** Inside `stationaryHoldRadiusM` (12 m) a fix that
  disagrees is receiver noise, not motion. A parked vehicle used to crawl in a
  slow scribble, and every one of those metres was written into the trail.
- **The blender works in unsnapped space and must**, or the snap and the blend
  fight each other.

**Step 7b/7c** — Model 3 and the particle filter, both off by default.

**Step 8 — road snapping.** The last constraint before emit. **Deliberately not
fed back into the estimate**: the snap is a display-and-covariance correction,
so a wrong match cannot corrupt the integrator it would then be scored against.

**Step 9 — emit.** Covariance growth is *derived* rather than guessed: heading
sigma grows from the assumed residual gyro bias, and cross-track error is
`distance × sin(heading σ)`.

### 6.2 Engine configuration — every flag and constant

`ConstraintFlags` — every one of these is an ablation-table row:

| Flag | Default | What it does |
|---|---|---|
| `medianFilter` | ✅ | 5-sample median on accel — pothole spikes |
| `lowPass` | ✅ | 5 Hz low-pass at 50 Hz — engine vibration |
| `nhc` | ✅ | non-holonomic constraint |
| `zupt` | ✅ | zero-velocity update |
| `zaru` | ✅ | zero-angular-rate update |
| `speedClamp` | ✅ | plausibility ceiling + coasting decay |
| `forwardBias` | ❌ | **negative result**: 12.7 % → 19.1 % |
| `accelHighPass` | ✅ | removes the slow mean of forward acceleration |
| `adaptiveTimeout` | ✅ | track the receiver's real cadence, not assume 1 Hz |
| `roadSnap` | ✅ | pull onto the nearest plausible road |
| `useMlSpeed` | ✅ | Model 1 — inert until a predictor reports ready |
| `mlVehicleOnly` | ✅ | refuse to answer outside the training domain |
| `pedestrianHeadingFromGnss` | ✅ | on foot, heading from GNSS not device yaw |
| `eskf` | ❌ | Phase 11 — runs always, this decides who *reads* it |
| `autoAlign` | ✅ | Phase 12 — PCA mount-offset estimation |
| `useMlMotion` | ✅ | Model 2 — inert until loaded |
| `useMlResidual` | ❌ | Model 3 — does not generalise |
| `useMlGnssQuality` | ✅ | Model 4 — **advisory only** |
| `hmmMatch` | ❌ | Phase 14 — 10.5 % vs 9.2 %, flat sweep |
| `particleFilter` | ❌ | Phase 17 — city 13.3 vs 15.1, highway 12.8 vs 3.2 |
| `turnRelocalisation` | ❌ | requires `particleFilter`; can move the marker discontinuously |
| `twoWheeler` | ✅ | Phase 18B — inert until the detector decides TWO_WHEELER |

`EngineConfig` adds the shapes and scalars:

| Constant | Default | Meaning |
|---|---|---|
| `trustedAccuracyM` | 20 | accuracy at or below which a fix may reset/seed |
| `gyroZSign` | 1 | axis-sense override |
| `confidenceTimeConstantMs` | 60 000 | confidence decays to 1/e after this without GNSS |
| `nhcStrength` | 0.95 | how much lateral velocity NHC removes — never 1.0 |
| `maxSpeedMps` | 40 | 144 km/h; Walking Mode drops it to 3 |
| `residualGyroBiasRadPerSec` | 0.001 | assumed bias once ZARU has converged |
| `uncorrectedGyroBiasRadPerSec` | 0.01 | assumed bias with ZARU off |
| `mlInferenceIntervalMs` | 500 | inference cadence — windows only advance 1 s |
| `accelHighPassTauMs` | 40 000 | long enough that a 20 s on-ramp survives |
| `gnssSpeedHoldMs` | 3 000 | how long a Doppler speed keeps aiding |
| `gnssSpeedHoldMaxMs` | 12 000 | ceiling on that hold |
| `gnssCourseMinBaselineS` | 10 | course window — **ends on time, never on distance** |
| `gnssPositionGain` | 0.25 | fraction of the gap adopted per fix |
| `stationaryHoldRadiusM` | 12 | wider than fix disagreement, narrower than real motion |
| `distanceFloorMps` | 0.3 | below this, movement is noise and is not banked |
| `hmmConfig` / `residualConfig` / `roadSnapConfig` | shapes | see the relevant section |

**Why `gnssCourseMinBaselineS` closes on time.** A window that closes as soon as
displacement is large enough is closed preferentially by *favourable noise*, and
every speed it reports is biased upward — a walk measured at 11 km/h.

**Why `distanceFloorMps` exists.** A path length only ever grows, so 0.2 m/s of
residual jitter at 60 Hz banks 12 m a minute of travel that never happened.

### 6.3 Geodesy

`src/geo/` — `constants.ts` (WGS84 a, f, e²), `angles.ts` (wrapping, bearing
differences), `distance.ts` (haversine + along/cross decomposition),
`enu.ts` (local tangent plane).

Geodetic ↔ ENU uses **Bowring's closed form** rather than an iterative
latitude solution: there is no convergence loop inside a 10 Hz budget, and the
closed form is accurate far beyond what a consumer receiver delivers. The
engine picks an `origin` at the first trusted fix and works in metres from
there for the rest of the session.

### 6.4 Filters

| File | What |
|---|---|
| `median.ts` | `Vec3MedianFilter(n)` — impulse rejection; 5 samples |
| `lowpass.ts` | `Vec3LowPassFilter(cutoffHz, rateHz)` — first-order, vibration |
| `stationarity.ts` | `StationarityDetector` — variance of specific-force magnitude and of gyro over a window, both must be low |

Median before low-pass, because a low-pass smears an impulse across the window
instead of removing it.

### 6.5 Attitude and alignment

**`attitude.ts` (339 lines) — the single most important fix in the project.**

The yaw rate the engine integrates is the component of the gyro vector about
the **measured vertical**:

```
ω_yaw = -(ω · up̂)
```

not `gz`. Device Z is the phone's own axis and only coincides with the vertical
if the phone is lying flat. The estimator maintains `up̂` with a complementary
filter: gyro for the short term, accelerometer as a slow anchor, **gated** so
that a motorway on-ramp's sustained longitudinal acceleration cannot drag the
vertical along with it.

**`autoAlign.ts` (561 lines) — Phase 12.** Pitch and roll come free from
gravity. The missing degree of freedom is *which way in the horizontal plane
the bonnet points*, and gravity cannot tell you, because every yaw about the
vertical looks identical at rest.

While driving in a straight line all acceleration is longitudinal, so the
horizontal samples form a **cigar whose long axis is the forward axis**. PCA
finds it in closed form from a 2×2 covariance. PCA returns a *line*, so the
sign is resolved against the derivative of speed — while speeding up,
acceleration points forward. Without that, one hard brake outvotes ten gentle
accelerations and the answer is 180° out, driving the estimate down the road in
reverse.

The mount is watched continuously: sustained gravity-direction change discards
the alignment, shows `REALIGNING` and halves the confidence bar.

Two bugs the alignment harness caught:
1. **`forwardAccelDc` was tracked in the vehicle frame.** It is a 40 s mean
   subtracted as a tilt estimate, so when the alignment settled mid-drive the
   mean described the *old* rotation. With a 30° mount and a 4°-accurate
   alignment that scored **17.3 % — worse than not aligning at all (12.6 %)**.
   Re-seeding was worse still (56 %). Fixed by tracking it in the plane frame.
2. **Quality blended toward each window's own quality**, so a motorway cruise
   pulled confidence *down* in an alignment six windows had agreed on.

**`altimeter.ts` — barometric altitude, relative only.** A phone barometer
cannot measure altitude: weather moves sea-level pressure by hundreds of metres
of apparent height. It is excellent at *change*, which is what a flyover, a
multi-storey ramp and a tunnel entrance actually are.

**`simpleAlignment.ts`** (115) is the Phase-4 manual predecessor — press a
button, drive straight. Nothing in the app ever called it, which is why every
drive before Phase 12 ran on "the mount is at zero degrees". **`gravity.ts`**
(30) isolates the gravity vector.

### 6.6 Dead reckoning

`deadreckoning/DeadReckoningEngine.ts`, 506 lines.

**Velocity is carried as a 2-D ENU vector, not a scalar speed.** With a scalar,
motion can only ever be along the heading — NHC would be satisfied by
construction and switching it off in the ablation would change nothing. The
vector is what makes the constraint measurable.

Per step:

```
v_enu  ← v_enu + a_enu · dt            (a_enu from attitude-rotated, filtered accel)
heading ← heading + ω_yaw · dt          (ω_yaw about measured vertical, bias-corrected)
p_enu  ← p_enu + v_enu · dt
```

Speed priority, highest first:

1. **GNSS Doppler**, held for the receiver's cadence
2. **Step model** (`motion/steps.ts` + `StrideModel`) when the context is
   pedestrian — every second of good GNSS re-measures the stride length free
3. **ML model** (Model 1) when `useMlSpeed` and the predictor is ready and the
   context is vehicular
4. **Decayed integration** — see the coasting decay in §6.9

### 6.7 The state machine

`state/NavigationStateMachine.ts`, 370 lines. Six modes:

```
                   2 good fixes
   INITIALIZING ─────────────────► GNSS ◄─────────────┐
        │                          │  ▲               │ 2 good fixes
        │                          │  │ 2 good fixes  │
        │            accuracy > 25 m│  │               │
        │            or < 4 sats    ▼  │           RECOVERING
        │                     GNSS_DEGRADED             ▲
        │                          │                    │ 2 good fixes
        │              2 s degraded │                    │
        │                          ▼                    │
        └───── error ───►  DEAD_RECKONING ───────────────┘
                                   │
                                 ERROR
```

`DEFAULT_STATE_MACHINE_CONFIG`:

| Field | Default | Why |
|---|---|---|
| `fixesToInitialise` | 2 | on an 11 s-cadence handset, three fixes means ACQUIRING for over half a minute after launch — which looks broken |
| `goodAccuracyM` | 20 | |
| `degradedAccuracyM` | 25 | |
| `minSatellites` | 4 | |
| `noFixTimeoutMs` | 1500 | the fixed fallback, used when `adaptiveTimeout` is off |
| `fixesToRecoverFromDegraded` | 2 | |
| `degradedToDrMs` | 2000 | |
| `fixesToStartRecovery` | 2 | |
| `adaptiveTimeout` | true | |
| `noFixIntervalFactor` | 2.5 | multiple of the observed median fix interval |
| `maxAdaptiveTimeoutMs` | 20 000 | a real tunnel must still be detected |
| `warmupTimeoutMs` | 6000 | before the cadence has been observed |

**Hysteresis is the point.** Every transition needs several consecutive
confirmations or a sustained condition — never a single sample. Without that a
fix hovering near the accuracy threshold makes the badge flip several times a
second: the maths can be perfect and the demo still reads as broken.

**The adaptive timeout is the fix for "it says DEAD RECKONING while GPS is on".**
The Capacitor/WebView geolocation bridge delivered **0.05–0.20 Hz** on real
hardware. A 1.5 s timeout assumes a 1 Hz receiver and told a 0.2 Hz handset it
had lost GNSS after every fix.

**`state/events.ts`** — a 20-type event taxonomy, each documented with why it
must never be silent: `GNSS_FIX`, `GNSS_LOST`, `MODE_CHANGE`, `ZUPT_TRIGGER`,
`ZARU_TRIGGER`, `NHC_APPLIED`, `DRIFT_MEASURED`, `RECOVERY_COMPLETE`,
`POSITION_RESET`, `ROAD_MATCH`, `TURN`, `GNSS_ANOMALY`, `ML_ERROR`,
`ML_SUPPRESSED`, `MOTION_CONTEXT`, `ESKF_RESET`, `ALIGNMENT`, `MOTION_STATE`,
`RELOCALISED`, `VEHICLE_TYPE`, `WARNING`.

**`state/SessionStats.ts`** (181) — session totals for the stats tab.

### 6.8 Recovery blending

`fusion/RecoveryBlender.ts`, 225 lines.

GNSS returning must not teleport the marker. The blender bounds the **rate**
(60 m/s peak), **not the duration** — a 600 m correction spread over a fixed
2 s moves the marker at 300 m/s, which is a teleport with better manners.

Past **400 m** it resets outright and *says so* in the event log, because a
fake smooth correction over an error that large is worse than an explicit jump.

Three rules the implementation learned:
- The blender works in **unsnapped space**, or snapping and blending fight.
- The recovery target must move at **full rate** while blending, or the marker
  chases a stale point.
- The **ellipse shrinks with the slew, not after it**, so the displayed
  uncertainty matches the displayed position at every frame.

### 6.9 The constraints

#### NHC — `constraints/nhc.ts` (101 lines)

A vehicle cannot slide sideways and cannot fly, so in the body frame lateral
and vertical velocity are zero. Any lateral velocity the integration produced
is error by construction — delete it.

```
forward = (sin h, cos h)          right = (cos h, −sin h)      [ENU, compass bearing]
v_f = v·forward       v_l = v·right
v'  = v_f·forward + (1−strength)·v_l·right
```

`strength = 0.95`, **deliberately not 1.0**. Real vehicles do slip — tyre slip
angle, crabbing in a crosswind, a skid — and a constraint asserted with absolute
certainty makes the estimator over-confident, so it stops believing genuine
evidence that contradicts it later. `lateralMismatchTolerance = 2.0 m/s²`:
above that, the *alignment* is suspect rather than the vehicle sliding.

**This is the single largest win in the ablation: 57.5 % → 33.5 %.**

#### ZUPT — `constraints/zupt.ts` (151 lines)

When the vehicle is stationary its velocity is exactly zero. Not "small" —
zero, known with certainty, for free. Every red light resets the error budget,
which is why ZUPT is worth more in city driving than any amount of filter
tuning.

`sampleCount 50` (1 s at 50 Hz), `alpha 0.1` EMA, `maxBiasMps2 0.5`.

Standing still also yields the accelerometer bias for free: the only specific
force on a stationary phone is gravity, so whatever is left after removing it
is bias.

**The bug this fixed:** `propagate()` fell back to `speed = speed + accel·dt`
whenever GNSS was absent. With accel near zero that expression holds the last
speed *forever*. In the field test the app sat at a confident 25.8 km/h for
**197 seconds** while the phone stood still, inventing 4 km of travel.
`applyZeroVelocity()` existed the whole time and nothing ever called it.

#### ZARU — `constraints/zaru.ts` (126 lines)

A standing vehicle is not turning, so everything the gyroscope reports is bias.
A red light is a free, perfectly-labelled calibration sample.

`sampleCount 50`, `alpha 0.1`, `maxBiasRadPerSec 0.05` — anything past that is
real motion the stationarity detector misclassified, and learning it as bias
would corrupt every future heading.

A typical phone gyro's 0.01 rad/s bias is 0.57 °/s, which sounds harmless until
you integrate it: **113° of heading error over a 197 s outage**. Heading error
is what turns a 20 m problem into a 200 m one, because the position error it
creates grows with *distance travelled*, not with sensor noise.

#### Speed clamp — `constraints/speedclamp.ts` (80 lines)

```
maxSpeedMps          40      (144 km/h)
roadSpeedTolerance   1.3     applied to a matched road's maxspeed tag
defaultRoadSpeedMps  22.2    (80 km/h) when the road has no tag
integrationTrustMs   45 000  how long unaided integration stays trustworthy
decayTimeConstantMs  60 000  exponential decay afterwards
```

The road-tag ceiling is the cheap half. **The decay is the important half.** A
stationary phone reads roughly zero acceleration — and so does a car cruising at
a constant 50 km/h. The two are genuinely indistinguishable to an
accelerometer; that is a real limitation of inertial navigation, not something
clever code wishes away. Holding the last speed forever resolves the ambiguity
in the worst possible direction.

#### Road snapping — `constraints/roadsnap.ts` (364 lines)

Cross-track only, with a *bounded* along-track correction.

| Field | Default | Meaning |
|---|---|---|
| `searchRadiusM` | 50 | ordinary candidate search |
| `wideSearchRadiusM` | 250 | used when the ordinary one finds nothing |
| `headingWeightM` | 30 | cost in metres of a fully-opposed heading, scaled by mismatch/180 |
| `continuityBonusM` | 20 | bonus for staying on the way matched last sample |
| `minSnapStrength` | 0.1 | |
| `maxSnapStrength` | 0.7 | never 1 — a hard snap is a teleport wearing a hat |
| `crossTrackCapM` | 5 | cross-track uncertainty cap once a match is held |
| `deadReckoningStrength` | 1 | full strength when it matters most |
| `strengthRampMs` | 1000 | |
| `maxSnapRateMps` | 60 | |
| `maxAlongCorrectionM` | 25 | |
| `speedLimitTrustDistanceM` | 20 | |
| `speedLimitTrustHeadingDeg` | 45 | |

**Why the wide radius exists.** With one fixed radius, snapping stops the moment
it is needed most: dead reckoning drifts past 50 m from any road, the match
returns null, snapping silently disengages, and the marker wanders open ground
— which was exactly the field report, *"it goes off the road, into the plots"*.
Measured: **27 % of dead-reckoning samples were drawn more than 10 m from any
road**, worst 106 m. A vehicle 200 m from the nearest road is not off-road; it
is a bad estimate of a vehicle that is on one.

**Why `headingWeightM` is read as 30 m and not `mismatch × 30`.** Taken
literally in degrees, a 90° mismatch would cost 2700 — swamping distance
entirely and reducing the score to "whichever road points the right way,
however far".

#### Forward bias — `constraints/forwardBias.ts` (186 lines) — **ships off**

Learns forward-acceleration bias from GNSS Doppler while it is available. It
was worth 194 m → 37 m when it was the only thing removing the acceleration
runaway. Now that the high-pass does that job continuously, the ablation says
high-pass alone **12.7 %**, high-pass + forward bias **19.1 %** — half again
worse, because a bias learned from an 11 s position-differenced speed is noisy
and *fixed*, while the high-pass tracks whatever the error actually is now.

Kept, off, and reported.

### 6.10 The Error-State Kalman Filter

`eskf/`, Phase 11. Four files: `ErrorStateKalmanFilter.ts` (545),
`matrix.ts` (213), `quaternion.ts` (131), `noise.ts` (122).

**15 states**, Solà's formulation, with the **local** angular-error convention
used consistently throughout:

```
δx = [ δp(3)  δv(3)  δθ(3)  δb_a(3)  δb_g(3) ]
```

The nominal state — position, velocity, quaternion attitude, biases — is
integrated **exactly** and never linearised. What the filter estimates is the
*error*, which stays within centimetres and milliradians of zero.

**Seven measurement updates**, applied cheapest-and-most-certain first:

| Update | Sigma | Note |
|---|---|---|
| ZUPT (velocity = 0) | `zuptSigmaMps` 0.02 | a stopped vehicle is genuinely stopped |
| ZARU (angular rate = 0) | `zaruSigmaRadPerSec` 0.002 | this is what makes gyro bias observable |
| NHC (lateral velocity = 0) | `nhcSigmaMps` 0.15 | small but **never zero** |
| GNSS position | from the fix's reported accuracy | |
| GNSS velocity | Doppler | |
| Road cross-track | `roadCrossTrackSigmaM` 1.75 | half a lane — the uncertainty in "on this road" is which lane |
| Barometric altitude change | `baroSigmaM` 1.5 | relative only |

plus a forward-speed pseudo-measurement.

Numerics: **Joseph-form covariance update**, exact symmetrisation, and a reset
Jacobian after each error injection. `matrix.ts` is dense linear algebra with
**zero dependencies** — about 150 lines — including a Gauss-Jordan inverse that
**throws** rather than returning `Infinity` into a Kalman gain.

Initial 1-sigma seeding of `P`: position 5 m, velocity 1 m/s, attitude 0.1 rad,
accel bias 0.3 m/s², gyro bias 0.02 rad/s.

**The noise model is the filter.** `noise.ts` carries three IMU grades:

| Grade | accel noise density | gyro noise density | accel bias RW | gyro bias RW |
|---|---|---|---|---|
| `PHONE_MEMS` | 0.08 | 0.008 | 0.004 | 4e-5 |
| `TACTICAL` | 0.005 | 2e-4 | 1e-4 | 1e-6 |
| `FOG` | 5e-4 | 5e-6 | 1e-5 | 2e-8 |

`PHONE_MEMS` is measured from the handsets this runs on, not from a datasheet —
a phone accelerometer's bias moves with temperature and with how the case is
squeezed, and its published noise density flatters it badly.

**The result: 10.1 % mean vs the hand-built chain's 9.2 %, but p90 19.4 % vs
22.6 %.** Worse in the middle of the distribution, better at the end of it.
Ships off; **both halves are asserted in tests** so neither can be quietly
dropped.

**Two bugs found by measuring, not reading:**

1. **84.6 % drift** — ZARU was fed the raw *device-frame* gyro while prediction
   used the vehicle-frame rate. A measurement in the wrong frame: unobservable
   bias states absorbed the difference, attitude tumbled at 0.25 rad/s, and
   every returning fix was then gated as an outlier *forever*.
2. **The lateral channel.** Feeding measured lateral acceleration put 8 m/s²
   into the body-y bias. Feeding zero was worse: with no lateral acceleration
   the velocity vector cannot turn, and NHC reads the accumulating lateral
   velocity as *yaw error* — 26° lost in five seconds. The answer is the
   centripetal term `v × ω`, which agrees with NHC by construction.

**Why ESKF and not the UKF the PS suggests.** The non-linearity lives entirely
in the nominal state, which is integrated exactly. A UKF would spend 31 sigma-
point propagations per step correcting a linearisation error that is not there.

### 6.11 Map matching

#### `RoadIndex.ts` (251 lines)

A 100 m uniform grid. **Segments are stamped into every cell they cross** — a
1 km road would otherwise be invisible from its own middle, because only its
endpoints would land in cells. Also provides `positionAt(way, arcLength)` by
binary search over the way's cumulative lengths, which is what the particle
filter needs 500 times per step.

#### `RoadTopology.ts` (300 lines) — Phase 14

Connectivity recovered **exactly** rather than by tolerance. Overpass returns
geometry from shared OSM nodes, so two ways meeting at a junction carry the
*identical* coordinate. Hashing coordinates to a **centimetre grid** finds every
junction with no tolerance to tune — and, critically, **without welding a
flyover to the road beneath it**, which any distance-based join would do on
every overpass in the country.

Routing is a **bounded Dijkstra** with a cache, because the HMM asks for route
distance between candidate pairs on every observation.

#### `hmm.ts` (440 lines) — Newson-Krumm

```
emission(z, c)      = N(perpendicular distance from z to candidate c ; σ)
transition(c_i,c_j) = exp( −| routeDistance(c_i,c_j) − ‖z_i − z_j‖ | / β )
```

Viterbi over a sliding window. The transition term **is** the quantity greedy
matching cannot express: *close but unreachable*. A service road 20 m away, the
opposite carriageway and the road under a flyover are all 20 m away and all
require driving to the next junction and back.

`DEFAULT_HMM_CONFIG`:

| Field | Default | Why |
|---|---|---|
| `minSigmaM` | 4.07 | Newson-Krumm's fitted GPS sigma; here it is only the **floor**, since the engine supplies per-observation uncertainty |
| `betaM` | 30 | usual choice for dense sampling |
| `maxCandidates` | 6 | |
| `searchRadiusM` | 60 | |
| `windowSize` | 30 | observations kept in the Viterbi window |
| `minTravelM` | 10 | **the fix for "it is not an HMM"** |
| `headingPenalty` | 4 | |
| `layerSeparationM` | 4 | flyover vs road beneath |

**Why `minTravelM` exists.** At 50 Hz consecutive positions are 3 cm apart, the
route between any two nearby candidates is also ~3 cm, and the transition term
is *uniform* — every transition equally plausible, the model degenerating into
per-position nearest-road with extra steps. Measured: fed every sample it scored
**9.9 %** against the greedy matcher's 9.2 %. It was not reasoning about
sequences at all.

**The second integration bug:** a held match must hold the **road**, not the
**point**. Returning the previous match verbatim returns a position 10 m
*behind* the vehicle, and the snap then pulls the marker backwards
(9.9 % → 16.0 %).

**Measured overall: 10.5 % vs 9.2 %, and the parameter sweep is flat**
(10.4–11.2 % across 3/5/10/20/40 m). That flatness is itself the finding: a knob
controlling the model's entire source of advantage that changes nothing says
these routes contain no geometry its transition term can discriminate. Ships
off; the capability is demonstrated by tests that build a parallel service road,
a divided carriageway and a flyover.

#### `turnDetector.ts` (269 lines)

Classifies *completed* turns from the same corrected yaw rate the estimate
integrates — so a turn on the HUD and a turn in the estimator are the same
event, not two opinions. Produces `lastTurn` with a pre-formatted label
(`"RIGHT 87°"`) and feeds the turn relocaliser.

### 6.12 The particle filter and turn relocalisation

`particle/ParticleFilter.ts` (735) and `particle/TurnRelocaliser.ts` (306).
Phase 17 — **not in the problem statement, which is the point.**

Every other estimator here is unimodal. That is right while the answer has one
peak, and wrong five minutes into an outage: the vehicle went left or right
three minutes ago and the truth is **one of them**, not a covariance stretched
across both.

500 particles in typed arrays, each a complete hypothesis `(wayId, arcLength,
heading, speed)`. They branch randomly at junctions, weighted by road class and
turn sharpness; they are reweighted on heading agreement, speed-limit
plausibility, dead-reckoning agreement and GNSS when available; they are
**resampled stratified by hypothesis** so a 40 % branch keeps 40 % of the
particles. RNG is deterministic, so runs reproduce.

`DEFAULT_PARTICLE_CONFIG`:

| Field | Default |
|---|---|
| `count` | 500 |
| `speedNoiseMps` | 1.2 |
| `headingNoiseRad` | 0.05 |
| `resampleThreshold` | 0.5 (ESS fraction) |
| `headingWeight` | 2.5 |
| `speedWeight` | 0.6 |
| `gnssWeight` | 0.08 |
| `deadReckoningWeight` | 1.4 |
| `seedRadiusM` | 40 |
| `unimodalThreshold` | 0.7 |

**Resampling is conditional, not per-step.** Resampling discards diversity, so
doing it unconditionally destroys exactly the multi-hypothesis behaviour the
filter exists for: the two branches of a junction have similar weights for a
long time.

**Turn relocalisation** searches the graph for the sequence of turns just
driven. A unique match collapses the cloud onto it — *recognition*, not
smoothing, which is why a long outage can end **more** accurate than it began.
It declines far more often than it answers: it needs three turns, a unique
match, and distances that agree. It is the only mechanism in the engine that
can move the marker somewhere it has no continuous path to, which is why it is
a separate flag from `particleFilter`.

Two conditions gate the cloud moving the marker at all, and the correction
itself is a **rate-limited vector, not a switch**.

**Measured:**

| | shipped chain | + particle filter |
|---|---|---|
| **City** (junctions everywhere) | 15.1 % | **13.3 %** |
| **Highway** (few, grade-separated) | **3.2 %** | 12.8 % |
| Overall | **9.2 %** | 13.0 % |

Exactly what the mechanism predicts. Ships off; **the split is the finding**,
and the average of the two is the least informative number available.

**Three bugs, each of which made it not a particle filter:**

1. **Snapping each particle's heading to its new road at a junction.** Looks
   right, destroys everything — the heading is the *gyro's*, and it is the only
   evidence that can punish a wrong branch. A vehicle turning right through a
   fork ended up on the **left** one.
2. **Plain resampling ate a hypothesis by luck.** 50/50 drifted to 75/25 then to
   one mode, having learned nothing. Now stratified by hypothesis.
3. **No position evidence at all.** A cloud that collectively took a wrong turn
   agrees with *itself* perfectly: it reported UNIMODAL with a 2 m spread,
   **1 km from the vehicle, 134 % drift**. Self-consistency is not evidence —
   hence `deadReckoningWeight`.

### 6.13 On-device ML inference

`ml/cnn.ts` (425) is the pure-TypeScript network runner. **One implementation,
four models.**

**Why not ONNX Runtime.** 14 MB of WebAssembly to evaluate 26,081 parameters
takes the APK from 5.4 MB to roughly 20 MB — for weights that are 104 KB — and
`onnxruntime-web` additionally fails Next's Terser pass, so it does not even
build. Three convolutions and two dense layers do not need a general-purpose
graph runtime.

Evaluating it in `nav-core` also means the edge engine and the eval harness get
inference for free, and it is testable in Node against probe vectors captured
from PyTorch (`test/probes.json`, `test/cnn.test.ts`) — so the two
implementations cannot drift apart silently.

**BatchNorm does not appear** in the runner: `ml/export.py` folds it into the
preceding convolution's weights and bias. The whole affine part collapses,
exactly, removing a layer that is easy to get wrong at inference.

`runCnn()` returns the full output vector; `runSpeedCnn()` returns
`output[0]`. Weights arrive as base64 Float32 blocks in JSON and the loader
**validates everything and refuses rather than copes** — every check exists
because the failure it prevents is silent (a weight block one element short
still decodes, and the convolution then reads past its own kernel).

| Model | File | Params | Size | Inputs → outputs |
|---|---|---|---|---|
| **1 · Speed** | `speedModel.ts` (238) | 26,081 | 104 KB | 20×6 IMU window (2 s @ 10 Hz) → speed m/s |
| **2 · Motion state** | `motionModel.ts` (355) | 9,736 | 50.7 KB | 10×6 window (1 s) → 8-class softmax |
| **3 · Drift residual** | `residualModel.ts` (238) | 1,506 | — | 11 engine features → along/cross correction |
| **4 · GNSS quality** | `gnssQualityModel.ts` (294) | 988 | 6.1 KB | 11 fix features → 4-class softmax |

Plumbing details that matter:

- `SpeedWindowBuffer` is a ring buffer; `SpeedSmoother(5)` damps the output;
  inference runs every `mlInferenceIntervalMs` (500 ms), because windows only
  advance by one half-window (1 s) and inferring per sample would spend ten
  times the energy recomputing a nearly identical input.
- `MotionGate` holds a prediction to a **confidence floor *and* consecutive
  agreement** before the engine may act on it.
- `clampResidual` bounds every Model 3 correction to the estimator's own
  covariance. Re-measured through it, the same broken model scores **−28 % and
  −49 % instead of −195 % and −837 %**.
- `GnssQualityTracker` computes the baselines **identically in training and
  inference** — the class of skew that a unit test caught (see §12).

**Contract tests load the actual exported weights** and assert the class list
and feature order match the engine. A reordered class list does not throw: the
model stays 90 % accurate and every answer is wrong.

### 6.14 Two-wheeler support

`twowheeler/lean.ts` (115) and `twowheeler/VehicleTypeDetector.ts` (154).
Phase 18B. The problem statement names two-wheelers explicitly.

**The thing that breaks on a motorcycle is not NHC — it is the attitude
reference.** In a steady turn a bike leans until the resultant of gravity and
centripetal acceleration runs straight down its *own* axis. That is what leaning
*is*, and it is why a rider feels pressed into the seat rather than sideways.

So a phone on a leaning bike reads a specific force that **never moves in its
own frame**. The engine takes the leaned axis for "down", and the yaw rate it
recovers is `ω_true · cos(lean)`. **The bike turns more than the engine
believes** — a 25° lean loses 8° on a 90° corner, and 8° over a kilometre of
tunnel is **140 m of cross-track error from one roundabout**.

The fix needs no extra sensor:

```
tan(lean) = v·ω_true / g          ω_measured = ω_true·cos(lean)
  ⟹  sin(lean) = v·ω_measured / g          ω_true = ω_measured / cos(lean)
```

Closed form, from quantities the engine already has.

**Telling a bike from a car — the obvious method fails.** The specific force
tilts by the *same* angle in both: a car cornering at 4.5 m/s² has a resultant
25° off vertical, exactly as a bike leaning 25° does. Same trajectory, same
forces. What differs is whether the **sensor follows it**: a car stays level so
the force swings sideways in the phone's frame; a bike rolls until the force
runs down its own axis, so it does not move at all — only gets heavier.

That ratio is the detector. `followRatio ≈ 1` is a car, `≈ 0` is a bike.

| Field | Default | Why |
|---|---|---|
| `minYawRateRadPerSec` | 0.12 | below this a sample carries no information |
| `minSpeedMps` | 5 | the lean physics does not apply below it |
| `minExpectedTiltDeg` | 6 | too small to measure against |
| `minSamples` | 60 | evidence before a verdict is offered |
| `bikeThreshold` | 0.35 | |
| `carThreshold` | 0.65 | deliberately far apart, wide "not sure" band |

Defaults to `CAR` and needs real cornering evidence to leave it.

**A claim my own test disproved.** The comment in `lean.ts` said the
compensation was safe to leave on for a car — with no lean, `cos 0 = 1`. Wrong:
the function cannot *tell* whether the vehicle leaned, it *infers* it, and a car
cornering briskly presents identical inputs. At 15 m/s and 0.35 rad/s it invents
a 32° lean and inflates the turn by **18 %**. Hence the gate, and hence the
detector's default.

### 6.15 Detection, GNSS, confidence, trail, trip export

#### `detect/spoofing.ts` (331 lines)

Three readable rules, all **advisory**:

1. **Static disagreement** — the receiver claims ≤ 0.5 m/s while dead reckoning
   says ≥ 4 m/s, sustained for 6 s.
2. **Impossible jump** — implied speed between consecutive fixes > 55 m/s
   (~200 km/h), with a minimum gap of 500 ms (below which the arithmetic
   measures noise) and a margin of 3× the two fixes' combined reported accuracy
   (so two 50 m fixes cannot trip it by disagreeing by 50 m).
3. **Satellites vanish while C/N0 stays healthy** — count drops to ≤ 0.5 of its
   recent level while C/N0 ≥ 35 dB-Hz. Losing signal genuinely takes C/N0 down
   with it; a spoofer's does not.

Anomalies are held for 8 s after their last trigger so the UI does not flicker.

**A detector must never gate the fix it is suspicious of.** A false positive
would turn a suspicion into a navigation failure. This rule applies with more
force, not less, to Model 4.

#### `gnss/constellations.ts` (213 lines)

Per-constellation tracked-satellite breakdown — GPS, GLONASS, Galileo, BeiDou,
**NavIC/IRNSS**, QZSS — always carrying `constellationsSimulated`. Only the
Phase 15 native source can set it to `false`, because only `GnssStatus` reports
the constellation of each tracked satellite.

#### `confidence/ellipse.ts`

Turns `covariance.alongM` / `crossM` / `headingDeg` into an ellipse the map can
draw, rotated to the direction of travel.

#### `trail/`

Accumulates the drawn path with mode colouring (green GNSS, orange dead
reckoning, blue recovering) and a distance floor so a parked vehicle does not
scribble.

#### `trip/export.ts` (289 lines)

GPX (with real `<time>` from the session's wall-clock epoch) and GeoJSON, plus
`tripFileName()`. Hostile-input tests cover it.

#### `motion/`

`context.ts` (283) classifies pedestrian vs vehicular motion — which gates the
vehicle-trained speed model and switches heading to GNSS on foot.
`steps.ts` (231) is a step detector plus `StrideModel`, re-measured free from
every second of good GNSS.

---

## 7 · `packages/sensor-sources` — where samples come from

One interface, six implementations. Swapping the source never touches
`nav-core`. **This package may use browser APIs; nav-core may not.**

```ts
interface SensorSource {
  start(): Promise<void>;
  stop(): void;
  onSample(cb: (s: SensorSample) => void): void;
  readonly capabilities: SensorSourceCapabilities;
}

interface SensorSourceCapabilities {
  hasGnss: boolean;
  hasImu: boolean;
  hasGyro?: boolean;   // undefined = NOT MEASURED YET, never "no gyroscope"
  hasBaro: boolean;
  imuRateHz: number;
  gnssRateHz: number;
  name: string;
}
```

**Why `hasGyro` is tri-state.** `DeviceMotionEvent.rotationRate` is `null` on a
WebView with no gyroscope, and both live sources read it as `rot?.alpha ?? 0`.
Zero is a perfectly valid yaw rate, so the engine integrated "not turning" for
the whole outage and dead reckoning drew a dead straight line however hard the
vehicle cornered — with nothing on screen saying why.

| File | Lines | Purpose |
|---|---|---|
| `simulation/SimulationSource.ts` | 289 | A virtual vehicle — pure physics, usable in nav-core tests |
| `simulation/vehicle.ts` | 170 | Kinematics |
| `simulation/imu.ts` | 106 | Synthetic IMU — **and the reason the ML models don't transfer** |
| `simulation/route.ts` | 120 | Route following |
| `simulation/rng.ts` | 43 | Seeded, so every run reproduces |
| `web/WebSource.ts` | 152 | `DeviceMotion` + `navigator.geolocation` |
| `native/NativeSource.ts` | 173 | Capacitor Motion/Geolocation plugins — **throttled with the screen off** |
| `native/ForegroundSource.ts` | 259 | **Phase 15.** Batches from the native service. The only source that can honestly set `constellationsSimulated: false` |
| `replay/ReplaySource.ts` | 113 | A recorded JSONL log, replayed with original timing |
| `recording/RecordingWrapper.ts` | 78 | Wraps any source and writes JSONL |

The simulator is a full vehicle model — route following, speed profile,
cornering, stops — feeding a synthetic IMU with configurable noise and bias.
Being seeded and deterministic is what makes `data/replay/sim_*.jsonl`
committable and `docs/benchmarks.md` reproducible from this repository alone.

---

## 8 · `packages/eval` — where every number comes from

**Nothing in this project claims a number it cannot reproduce.**

| File | Lines | Produces |
|---|---|---|
| `harness.ts` | 187 | Replays a log, punches an artificial GNSS outage, scores it |
| `metrics.ts` | 267 | Drift %, along/cross decomposition, CEP95, recovery time |
| `ablation.ts` | 111 | `pnpm ablation` → the headline table |
| `report.ts` | 268 | Markdown, CSV, JSON and the SVG chart |
| `offroad.ts` | 174 | `pnpm eval:offroad` — **the metric drift cannot see** |
| `alignment.ts` | 223 | `pnpm eval:alignment` — rotates the IMU by a known angle |
| `drift-dataset.ts` | 95 | Training rows for Model 3, via `engine.driftFeatures` |
| `gnss-quality-dataset.ts` | 258 | Training rows for Model 4 — modelled corruptions of real fixes |
| `paths.ts` · `cli.ts` · `record.ts` | 308 | Config loading, single-run CLI, recording |

### 8.1 The harness

```ts
runEval(samples, { outageStartMs, outageDurationMs, engineConfig, roadGraph })
```

**The outage removes the `gnss` field entirely** rather than zeroing or faking
it. That is the shape a real outage has, and it is what the state machine
actually reacts to.

**The withheld GNSS is the ground truth**, so it cannot have been fitted to.
Covariance, bias estimates and outage counters are all tracked sample by sample;
recovery time is measured from the outage end to the first sample back in
`GNSS` mode.

### 8.2 The metrics

- **Drift %** = final error ÷ distance *actually travelled*, taken from ground
  truth rather than from the estimate's own idea of how far it went — otherwise
  a configuration that under-estimates its speed flatters itself twice.
- **Along / cross decomposition** relative to the truth's direction of travel.
  Cross-track error is what puts the marker inside a building; along-track error
  leaves it on the right road at the wrong point, comes from speed error, and
  road snapping deliberately does nothing about it.
- **CEP95**, **RMSE**, **max**, **p90** — *the p90 and max columns matter more
  than the mean*, because a good mean hiding a bad tail is exactly what someone
  finds by picking the one drive that went wrong.
- **Recovery seconds**, **update Hz**, **ZUPT count**, **road-snap %**,
  **resets**.

### 8.3 Off-road — the metric drift cannot see

Drift measures distance *to* the truth. It is blind to which **side** of the
truth the error is on: 30 m along a road is invisible, 30 m across it is a
vehicle in somebody's field. Nothing measured that, so nothing caught it — and a
real field report said exactly that on a build measuring 10 % drift.

`offroad.ts` scores distance from the estimate to the **road network itself**,
counting only samples drawn while `DEAD_RECKONING`.

### 8.4 Alignment

Rotates the raw accelerometer and gyroscope about the device vertical by a known
angle before the engine sees them — which is exactly what propping a handset at
an angle in a holder does. Ground truth is untouched: the vehicle drove where it
drove.

**Why this is not a row in the ablation table.** Every recorded log was made with
the phone square to the vehicle, so on those logs the true mount offset is zero,
an alignment engine has nothing to find, and every degree it estimates is pure
error. The ablation would show a cost and no benefit and invite the wrong
conclusion.

---

## 9 · `packages/edge-engine` — the 200 Hz deliverable

Contains **no navigation mathematics of its own.** Adapters, a driven loop and a
report; every line of estimation is byte-for-byte the code the handset runs.

| File | Lines | Purpose |
|---|---|---|
| `runner.ts` | 117 | The driven loop. The engine owns the clock, so replay runs as fast as the CPU allows |
| `cli.ts` | 193 | `pnpm edge` — grades, rates, inputs, outputs |
| `bench.ts` | 192 | The sustained-rate and latency benchmark |
| `grades.ts` | 110 | PHONE_MEMS / TACTICAL / FOG profiles |
| `output.ts` | 124 | File · stdout · UDP broadcast · fan-out, streamed |
| `sources/UdpImuSource.ts` | 129 | JSON datagrams |
| `sources/SerialImuSource.ts` | 164 | UART, JSON or bare `t,ax,ay,az,gx,gy,gz` |
| `sources/FogSimulatorSource.ts` | 164 | Datasheet-grade synthetic IMU |
| `sources/ReplayFileSource.ts` | 137 | Recorded logs |
| `Dockerfile` | — | Builds from the repo root, because `nav-core` is a workspace sibling |

### 9.1 CLI

```
pnpm edge --grade FOG --rate 200 --seconds 60
pnpm edge --replay ../../data/replay/sim_city_4242.jsonl --rate 200
pnpm edge --grade TACTICAL --rate 100 --seconds 30 --json out.jsonl
pnpm edge --udp-in 5555 --rate 200 --udp-out 5556
pnpm edge --serial /dev/ttyUSB0 --baud 921600 --rate 200 --stdout | jq .

INPUT     --grade <PHONE_MEMS|TACTICAL|FOG>   default FOG
          --replay <file>       .jsonl or .csv
          --udp-in <port>       JSON IMU datagrams
          --serial <path>       needs the optional serialport package
          --baud <rate>         default 921600
OUTPUT    --json <file>         NavigationState as JSON lines
          --stdout              same, on stdout, for piping
          --udp-out <port>      broadcast each state as a JSON datagram
          --udp-host <host>     default 127.0.0.1
RUN       --rate <hz>           default: the grade's nominal rate
          --seconds <s>         default 60
          --gnss <ms>           emit a simulated fix this often; 0 = pure INS
          --quiet · --list-grades · --help
```

### 9.2 Design decisions

- **UDP, not TCP.** A retransmitted IMU sample arrives *late*; the engine treats
  an out-of-order timestamp as a clock jump and discards it. Retransmission
  costs latency and buys nothing.
- **`serialport` is optional**, because it compiles a native addon — and running
  arbitrary install scripts inside an image that will sit on a vehicle is not a
  thing to do by default.
- **Output is streamed as it goes.** An interrupted run used to write nothing.
- **The Docker `ENTRYPOINT` names the program** (`tini -- pnpm exec tsx
  src/cli.ts`), so `docker run pathpulse-edge --grade FOG` forwards arguments
  instead of asking tini to execute a file called `--grade`.
- **`tini` as PID 1**, because Node does not forward `SIGTERM` to children or
  reap zombies — on a vehicle that is the difference between a clean shutdown
  and a corrupt output file.
- The image installs with `--ignore-scripts` and only the three packages the
  engine imports; `apps/web` is a Next.js app with hundreds of megabytes of
  dependencies and nothing the engine uses.

### 9.3 Grade profiles

| Grade | Nominal rate | Gyro noise | Gyro bias | Accel noise | Accel bias |
|---|---|---|---|---|---|
| PHONE_MEMS | 50 Hz | 0.002 rad/s | 0.001 rad/s ≈ **206.265 °/hr** | 0.05 m/s² | 0.02 m/s² |
| TACTICAL | 100 Hz | 2e-4 | 1e-5 ≈ **2.063 °/hr** | 5e-3 | 1e-3 |
| FOG | 200 Hz | 1e-5 | **0.001 °/hr** | 1e-4 | 1e-5 |

`RAD_S_PER_DEG_HR = π/180/3600 = 4.848e-6`, kept in the file so the two units
can be checked against each other.

**We do not own a FOG IMU and say so.** Those rows are published datasheet
ranges driving `FogSimulatorSource`, and every figure from them is reported as
a simulation result.

---

## 10 · `apps/web` — the application

Next.js 14 with `output: 'export'`, React 18, Tailwind, MapLibre GL, three.js
for the landing hero. Static export was set on day one **deliberately**: it makes
any accidental server component or API route fail the web build now, not on demo
day when the APK is being assembled.

### 10.1 Build-time environment

`next.config.js` stamps the build into the bundle, because the APK bundles its
web assets and never auto-updates, so *"am I running the new build?"* is
otherwise unanswerable on a phone:

- `NEXT_PUBLIC_BUILD_ID` — `git rev-parse --short HEAD` plus `+dirty`
- `NEXT_PUBLIC_BUILD_TIME`
- `NEXT_PUBLIC_PHASE` — one place, because the Device screen read a hardcoded
  "phase 4" for fourteen phases

It also sets `transpilePackages` for the two workspace packages (which ship as
TypeScript source — no separate build step, no stale `dist/` to debug) and a
webpack `extensionAlias` mapping `.js` specifiers onto `.ts` sources, because
nav-core uses explicit `.js` specifiers as real ESM requires for the edge
engine's Node runtime.

### 10.2 Routes

- **`app/page.tsx` (687)** — the navigation screen.
- **`app/about/page.tsx` (561)** — the landing page.
- **`app/layout.tsx`**, **`app/globals.css`**.

`page.tsx` composition:

```
Home
├── Splash                 held until the map is ready, or 4 s — whichever first
├── Welcome                first run only
├── MapView (dynamic, ssr:false)
│   ├── TrailLayer         mode-coloured path
│   ├── MatchedRoadLayer   the road the matcher chose
│   ├── ConfidenceEllipse  along/cross, rotated to travel
│   └── VehicleMarker
├── Hud                    mode badge, speed, drift, distance, uncertainty, rates
├── DemoBar                the scripted outage
├── AppMenu (☰)
└── Sheet(panel)           exactly ONE of:
      menu · sources · debug(TrustPanel) · offline · benchmarks · pitch · device
```

**One panel at a time, by construction.** This was six independent booleans, so
panels could stack — and each had picked its own corner and z-index over ten
phases. A single `Panel` value cannot express "two things open", which is the
only reliable way to kill a bug whose every instance looks like a small
positioning mistake.

**`demoEpoch` is a counter, not a call.** `useSensorSource` rebuilds its source
inside an effect keyed on `[kind, routeKey]`, and effects run *after* the render
that changed them. Pressing Demo while Live was selected called `play()` on a
simulator that did not exist yet: the web source was started instead and the
fresh simulator arrived un-started — a demo banner counting down over a dead
map, the kind of failure you only find in front of a judge.

**The splash waits for something real but never for ever.** Without it the
splash rendered for a single frame, which reads as a glitch rather than as
loading. The 4 s cap is there because the map is presentation: if tiles never
arrive the engine still works, and the user must not be held at a loading screen
to find that out.

### 10.3 Hooks — where the app's state actually lives

| File | Lines | Purpose |
|---|---|---|
| `useNavigationEngine.ts` | 585 | Owns the engine, the controls, the diagnostics, the road graph |
| `useSensorSource.ts` | 492 | Source selection and lifecycle |
| `useGeolocation.ts` | 157 | Permission and fix plumbing |
| `useOfflineStatus.ts` | 100 | Radio state, worker state, cached tiles |
| `useDemoMode.ts` | 88 | The scripted outage |
| `useTour.ts` | 69 | The four-step guided tour |
| `useKeepAlive.ts` | 33 | Pings `/health.json` every 5 minutes while a tab is open |

**`useNavigationEngine` loads four models in four independent effects**, so one
broken network never disables the others. Each reports its outcome to the Trust
Panel either way — *"model not loaded"* on screen is worth more than a silent
fallback. `EngineControls extends ConstraintFlags`, so every toggle in the
Constraints tab is exactly an ablation row. It also owns `reloadRoadGraph()` and
exposes the loaded graph so the map can draw the matched road.

**`useSensorSource`** picks `ForegroundSource → NativeSource → WebSource`, each
**checked** rather than assumed, and supports `simulation | live | replay` with
routes `city | highway`. It surfaces the amber *"Location is off"* banner and a
**Try again** that genuinely rebuilds the source — before that, the source
decided GNSS was unavailable once and killing the app was the only way out.

### 10.4 Components

`TrustPanel.tsx` (970) is the anti-fake evidence panel, with four tabs:

| Tab | Shows |
|---|---|
| **sensors** | raw accel/gyro/baro, rates, `hasGyro`, GNSS fields, constellation breakdown **with provenance** |
| **constraints** | every `ConstraintFlags` toggle, live, plus all four models' load state and latency |
| **events** | the 20-type event log |
| **stats** | session totals, alignment state, ESKF/particle diagnostics |

Others: `Hud.tsx` (300), `MapView.tsx`, `MapContext.tsx`, `VehicleMarker.tsx`
(159), `MatchedRoadLayer.tsx`, `TrailLayer.tsx`, `ConfidenceEllipse.tsx`,
`OfflinePanel.tsx` (313 — downloads roads + tiles), `PitchScreen.tsx` (246 —
the in-app deck), `Benchmarks.tsx` (191), `SourcePicker.tsx`,
`PermissionGate.tsx` (always offers *"use the simulation instead"* rather than
being a dead end with only Retry), `TourOverlay.tsx`, `Splash.tsx`, `Sheet.tsx`,
`AppMenu.tsx`, `DemoBar.tsx`, `DeviceInfo.tsx`, `DownloadApk.tsx`,
`Welcome.tsx`, `ErrorBoundary.tsx`.

`components/landing/` (1,179 lines): `EngineScene.tsx` (512, three.js),
`LiveHero.tsx` (283 — the engine actually running on the landing page),
`RoadGraphMap.tsx` (187), `AblationTable.tsx` (generated from
`public/benchmarks/benchmarks.json`, so the site cannot quote a stale number),
`SiteNav.tsx`, `Reveal.tsx`, `DownloadCta.tsx`.

### 10.5 Lib

| File | Lines | Purpose |
|---|---|---|
| `roadGraph.ts` | 119 | Graph lookup — bundled **and** downloaded, indistinguishable at use |
| `roadGraphFetch.ts` | 210 | Overpass query at runtime, same road classes as the build script |
| `roadGraphStore.ts` | 119 | IndexedDB — a city graph is 1–3 MB, too big for `localStorage` |
| `tileCache.ts` | 187 | Slippy-map arithmetic: which tiles cover a box, and how many |
| `offline.ts` | 140 | Service-worker registration and pre-cache messaging |
| `ml/*.ts` | 268 | Four model loaders — fetch and parse only; the maths is in nav-core |
| `shownPosition.ts` | | Which position the map draws, and when the camera may jump |
| `demoScript.ts` · `pitch.ts` · `tour.ts` · `platform.ts` · `navMode.ts` · `keepAlive.ts` | | |

`config/map.ts` (`FOLLOW_ZOOM`, `resolveMapStyle`) and `config/modes.ts`.

### 10.6 `public/sw.js` — the tile worker

Cache-first for map tiles, because a tile is immutable for our purposes and the
**aeroplane-mode demo depends on it**: the navigation engine needs no network at
all, but a basemap that goes blank the moment the radios are off undercuts the
claim it is meant to prove.

- **An explicit host allowlist** (`tile.openstreetmap.org`, a/b/c subdomains,
  `api.maptiler.com`) — not a URL pattern, which would eventually catch
  something that is not a tile and serve it stale for ever.
- `MAX_TILES = 2000` (~40 MB), oldest-first eviction — an unbounded cache is a
  bug that shows up as a storage-full error weeks later on someone else's phone.
- `skipWaiting()` on install: a worker that waited for every tab to close would
  not be active during the demo it was installed for.
- Everything that is not a tile is left completely alone, so it can never serve
  a stale build.
- Cache-first also means the only reason a tile is missing offline is that it was
  never fetched — hence the explicit pre-cache in `lib/tileCache.ts` with bounded
  concurrency, rather than hoping the user panned over the right area.

### 10.7 Bundled public assets

`public/models/{speed,motion,gnss_quality}_model.json` + `scaler.json`,
`public/maps/` (city, highway, jabalpur + index),
`public/benchmarks/benchmarks.json`, `public/replay/demo.jsonl`,
`public/ml/{position_plot,training_curves}.png`,
`public/downloads/PathPulse.apk` + `apk.json`, `public/health.json`.

---

## 11 · `apps/web/android` — the native layer

Phase 15. Three Java files, 710 lines.

### 11.1 The problem

Android throttles a backgrounded WebView. With the screen off, `DeviceMotion`
falls from 10 Hz to roughly 1 Hz and eventually stops. That is not a degradation
the estimator can absorb: dead reckoning integrates what it is given, and a
tenth of the samples means a tenth of the evidence for every turn.

It is also the exact situation a real drive is. Nobody holds a phone awake and
unlocked through a tunnel.

### 11.2 The architecture, and why it is not the guide's

The build guide recommends embedding a JavaScript engine natively so both the
sensors and the maths escape throttling. That costs an embedded runtime, a
second execution environment to debug, and a bridge to keep in step.

It is unnecessary here because of a property nav-core already has and asserts:
**the engine is deterministic and driven by `sample.t`, not by wall clock.**
Feeding it ten buffered samples in one burst produces *exactly* the estimate ten
samples at 10 Hz would.

That changes what the WebView has to do. It does not need to **run** at 10 Hz.
It needs to **consume** 10 Hz, and it can do that in bursts whenever Android
lets it wake. What is lost is UI refresh rate — and the screen is off.

```
SensorLoopService   foreground service · PARTIAL wake lock · own HandlerThread
                    accel + gyro 100 Hz · barometer 5 Hz · magnetometer 10 Hz
                    LocationManager + GnssStatus (C/N0 mean AND spread)
                    ring buffer 2000 samples, oldest dropped AND counted
                         │  batch every 100 ms
   PathPulseSensorsPlugin  →  ForegroundSource  →  NavigationEngine
```

### 11.3 The files

| File | Lines | Purpose |
|---|---|---|
| `SensorLoopService.java` | 567 | The loop |
| `PathPulseSensorsPlugin.java` | 126 | The bridge — deliberately thin |
| `MainActivity.java` | 17 | Registers the plugin **before** `super.onCreate` |

**`MainActivity`** registers before `super.onCreate` because registering
afterwards leaves the web side calling a plugin that does not exist yet, which
surfaces as an "unimplemented" rejection rather than as anything informative.

**The plugin is deliberately stateless.** Anything holding state would lose it
exactly when the WebView is throttled — the case it exists for. It exposes
`start()`, `stop()` and `capabilities()`, and emits a `sensorBatch` listener
event.

**`capabilities()` is reported, not assumed:** `hasAccelerometer`,
`hasGyroscope`, `hasBarometer`, `hasMagnetometer`, `hasGnssStatus` (API ≥ 24),
`running`. A phone with no gyroscope is a phone on which dead reckoning draws a
straight line through every corner, and the app must say so.

**Batches, not events.** One bridge call per sample at 100 Hz is 100 JSON
serialisations a second across the JNI boundary, most of them while the screen
is off. A batch every 100 ms carries the same samples with the same timestamps
for a hundredth of the crossings — and the estimate is identical.

**A type bug worth keeping.** `JSObject` has no `Float` overload and falls
through to `toString()`, delivering `"9.81"` as a *string* that the web side
silently treats as `NaN`. Hence the explicit `Float`/`Long`/`Integer`/`Double`/
`Boolean` branches in `toJs()`.

### 11.4 One monotonic clock

`SensorEvent.timestamp` and `Location.getElapsedRealtimeNanos()` are both
elapsed-realtime. `System.currentTimeMillis()` jumps on network time correction,
and mixing the two gives a **negative `dt`** — which the engine's step-1 guard
then throws away.

### 11.5 It makes NavIC honest

`GnssStatus` reports the constellation of every tracked satellite, so
`ForegroundSource` is the only source in the project that can legitimately set
`constellationsSimulated: false`. It also supplies **C/N0 spread**, without
which Model 4 cannot separate multipath from spoofing.

### 11.6 Manifest

Service declared with `android:foregroundServiceType="location"` — **the type
must be declared here and passed to `startForeground()`** from Android 14;
mismatching the two is a crash on launch, not a warning.

Permissions and why each is there:

| Permission | Why |
|---|---|
| `ACCESS_FINE_LOCATION` | COARSE alone gives network positions accurate to hundreds of metres — precisely the behaviour this project exists to beat |
| `ACCESS_COARSE_LOCATION` | companion |
| `ACCESS_BACKGROUND_LOCATION` | keeps the estimate running with the screen off |
| `HIGH_SAMPLING_RATE_SENSORS` | mandatory from Android 12 to read the IMU above 200 Hz; without it the rate is **silently** capped |
| `FOREGROUND_SERVICE` + `_LOCATION`, `WAKE_LOCK` | back the Phase 15 service |
| `INTERNET`, `ACCESS_NETWORK_STATE` | first map-tile download only |

`uses-feature` for GPS, accelerometer and gyroscope are all
`required="false"` — the app must still install on a device without a gyroscope
and degrade loudly, rather than being hidden from it in the store.

### 11.7 Capacitor

`appId in.avinya.pathpulse`, `appName PathPulse`, `webDir out`,
`androidScheme: 'https'` (a `https://` scheme makes the WebView a secure
context, so geolocation and DeviceMotion are available inside the APK),
`allowMixedContent`, and `Geolocation.enableHighAccuracy: true` to match the web
hook — never serve a cached fix, the HUD wants the real cadence.

**APK size: ~12.7 MB.** It went 12.8 → 25.1 MB in one build because
`publish:apk` → `public/` → `out/` → assets meant each APK contained the
previous one. `scripts/strip-apk-from-assets.mjs` is the fix.

---

## 12 · `ml` — four models, end to end

3,481 lines of Python. PyTorch for training; **inference is pure TypeScript in
nav-core**, so the phone, the edge engine and the eval harness all run the same
network code.

### 12.1 `config.py` — the single source of truth

Window length, sample rate, channel order, splits, class lists and thresholds
all live here, because they have to agree across preprocessing, training,
position evaluation, ONNX export and the TypeScript runner. **They disagreed
once and the model silently predicted nonsense.**

```python
SAMPLE_RATE_HZ  = 10        # ★ the dataset is 10 Hz, not the guide's 50 Hz
WINDOW_SECONDS  = 2.0
WINDOW_SAMPLES  = 20
WINDOW_STRIDE   = 10        # 50 % overlap
CHANNELS        = ["ax","ay","az","gx","gy","gz"]   # order is a contract
SEED            = 1337
MAX_SPEED_MPS   = 40.0      # the same ceiling the engine uses

MOTION_WINDOW_SECONDS = 1.0 # a motion STATE changes in a few hundred ms
MOTION_WINDOW_SAMPLES = 10
MOTION_STATES = ["STATIONARY","IDLING","STRAIGHT","TURNING_LEFT",
                 "TURNING_RIGHT","ACCELERATING","BRAKING","POTHOLE_EVENT"]
GNSS_QUALITY_CLASSES = ["GOOD","MULTIPATH","SPOOFED","LOST"]
```

**Why 10 Hz and not the guide's 50 Hz.** IO-VNBD's smartphone log is 10 Hz —
verified from the median delta of `TIME SINCE START`. Upsampling to 50 Hz gives
the guide's 100-sample window, but 80 of those samples would be *interpolation*:
no information above 5 Hz exists in the recording, so the vibration features the
guide hopes to capture are not there to capture. Training happens at the
dataset's native rate; the phone's stream is decimated to match at inference.

**Splits are sequence-wise, never random.** Windows overlap by 50 %, so a random
split puts near-duplicate windows in train and test and reports a score that is
mostly memorisation.

- `TRAIN`: S2, S3a, S3c, S4, V-Vfa01/02, Vta01a/01b/02/03/05/06/07/10/11/12/13,
  Vtb01, Vtb03
- `VAL`: Vta04, Vta08, Vtb02, S3b, Vw03
- `TEST`: Vw02, S1

Two curation notes kept in the source:
- **Vtb03 is included on purpose** — 13.7 minutes of stop-go traffic, 38 % of it
  stationary. Without it the training set is 96 % moving and the model never
  learns what a stopped vehicle looks like, which is the one case a navigation
  system must not get wrong.
- **Vw01 was removed** — 34 minutes of a car *idling*: engine at 880 rpm, wheel
  speed exactly zero for all 20,475 rows. Not corrupt, just useless for
  regression, and at 24 % of the training set it would have taught the model to
  answer "zero".

**What the split does and does not prove:** the test *sequences* are held out, so
no window and no route from them is trained on. Other sessions by the same two
drivers are in train, so this measures generalisation to a **new journey**, not
to a new vehicle or a new phone. Claiming the latter would need a driver-
disjoint split, and the dataset has only two drivers with enough data.

### 12.2 Data pipeline

| File | Lines | Purpose |
|---|---|---|
| `data/download.py` | 212 | IO-VNBD via the **Git LFS batch API** — 215 MB, not the 40-hour repo |
| `data/preprocess.py` | 292 | Model 1 windows; augmentation is **plausible phone mountings**, not uniform SO(3) |
| `data/preprocess_motion.py` | 468 | Model 2 windows, CAN-bus labels, and the rigid-mount screen |
| `models/speed_cnn.py` | 83 | 1D-CNN regressor |
| `models/motion_cnn.py` | 61 | 1D-CNN classifier |

Label thresholds (`config.py`), with provenance stated rather than implied:

```
MOTION_STOP_SPEED_MPS    0.5    below this the wheels are not turning   [CAN]
MOTION_IDLE_ENERGY_MPS2  0.06   std of |a| over the window              [phone]
MOTION_TURN_RATE_RADS    0.15   ~8.6 °/s — a deliberate turn            [CAN]
MOTION_ACCEL_MPS2        0.7    sustained longitudinal change           [CAN]
MOTION_POTHOLE_MPS2      3.5    impulse above the local mean of |a|     [phone]
```

Six of the eight classes are labelled from the **car's own CAN bus** — wheel
speed and yaw rate — which is real supervision from an instrument that keeps
working in the tunnels where GPS does not. Two are self-labelled from the
phone's IMU and are weaker claims, and the source says so, because *"our AI
detects potholes"* is a claim a judge is entitled to ask the provenance of.

### 12.3 ★ The dataset finding

**Most of IO-VNBD's phones were not rigidly mounted.**

The files *are* synchronised — GPS speed vs CAN speed correlates above 0.9
almost everywhere — but the phone's **gyroscope** tracks the car's yaw rate in
only **two of twenty-six** sequences (0.949 and 0.935; everything else below
0.34). In the rest the handset was loose on a seat or in a bag, measuring its
own motion rather than the vehicle's.

Survivable for a **speed** model, because a moving car shakes its whole cabin
and the vibration energy still carries the speed. **Fatal** for a model whose
classes are TURNING_LEFT and TURNING_RIGHT.

`MOTION_RIGID_MIN_CORR = 0.5` screens sequences on that correlation and drops
the failures **loudly**. It costs most of the dataset and buys labels that mean
what they say.

Also found: **the gyroscope columns are not in the accelerometer's axis order.**
The header says Yaw/Pitch/Roll; measured against CAN yaw it is column 16 that
carries the vertical rate (+0.935), not the one called "Yaw" (+0.071).

### 12.4 Model 1 — speed from IMU

`train.py` (178), `models/speed_cnn.py`, `export.py` (336),
`evaluate_position.py` (384).

1D-CNN, **26,081 parameters**, input 20×6 (2 s @ 10 Hz), output speed in m/s.
Trained against CNN, ridge and constant baselines.

**Held-out test (`Vw02`, `S1`):**

| Model | MAE m/s | RMSE m/s | R² | MAE km/h |
|---|---|---|---|---|
| **CNN (ours)** | **2.93** | 3.91 | **0.786** | 10.5 |
| Ridge baseline | 4.29 | 5.28 | 0.610 | 15.5 |
| Constant | 7.24 | 8.46 | −0.002 | 26.1 |

23 epochs, best validation loss 2.697.

**The ISRO screening artefact — `evaluate_position.py`.** Sequence `Vw02`:
87.9 minutes, 98.4 km, heading from the vehicle's own yaw sensor (correlation
0.882 against GPS course). Dead reckoning is run over repeated artificial
outages using each speed source:

| Speed source | MAE m/s | drift @30 s | @60 s | @120 s |
|---|---|---|---|---|
| Truth speed (the DR floor) | 0.00 | 2.2 % | 4.4 % | 7.7 % |
| **CNN (ours)** | 3.65 | **17.6 %** | **17.6 %** | **16.1 %** |
| Ridge | 4.77 | 24.9 % | 28.5 % | — |
| Constant | 8.67 | 45.5 % | 49.9 % | — |

The "truth speed" row is the floor: what dead reckoning costs even with a
perfect speedometer. That is the honest denominator for any speed model.

### 12.5 Model 2 — motion-state classifier

`train_motion.py` (237), `export_motion.py`.

1D-CNN, **9,736 parameters, 50.7 KB**, one second of IMU, eight classes.
**Macro-F1, not accuracy** — 63 % of windows are STRAIGHT.

| class | support | precision | recall | F1 |
|---|---|---|---|---|
| STATIONARY | 0 | — | — | — |
| IDLING | 1120 | 0.70 | 0.12 | 0.20 |
| STRAIGHT | 4634 | 0.61 | 0.79 | 0.69 |
| **TURNING_LEFT** | 749 | 0.85 | 0.86 | **0.85** |
| **TURNING_RIGHT** | 772 | 0.89 | 0.92 | **0.91** |
| ACCELERATING | 1004 | 0.08 | 0.03 | 0.05 |
| BRAKING | 2010 | 0.37 | 0.35 | 0.36 |
| POTHOLE_EVENT | 59 | 0.19 | 0.75 | 0.30 |

**test macro-F1 0.480** against a **0.088** majority baseline; test accuracy
0.574 against 0.448. Best epoch 16 of 27; validation macro-F1 0.648.

**Three uses in the engine, each changing a decision:**
1. A confident stop fires a ZUPT the thresholds miss — held to a *higher* bar
   (0.85 vs 0.6) because measured IDLING precision is 0.70.
2. A pothole sample is **held, not zeroed**.
3. The 40 s tilt mean **freezes through corners**.

**Two mistakes worth keeping:**
- Fed raw device axes with a **uniformly-random-yaw augmentation**, three
  classes scored an F1 of **exactly 0.000** and the best epoch was epoch zero.
  Accelerating and braking are one axis with opposite signs, so a model told the
  heading is random has been told the sign carries no information.
- **IO-VNBD's time column is milliseconds**, which made every acceleration
  1000× too small. The symptom was a class balance with **5 ACCELERATING windows
  in eighty thousand**.

### 12.6 Model 3 — AI drift residual. **It does not work, and the number is published.**

`train_residual.py` (264). 1,506 parameters, 188,178 rows, eleven features read
straight from `engine.driftFeatures`:

```
timeSinceGnssS · speedMps · distanceSinceOutageM · covarianceAlongM
covarianceCrossM · headingSigmaDeg · turnsSinceOutage · zuptsSinceOutage
gyroBiasZ · accelBiasMag · roadMatched
```

Route-disjoint, both directions, against a baseline of predicting zero:

| split | along MAE | cross MAE |
|---|---|---|
| train city → test highway | 70.0 → **206.9 m** (−195 %) | 24.2 → 73.2 m (−202 %) |
| train highway → test city | 45.5 → **426.1 m** (−837 %) | 33.1 → 247.6 m (−649 %) |

City and highway barely overlap in speed, distance or covariance, so a network
fitted on one **extrapolates** on the other — confidently and linearly.

**What the failure did prove:** `clampResidual` bounds every correction to the
estimator's own covariance. Re-measured through it:

| split, clamped | along MAE | cross MAE |
|---|---|---|
| city → highway | 70.0 → 89.6 m (−28 %) | 24.2 → 24.3 m (−0.5 %) |
| highway → city | 45.5 → 67.8 m (−49 %) | 33.1 → 33.4 m (−0.9 %) |

The metrics file records `"generalises": false` and the caveat that every log is
simulated, so this measures generalisation across route types **within one
simulator**, not to a real vehicle.

### 12.7 Model 4 — GNSS quality classifier

`train_gnss_quality.py` (241), fed by `packages/eval/src/gnss-quality-dataset.ts`.

988 parameters, 6.1 KB, 1,430 rows, eleven features → GOOD / MULTIPATH /
SPOOFED / LOST:

```
satCount · satDropFromBaseline · meanCn0 · cn0Spread · accuracyM
accuracyRatio · jumpM · impliedSpeedMps · imuDisagreementMps
fixIntervalS · hdop
```

Log-disjoint results: **macro-F1 0.995** (city → highway) and **0.988**
(highway → city) against a 0.250 chance baseline.

**And that number means almost nothing**, because the labels are corruptions
generated by a function in this same repository. The classifier learned that
function, not an urban canyon. **The training script prints that above the
score.**

**A unit test caught real train/serve skew.** Fed an obviously dead receiver,
the first model answered **SPOOFED**, because every training log was one class
throughout so the baselines adapted to the corruption. Every pass now transitions
out of GOOD at a randomised onset.

It is **advisory**: it lowers the confidence bar and can never gate a fix.

### 12.8 Export and verification

`export.py` (336) + `export_motion.py` + `export_gnss_quality.py` (595 lines
total) write:

- **ONNX** — the interoperable artefact (`speed_model.onnx`,
  `speed_model.int8.onnx`, `motion_model.onnx`)
- **Folded-weights JSON** — base64 Float32 blocks, BatchNorm folded into the
  preceding convolution, class names and feature order embedded

Both are **verified against PyTorch to 1e-6**, and `nav-core/test/cnn.test.ts`
checks the TypeScript runner against probe vectors PyTorch produced
(`test/probes.json`) so the two implementations cannot drift apart silently.

### 12.9 `check_sim_transfer.py` — the file that keeps the honesty ledger honest

**Do the models transfer to our simulated logs? No.**

| | on real IO-VNBD | on our simulated IMU |
|---|---|---|
| Model 1 speed MAE | 2.93 m/s | **8–20 m/s** |
| Model 2 accuracy | 57.4 % | **12.8 %** |

**That is a statement about the logs, not about the models** — the synthetic IMU
in `sensor-sources/simulation/imu.ts` does not reproduce a real vehicle's
vibration signature. And it is precisely why the published ablation has **no AI
row**: including one would be measuring the simulator, not the model.

### 12.10 Running the pipeline

```bash
python -m venv ml/.venv && source ml/.venv/bin/activate
pip install -r ml/requirements.txt

python ml/data/download.py            # IO-VNBD via the LFS batch API (215 MB)
./ml/run_all.sh                       # Model 1: preprocess → train → export → evaluate
python ml/train_motion.py             # Model 2
python ml/train_residual.py           # Model 3 (needs pnpm eval:drift-dataset first)
python ml/train_gnss_quality.py       # Model 4 (needs pnpm eval:gnss-dataset first)
python ml/check_sim_transfer.py       # do they transfer? no, and here is the proof
```

Artefacts land in `ml/results/` (metrics JSON, `.pt` checkpoints, plots) and
`ml/export/` (ONNX + JSON), and the JSON weights are copied into
`apps/web/public/models/`.

---

## 13 · `scripts` — build and data tooling

| File | Lines | Purpose |
|---|---|---|
| `check-core-purity.mjs` | 118 | **Golden Rule 1.** Strips comments and string literals, *then* scans. Caught three real violations |
| `android-toolchain.mjs` | 186 | Finds a JDK 17–21 and the Android SDK **without Android Studio**, and names the missing thing instead of throwing a Gradle stack trace |
| `android-build.mjs` | 45 | Runs Gradle with that toolchain in **its environment only** — never mutating the user's shell |
| `strip-apk-from-assets.mjs` | 44 | Stops the APK containing the previous APK (12.8 → 25.1 MB in one build) |
| `clean-dupes.mjs` | 54 | Removes duplicated assets after `cap sync` |
| `build-road-graph.mjs` | 263 | OSM/Overpass → road graph JSON. **Excludes footways** — a car is not on the pavement |
| `make-routes.mjs` | 172 | Generates the city and highway routes |
| `make-demo-log.mjs` | 81 | The bundled `public/replay/demo.jsonl` |
| `make-offline-brief.mjs` | 167 | `docs/offline-brief.html` |
| `publish-apk.mjs` | 60 | Copies the built APK into `public/downloads/` and writes `apk.json` (size, sha, build id) |
| `apk-path.mjs` | 14 | Prints where the APK landed |

---

## 14 · `configs` and `data` — the ablation inputs

### 14.1 `configs/*.json` — twelve configurations

Each is a name, a description (which becomes the row's explanation in
`docs/benchmarks.md`) and an `engine` patch over `DEFAULT_ENGINE_CONFIG`.

| Config | What it adds |
|---|---|
| `naive` | double integration and nothing else — the baseline |
| `filtered` | + median and low-pass |
| `zaru` | + ZARU |
| `zupt` | + ZUPT |
| `nhc` | + NHC |
| `speedclamp` | + plausibility ceiling and coasting decay |
| `highpass` | + acceleration high-pass |
| `full` | **what ships**, including road snapping |
| `full_forwardbias` | negative result, kept deliberately |
| `eskf` | `full` + position from the ESKF |
| `hmm` | `full` + Newson-Krumm matching |
| `particle` | `full` + particle filter + turn relocalisation |
| `full_ml` | `full` + Model 1 — **not in the published table**; see `check_sim_transfer.py` |

### 14.2 `data/replay/` — the logs

JSONL, one `SensorSample` per line, exactly what the engine saw.

| Prefix | Meaning |
|---|---|
| `sim_*` | **Simulated**, generated by `pnpm eval:record`, deterministic and committed so the benchmarks reproduce from this repository alone |
| `drive_*` | **Real**, recorded on a phone. **None exist yet.** |

Committed: `sim_city_1337`, `sim_city_4242`, `sim_highway_1337`,
`sim_highway_4242`.

The harness treats both identically — that is the point of having a format
rather than a special case — but `docs/benchmarks.md` states at the top when
every log is simulated, because presenting a simulated figure as a road result
would be the most damaging thing this project could do.

Recording a real one requires **good GNSS throughout**, because the recorded
fixes *become* the ground truth the artificial outage is scored against. A log
recorded in an urban canyon measures the estimator against a bad reference and
tells you nothing.

### 14.3 `data/maps/` — the road graphs

| Graph | Ways | Size | BBox |
|---|---|---|---|
| `city` | 725 | 146 KB | 77.2123, 28.6241 → 77.2281, 28.6393 |
| `highway` | 1041 | 206 KB | 77.1800, 28.5417 → 77.2034, 28.5643 |
| `jabalpur` | 9462 | 2,265 KB | 79.8753, 23.1146 → 79.9925, 23.2224 |

`index.json` lists them with bboxes so `lib/roadGraph.ts` can pick by position.
Any area can also be downloaded at runtime from the Offline panel, which uses
the same road-class filter as the build script and stores the result in
IndexedDB — bundled and downloaded graphs are indistinguishable at use.

### 14.4 `data/routes/`

`route_city.json` and `route_highway.json` — the paths the simulator follows.

---

## 15 · Results

All figures reproduce with the command named next to them. **Every log is
simulated**; see §20.

### 15.1 Drift — the ablation (`pnpm ablation`)

12 runs per configuration: 4 logs × 3 outage windows. Ground truth is each log's
own recorded GNSS, withheld from the estimator over the outage window.

| Configuration | Mean % | Median % | p90 % | Max % | RMSE m | Along m | Cross m | CEP95 m |
|---|---|---|---|---|---|---|---|---|
| naive | 59.5 | 57.9 | 80.9 | 81.1 | 348.3 | 297.5 | 173.7 | 600.4 |
| filtered | 59.3 | 57.9 | 80.9 | 81.0 | 347.2 | 295.1 | 175.2 | 598.1 |
| zaru | 57.7 | 50.5 | 81.7 | 81.9 | 346.1 | 299.8 | 165.3 | 597.2 |
| zupt | 57.5 | 52.3 | 76.5 | 77.3 | 342.2 | 300.4 | 156.5 | 590.6 |
| **nhc** | **33.5** | 34.7 | 52.6 | 57.5 | 170.3 | 146.5 | 71.3 | 317.6 |
| speedclamp | 30.2 | 34.7 | 52.6 | 57.5 | 152.6 | 128.4 | 69.9 | 265.3 |
| **highpass** | **14.6** | 16.6 | 25.9 | 27.5 | 92.0 | 71.7 | 49.7 | 150.1 |
| **full (ships)** | **9.2** | **5.3** | 22.6 | 28.2 | 71.4 | 57.4 | 39.6 | 118.4 |
| ~~full_forwardbias~~ | 13.3 | 14.5 | 21.6 | 26.8 | 85.2 | 71.2 | 41.8 | 152.4 |
| ~~eskf~~ | 10.1 | 8.5 | **19.4** | 25.0 | 80.5 | 62.2 | 46.2 | 135.3 |
| ~~hmm~~ | 10.5 | 7.0 | 25.1 | 30.5 | 73.4 | 59.8 | 39.5 | 126.2 |
| ~~particle~~ | 13.0 | 10.1 | 22.7 | 28.1 | 90.6 | 85.5 | **22.6** | 180.3 |

**9.2 % mean — inside the problem statement's <10 % target.** The two largest
single wins are NHC (57.5 → 33.5) and the acceleration high-pass (30.2 → 14.6).

Behaviour columns from the same run:

| Configuration | Recovery s | Update Hz | ZUPT | Road snap % | Resets |
|---|---|---|---|---|---|
| naive / filtered / zaru | 1.02 | 50.0 | 0 | 0.0 | 10 |
| zupt | 1.02 | 50.0 | 18 | 0.0 | 10 |
| nhc | 14.75 | 50.0 | 18 | 0.0 | 0 |
| speedclamp | 14.50 | 50.0 | 18 | 0.0 | 0 |
| highpass | 8.68 | 50.0 | 18 | 0.0 | 0 |
| **full** | **6.29** | 50.0 | 18 | 99.7 | 0 |
| eskf | 6.85 | 50.0 | 18 | 99.2 | 0 |
| hmm | 6.29 | 50.0 | 18 | 99.7 | 0 |
| particle | 6.96 | 50.0 | 18 | 99.7 | 0 |

### 15.2 Is the marker on a road? (`pnpm eval:offroad`)

Only samples drawn while `DEAD_RECKONING` are counted; 37,196 of them.

| | mean | median | p90 | max | >10 m | >25 m |
|---|---|---|---|---|---|---|
| **shipped (`full`)** | **0.8 m** | **0.0 m** | **0.0 m** | 71.1 m | **2.8 %** | **0.8 %** |
| snapping off (`highpass`) | 15.7 m | 5.6 m | 49.9 m | 106.5 m | 35.2 % | 21.9 % |
| *before the wide-radius fix* | *12.5 m* | *3.6 m* | *46.6 m* | *106.5 m* | *26.9 %* | *12.5 %* |

### 15.3 A crooked phone (`pnpm eval:alignment`)

| Mount offset | OFF mean % | OFF p90 % | ON mean % | ON p90 % |
|---|---|---|---|---|
| 0° (control) | 9.0 | 22.6 | 9.2 | 22.6 |
| 15° | 9.6 | 23.7 | 9.1 | 22.6 |
| 30° | 12.7 | 26.3 | **9.2** | 22.7 |
| 45° | 14.9 | 29.7 | **9.2** | 22.7 |
| 60° | 25.4 | 47.4 | **9.4** | 22.7 |
| 90° | 37.1 | 57.7 | **9.1** | 22.6 |

Mount-angle estimate error 3.1–4.1°. **The claim is not "better" — it is
"independent".** Drift stops depending on how the phone was mounted.

### 15.4 The edge engine (`pnpm edge:bench`)

Each run: 20 s of GNSS aiding, then a 60 s total outage at 60 km/h.

| Grade | Rate | Gyro bias | Drift % | Along m | Cross m | Heading err | Latency ms | Sustained |
|---|---|---|---|---|---|---|---|---|
| Phone MEMS | 50 Hz | 206.265 °/hr | 26.4 | 56.5 | **258.5** | **3.08°** | 0.0117 | 82,756 Hz |
| Tactical | 100 Hz | 2.063 °/hr | 20.3 | 41.9 | **199.4** | **0.05°** | 0.0108 | 89,315 Hz |
| Fibre-optic | 200 Hz | 0.001 °/hr | 15.0 | 53.4 | **140.6** | **0.08°** | 0.0116 | 83,683 Hz |

In Docker against a 200 Hz target: **49,001 Hz sustained, 0.0896 ms p99** — the
guide's budget is 5 ms, so about **fifty times inside it**.

**Read the cross-track and heading columns, not the total.** Along-track error
comes from not knowing the speed, and no gyroscope fixes that; unaided it is the
same problem at every grade and dominates the total. Cross-track error comes
from heading, heading comes from the gyroscope, and that is where three orders
of magnitude of bias show up. Quoting only the total would say sensor grade
barely matters, which is false for the half of the error it governs.

### 15.5 Model results

Summarised in §12.4–12.7. In short: Model 1 works (2.93 m/s MAE, R² 0.786),
Model 2 works for turns (F1 0.85/0.91) and poorly elsewhere (macro-F1 0.480 vs
0.088 baseline), Model 3 does not generalise (−195 %/−837 %, clamped to
−28 %/−49 %), Model 4 scores 0.99 against labels this repository generated and
that number is reported as near-meaningless.

---

## 16 · Tests

**91 files, 1,464 tests.** `pnpm test` runs every package.

| Suite | Tests | What it guards |
|---|---|---|
| `nav-core` | 701 | The estimator, every constraint, every model contract |
| `apps/web` | 469 | UI, hooks, panels, offline |
| `eval` | 158 | The ablation itself, off-road, alignment |
| `sensor-sources` | 107 | Sources, the native bridge |
| `edge-engine` | 29 | Runner, grades, UDP, serial, sinks |

### 16.1 `packages/nav-core/test/` — 35 files

`core` · `engine` · `geo` · `filters` · `motion` · `attitude` · `autoalign` ·
`altimeter` · `constraints` · `eskf` · `hmm` · `roadsnap` · `particle` ·
`turns` · `trail` · `confidence` · `session` · `spoofing` (+ hostile) ·
`constellations` (+ hostile) · `ml` (+ hostile) · `cnn` · `residual` ·
`gnssQuality` · `twowheeler` · `pedestrian` · `trip-export` (+ hostile) ·
`invariants` · `perf` · `phase9-hostile` · `probes.json`.

### 16.2 The four that matter most

- **`invariants.test.ts` (440)** — determinism, no non-finite output ever, and
  **Golden Rule 6** (the dot never teleports) across *every* configuration and
  with a road graph that forces a way change mid-outage. It caught four
  regressions during this work, two of them introduced by fixes for something
  else.
- **`ablation.test.ts`** — asserts the published table, *including* that
  forward-bias, ESKF, HMM and the particle filter behave as documented. A
  component that stops earning its place fails a test; so does one that starts.
- **`offroad.test.ts`** — asserts the marker is *on a road*, which no drift
  figure can.
- **Model contract tests** — load the **actual exported weights** and assert the
  class list and feature order match the engine. A reordered class list does not
  throw: the model stays 90 % accurate and every answer is wrong.

### 16.3 Hostile-input tests

`spoofing-hostile`, `constellations-hostile`, `ml-hostile`,
`trip-export-hostile`, `phase9-hostile` — NaN, Infinity, empty arrays,
truncated weight blocks, backwards clocks, absurd coordinates. The engine's
contract is that it never emits a non-finite state, whatever it is fed.

### 16.4 Manual test guide

`docs/TESTING.md` (189 lines) is the on-phone checklist, about 15 minutes:
install → first run and tour → **the scripted demo** → layout → HUD → panels →
offline/aeroplane mode → export → device screen. It records the traps found on
real hardware, e.g. the **system Location toggle being off while the app
permission is granted** — the two look identical from inside the app.

`docs/field-protocol.md` (141 lines) is the drive protocol: five routes, three
runs, two mount positions and both kinds of ground truth, written to be executed
rather than read.

---

## 17 · Workflows, end to end

### 17.1 Development

```bash
pnpm install                 # pnpm 10 workspaces
pnpm dev                     # Next dev server, 1 s reload
pnpm dev:lan                 # -H 0.0.0.0, for a phone on the same wifi
pnpm dev:https               # experimental HTTPS — needed for DeviceMotion on a phone
pnpm test                    # 1,464 tests across five packages
pnpm typecheck               # tsc --noEmit, every package
pnpm lint:core-purity        # Golden Rule 1
```

The inner loop is deliberately the **simulator**: deterministic, offline, and
covering city and highway routes with scripted outages. A bug seen in the
browser reproduces byte-identically in a headless test.

### 17.2 The runtime data flow, in one picture

```
 SensorSource.start()
        │  onSample(SensorSample)
        ▼
 useSensorSource ──► useNavigationEngine ──► NavigationEngine.update(sample)
        │                    │                        │
        │                    │                        ├─► NavigationState (10 Hz)
        │                    │                        └─► EventLog, SessionStats
        │                    ├─► four ML loaders (independent effects)
        │                    └─► road graph: bundled index → IndexedDB → Overpass
        ▼
     page.tsx ──► MapView + layers · Hud · TrustPanel · panels
                     │
                     └─► trail accumulation → GPX / GeoJSON export
```

### 17.3 Android build

```bash
pnpm android:doctor          # finds JDK 17–21 + SDK, names what is missing
pnpm build:android           # next build → cap sync → clean-dupes
                             # → strip-apk-from-assets → gradle assembleDebug
                             # → prints the APK path (~12.7 MB)
pnpm cap:sync                # web assets only, no Gradle
pnpm publish:apk             # copy into public/downloads + write apk.json
pnpm build:site              # build:android → publish:apk → next build
```

**Ordering matters:** the APK must be published into `public/` *before* the site
build, or the download button ships pointing at nothing — and
`strip-apk-from-assets` must run after `cap sync`, or the new APK contains the
old one.

No Android Studio is required at any point.

### 17.4 Evaluation

```bash
pnpm eval:record                                   # regenerate the simulated logs
pnpm eval -- --list                                # what logs exist
pnpm eval -- --log sim_city_4242.jsonl --config full
pnpm ablation                                      # → docs/benchmarks.{md,csv,json}, ablation.svg
pnpm eval:offroad                                  # → docs/offroad.md
pnpm eval:alignment                                # → docs/alignment.md
pnpm eval:drift-dataset                            # training rows for Model 3
pnpm eval:gnss-dataset                             # training rows for Model 4
```

`docs/benchmarks.md` and friends are **generated — do not edit by hand.** The
engine is deterministic, so they reproduce exactly on any machine.

### 17.5 Edge engine

```bash
pnpm edge --grade FOG --rate 200 --seconds 60
pnpm edge:bench                                    # → docs/edge-benchmarks.md
docker build -f packages/edge-engine/Dockerfile -t pathpulse-edge .
docker run --rm -p 5555:5555/udp pathpulse-edge \
    --udp-in 5555 --rate 200 --udp-out 5556 --udp-host host.docker.internal
```

The Dockerfile is verified by **running**, not just building.

### 17.6 The ML loop

`config.py` → `download.py` → `preprocess*.py` → `train*.py` → `export*.py` →
`apps/web/public/models/*.json` → `lib/ml/*.ts` loader →
`nav-core/ml/*.ts` runner → the engine. Contract tests sit at the last hop and
assert class list and feature order.

### 17.7 The demo workflow (what a judge sees)

1. Open the app → Splash → Welcome → optional 4-step tour.
2. ☰ → *Where the data comes from* → **This phone** (one tap: selects *and*
   starts).
3. **▶ Demo** — a scripted outage:

| time | what happens |
|---|---|
| 0:00–0:15 | green **GNSS**, marker moving, trail green |
| 0:15 | flips to orange **Outage — dead reckoning** (scripted, and the banner says so) |
| 0:15–1:15 | trail orange, ellipse **stretches forward along the road** |
| 1:15 | blue **Recovery** — the marker *slides* back, never jumps |
| 1:20 | grey **Done**, drift readable in the HUD |

4. **Debug → Trust Panel** for the evidence: raw sensors, live constraint
   toggles, all four models, the event log, the stats.
5. **Offline** → download roads + tiles → aeroplane mode → it still works.
6. **Export** GPX/GeoJSON, or the recording as JSONL.

---

## 18 · Deployment

### 18.1 Web

`render.yaml` deploys the static export:

```yaml
type: web · runtime: static
buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm build
staticPublishPath: apps/web/out
NODE_VERSION: '22'
headers:  /health.json  → Cache-Control: no-store
          /downloads/*  → Access-Control-Allow-Origin: *
routes:   rewrite /404 → /404.html
```

Three decisions recorded in the file:

- **Use the static site; it never sleeps.** The 15-minute spin-down that makes
  the first visitor wait ~50 s applies to free *Web Services*. Choosing the right
  plan removes the problem instead of managing it.
- **No catch-all rewrite.** The single-page pattern (`/* → /index.html`) is wrong
  for a Next static export with several real HTML files: it would serve the app
  at `/about.html` and make the landing page unreachable **in production while
  working perfectly on localhost**.
- **`/health.json` must never be cached**, or a pinger gets a 304 from the edge
  and the origin is never touched — a keep-alive that looks alive in the network
  panel and does nothing where it matters.

### 18.2 The web-service fallback

`server.mjs` — a zero-dependency static server with a real `/health` endpoint,
correct MIME types (including `.apk`, `.onnx`, `.jsonl`), path normalisation
before joining (or `..` escapes the published folder), and
`Content-Disposition: attachment` for the APK so a browser opens the installer
rather than the file. Adding Express to serve a folder would be the largest
thing in the deployment.

### 18.3 Keep-alive

Two layers, doing different jobs:

- **`apps/web/lib/keepAlive.ts`** pings `/health.json` every 5 minutes *from the
  browser* — a judge reading the landing page keeps the service warm for the
  moment they press Download. It does nothing once the last tab closes.
- **`.github/workflows/keepalive.yml`** runs on GitHub's cron every 5 minutes
  regardless of whether anyone is looking. The interval is a *third* of the
  15-minute idle window, not a half, because GitHub queues cron on shared
  runners and two consecutive late runs must still land inside it. `--max-time
  90` exceeds the ~50 s cold boot, or the ping meant to wake the service reports
  failure instead. **If the site is a static site, delete this file.**

### 18.4 Mobile

The APK is a debug-signed build published to `apps/web/public/downloads/`
alongside `apk.json` (size, hash, build id), served with `Access-Control-Allow-
Origin: *` so a QR code on a slide works from anywhere.

### 18.5 Edge

Docker image built from the repository root (nav-core is a workspace sibling),
`tini` as PID 1, `--ignore-scripts` install, UDP 5555 exposed, entrypoint naming
the CLI so `docker run <image> --grade FOG --rate 200` behaves the way it
obviously should.

---

## 19 · What ships disabled, and why

The project's discipline is that a component earns its place by measurement.
Five do not, and all five are kept, toggleable, with published numbers.

| Component | Measured | Why it stays |
|---|---|---|
| **Forward bias** | 12.7 % → 19.1 % | Superseded by the high-pass; the negative result is demonstrable |
| **ESKF** | mean 10.1 vs 9.2, **p90 19.4 vs 22.6** | Better tail, worse middle — a real trade, and both halves are asserted |
| **HMM matching** | 10.5 vs 9.2, flat sweep | The capability is structural; these routes cannot show it |
| **Particle filter** | **city 13.3 vs 15.1**, highway 12.8 vs 3.2 | Helps exactly where junction ambiguity exists |
| **Drift residual (M3)** | 3–8× worse | Does not generalise across route types |

> **This is the strongest thing about the project, not the weakest.** A judge
> asking "what did you build that didn't work?" gets four numbers and an
> explanation, which is a far better answer than a table where everything won.

Each disabled component is switchable live from the Trust Panel's Constraints
tab, so the claim can be checked rather than believed.

---

## 20 · Honesty ledger — what is still simulated

| Claim | Basis |
|---|---|
| Drift, off-road, alignment figures | **Simulated logs.** Stated on every page that shows them. |
| FOG / tactical IMU rows | **Datasheet noise models.** We do not own the hardware. |
| Model 1 & 2 accuracy | **Real** held-out IO-VNBD journeys |
| Model 2 on our logs | 12.8 % accuracy — **the models do not transfer to synthetic IMU** |
| Model 4 macro-F1 0.99 | **Modelled corruptions.** Means almost nothing. |
| NavIC constellation counts | **Measured** via `GnssStatus` (native only); simulated elsewhere and labelled |
| Screen-off 10 Hz | **Compiles and is unit-tested. Not yet verified on a road.** |

`python ml/check_sim_transfer.py` exists solely to keep the first row honest.
**That is a statement about the logs, not about the models** — and it is why the
ablation has no AI row.

---

## 21 · Problem-statement compliance

| Requirement | Where | Status |
|---|---|---|
| In-vehicle alignment & calibration | Phase 4, **12** | ✅ automatic, 3–4° |
| AI speed & vibration filter | Phase 8, **13** | ✅ Models 1 & 2 |
| Advanced map matching & kinematic constraints | 6D, **14** | ✅ NHC + snap + HMM |
| GNSS+INS fusion (AI based) | 4, **11**, **13** | ✅ ESKF + Models 3, 4 |
| Seamless GNSS deficit handler (ms) | Phase 4 | ✅ shadow mode, **0 ms** |
| Real-time navigation interface | 1, 5, 9 | ✅ |
| Drift < 10 % of distance | 6, 7 | ✅ **9.2 % measured** |
| 10 Hz update (smartphone) | 4, 10, **15** | ✅ native loop |
| 200 Hz (edge, FOG IMU) | **16** | ✅ 49,001 Hz sustained |
| IO-VNBD trained models | 8, **13** | ✅ four models |
| IO-VNBD position plot | 8 | ✅ screening artefact |
| Mobile application | 3 | ✅ APK, ~12.7 MB |
| **Edge deployable software engine** | **16** | ✅ Docker, UDP, serial |
| On-device inference, no cloud | 8, 13 | ✅ pure-TS network runner |
| Offline map database | 6, 9, offline | ✅ downloadable anywhere |
| Pothole / vibration rejection | 4, **13** | ✅ Model 2 + median filter |
| Phone misalignment handling | **12** | ✅ |
| **Two-wheeler support** | **18B** | ✅ lean detection + compensation |
| NavIC | 9E, **15** | ✅ measured via `GnssStatus` |

### Phase history

| Part | Phases | Delivered |
|---|---|---|
| **A** | 0–10 | repo skeleton and the purity rule · map and live GNSS marker · sensor abstraction and simulator · Android APK via Capacitor · **state machine, dead reckoning, recovery blender** · HUD and debug panel · **NHC, ZUPT, ZARU, road snapping, speed clamp** · eval harness and ablation table · **IO-VNBD speed model and the ISRO screening plot** · confidence ellipse, turn detection, offline basemap, spoofing detection, NavIC breakdown, GPX export · demo mode, crash-proofing, in-app pitch deck |
| **B** | 11 | Error-State Kalman Filter, 15 states |
| | 12 | Automatic in-vehicle alignment (PCA) |
| | 13 | Models 2, 3 and 4 |
| | 14 | Newson-Krumm HMM map matching |
| | 15 | The native sensor loop that survives the screen going off |
| | 16 | The edge engine completed — UDP, serial, sinks, Docker |
| | 17 | The map-aided particle filter and turn relocalisation ★ |
| | 18 | Two-wheelers, and the field protocol |

---

## 22 · What remains — and it needs a vehicle

1. **Drive `docs/field-protocol.md`.** Every number in this document is
   simulated. The gap between a software outage and a real tunnel is the most
   interesting figure this project could produce.
2. **Verify screen-off operation.** Install, lock, drive 10 minutes, read the
   *native* rate on the SENSORS tab. It compiles and is unit-tested; only a road
   can confirm it.
3. **Re-run `check_sim_transfer.py` on real logs.** If the models come good, the
   ablation gains an AI row and every model claim drops its caveat.
4. **Retrain Models 2, 3 and 4 on real recordings.** Model 3 failed to generalise
   across *simulated* route types; only real data can say whether that was the
   model or the simulator.

**Two setup steps silently void a drive:** download the road graph for the area
(Offline → *Download roads + map*), and disable battery optimisation for the
app. Both are in the protocol's checklist.

---

## 23 · Command reference

```bash
# Setup
pnpm install

# Develop
pnpm dev                  # Next dev server
pnpm dev:lan              # bind 0.0.0.0 for a phone on the same wifi
pnpm dev:https            # HTTPS — DeviceMotion needs a secure context

# Verify
pnpm test                 # 1,464 tests
pnpm typecheck
pnpm lint:core-purity     # Golden Rule 1

# Measure
pnpm eval:record          # regenerate the simulated logs (deterministic)
pnpm eval -- --list
pnpm eval -- --log sim_city_4242.jsonl --config full
pnpm ablation             # the headline drift table
pnpm eval:offroad         # is the marker on a road?
pnpm eval:alignment       # what a crooked mount costs
pnpm eval:drift-dataset   # training rows for Model 3
pnpm eval:gnss-dataset    # training rows for Model 4

# Android
pnpm android:doctor       # JDK + SDK, no Android Studio needed
pnpm build:android        # APK, ~12.7 MB
pnpm publish:apk
pnpm build:site           # APK + publish + site

# Edge
pnpm edge --grade FOG --rate 200 --seconds 60
pnpm edge:bench
docker build -f packages/edge-engine/Dockerfile -t pathpulse-edge .

# ML
./ml/run_all.sh                    # Model 1, end to end
python ml/train_motion.py          # Model 2
python ml/train_residual.py        # Model 3
python ml/train_gnss_quality.py    # Model 4
python ml/check_sim_transfer.py    # do the models transfer?

# Demo assets
pnpm demo:log
pnpm demo:brief
```

---

## How to read this codebase

1. **`packages/nav-core/src/types.ts`** — the contracts everything agrees on.
2. **`NavigationEngine.update()`** — the nine steps, in order.
3. **`constraints/`** — the physics, one file per idea.
4. **`packages/eval/`** — where every number comes from.

The comments are the design record. Where something is surprising, the comment
says what was measured and what the alternative cost — most of them exist
because the obvious thing was tried first and was worse.

---

*Every figure in this document is reproducible by the command next to it.
Nothing here is a projection. Every drive log is simulated, and every table that
depends on one says so.*
