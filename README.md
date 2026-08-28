# PathPulse

**Intelligent Dead Reckoning System for seamless navigation.**

When GNSS drops out — a tunnel, basement parking, an urban canyon — the blue dot
freezes or scatters. PathPulse keeps it moving by estimating vehicle motion from
the phone's own inertial sensors, constrains that estimate with vehicle physics
and road geometry, and slides the dot smoothly back onto truth when satellites
return. No internet, no cloud API, no special hardware.

> Smart India Hackathon 2026 · Problem Statement **SIH26168** · Indian Space
> Research Organisation (ISRO) · Theme: Smart Vehicles · Team **Avinya**

---

## Status

**Phases 0-6 complete.** The dot
survives a GNSS outage, and the six defects a real-phone field test exposed on
2026-08-27 are fixed.

Measured drift across 24 simulated scenarios — two routes, four seeds, three
outage windows — is **9.6% mean**, inside the problem statement's <10% target.
The p90 is 21.5%, so the mean clears it and the worst cases do not. The full
ablation — including one component reported as a negative result and disabled —
is in [`PROJECT_STATUS.md`](./PROJECT_STATUS.md).

## Tech stack

| Concern | Choice | Cost |
| --- | --- | --- |
| Map rendering | MapLibre GL JS | Free |
| Map data | OpenStreetMap | Free |
| Positioning | Phone GNSS + IMU | Free |
| App shell | Next.js 14 + TypeScript + Tailwind | Free |
| Android packaging | Capacitor 6 | Free |
| ML training | PyTorch on Google Colab | Free |
| Dataset | IO-VNBD | Free |

Total spend: ₹0. No paid APIs, no IoT hardware.

## Setup

Requires Node 20+, pnpm, and (from Phase 3) Android Studio with the Android SDK.

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # nav-core unit tests
pnpm build        # static export into apps/web/out
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Static export to `apps/web/out` (this is what Capacitor wraps) |
| `pnpm test` | All workspace tests (502) |
| `pnpm typecheck` | `tsc --noEmit` across every package |
| `pnpm lint:core-purity` | **Enforces Golden Rule #1** (see below) |

### Map configuration

The basemap works with no setup: with no API key it falls back to OpenStreetMap
raster tiles, darkened in CSS to match the HUD. For a proper vector dark style,
put a MapTiler key in `apps/web/.env.local`:

```
NEXT_PUBLIC_MAPTILER_KEY=your_key_here
```

Style selection lives in `apps/web/config/map.ts` behind `resolveMapStyle()`, so
Phase 9 can swap in an offline PMTiles basemap without touching `MapView`.

### Building the Android APK

Prerequisites: **JDK 17** (Capacitor 6 requires it — 7 and 8 need JDK 21),
Android Studio with the SDK, and a phone with USB debugging on.

```bash
pnpm build:android
```

That runs `next build` → `cap sync android` → `gradlew assembleDebug` and
prints the APK path. Install it:

```bash
adb install -r apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

| | |
| --- | --- |
| Package | `in.avinya.pathpulse` |
| Size | ~4.7 MB |
| Output | `apps/web/android/app/build/outputs/apk/debug/app-debug.apk` |

**`apps/web/android/` is committed on purpose.** `AndroidManifest.xml` carries
our permissions, and a fresh clone running `cap add android` would regenerate
the project and silently drop them. Only build output and `local.properties`
are ignored.

Permissions requested, and why:

| Permission | Why |
| --- | --- |
| `ACCESS_FINE_LOCATION` | GNSS-grade fixes. COARSE alone gives network positions off by hundreds of metres — the exact behaviour this project exists to beat. |
| `ACCESS_BACKGROUND_LOCATION` | A real tunnel drive is not done with the app in the foreground. |
| `HIGH_SAMPLING_RATE_SENSORS` | Mandatory from Android 12 to read the IMU above 200 Hz. Without it the rate is silently capped and dead reckoning quietly degrades instead of failing loudly. |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK` | Back the Phase 15 foreground service. |
| `INTERNET` | First map-tile download only. Everything after works offline. |

Common failures:
- **Gradle can't find the SDK** → `apps/web/android/local.properties` needs
  `sdk.dir=$HOME/Library/Android/sdk`. It is machine-specific and gitignored.
- **White screen in the APK** → `webDir` is wrong, or `out/` was not built.
- **`output: export` error** → a server component crept in; every page needs
  `'use client'`.

### Testing on a phone in the browser (no APK)

Your laptop and phone must be on the same Wi-Fi. Start the server bound to all
interfaces:

```bash
pnpm dev:lan          # serves on http://<your-lan-ip>:3000
```

Then on the phone:

| What you want | URL | Works? |
| --- | --- | --- |
| Map, marker, trail, mode colours | `http://<lan-ip>:3000/?mock=1` | ✅ works as-is |
| **Real GPS** | `http://<lan-ip>:3000` | ❌ blocked — see below |

**Why real GPS is blocked over LAN:** browsers only expose
`navigator.geolocation` in a *secure context* — HTTPS, or `localhost`. A plain
`http://192.168.x.x` origin is neither, so the API is unavailable and the app
shows its "Geolocation unsupported" screen. This is a browser rule, not a bug.

Three ways around it:

1. **Android Chrome flag** (fastest, no certificates). Open
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
   `http://<lan-ip>:3000`, set the flag to Enabled, relaunch Chrome. Chrome now
   treats that origin as secure and geolocation works. Remove it when done.
2. **HTTPS tunnel** (works on iOS too). Any tunnel that gives a public HTTPS
   URL — e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`
   — makes the origin secure. Note this exposes your dev server publicly for the
   life of the tunnel.
3. **Wait for Phase 3.** The Capacitor APK uses native location permissions and
   has no secure-context requirement at all. This is the real answer.

`next dev --experimental-https` (`pnpm dev:https`) is *not* a solution here: its
self-signed certificate covers only `localhost`/`127.0.0.1`, so a phone hitting
the LAN IP gets a certificate name mismatch.

### Development without a car, a tunnel, or even GPS

Open the app, pick **Simulation → City**, press **Play**. A virtual vehicle
drives a 2 km route emitting 50 Hz IMU and 1 Hz GNSS, at up to 5× speed.

This is the single biggest time-saver in the build: a browser refresh is one
second, an APK rebuild is three minutes, and driving to a real tunnel is an
afternoon. Teams that skip it end up testing outdoors after every change.

The simulator is deliberately realistic, because a simulator that lies makes
every downstream number a lie:

| Modelled | Why it matters |
| --- | --- |
| Gravity in the accelerometer (+9.81 up at rest) | It measures specific force, not acceleration. The sign error makes the estimator think you are accelerating upward forever. |
| Constant sensor bias | Bias double-integrates into ~36 m of error per minute. White noise averages out; bias does not. This is what makes dead reckoning hard. |
| Gaussian white noise | accel σ 0.05 m/s², gyro σ 0.002 rad/s |
| 20 Hz vertical vibration | The engine/road shake that Phase 13's motion classifier must reject |
| Red-light stops | Every stop is a chance for ZUPT to reset the error budget |
| Cornering and bend speed limits | Exercises NHC and gives the gyroscope a real yaw rate |

`simulateGnssOutage(startMs, durationMs)` removes the `gnss` field entirely —
never zeroed, never faked — which is exactly the shape a real tunnel produces.

Everything is seeded and deterministic: the same seed yields byte-identical
samples, so the Phase 7 ablation table measures constraints rather than luck.

### Road graphs

Road snapping needs a local road graph. They are generated once from
OpenStreetMap and committed, so nothing touches the network at runtime:

```bash
node scripts/build-road-graph.mjs --route city         # the demo routes
node scripts/build-road-graph.mjs --route highway
node scripts/build-road-graph.mjs --centre 23.18,79.99 --radius 4000 --name local
```

Each run writes `data/maps/road_graph_<name>.json`, a copy into
`apps/web/public/maps/`, and updates `index.json` — a manifest of bounding
boxes. The app reads the manifest on the first fix and loads whichever graph
covers where it actually is, so testing outside the demo area degrades to "no
graph here" (visible on the SENSORS tab) rather than to silence.

**Generate one for wherever you test.** Roughly 150–200 KB per 2 km square, and
it ships inside the APK.

Routes are generated, not hand-typed:

```bash
node scripts/make-routes.mjs   # data/routes/*.json
```

## Repository layout

```
pathpulse/
├── apps/web/                 Next.js 14 App Router — map, HUD, debug panel
├── packages/nav-core/        ★ PURE TypeScript — all navigation math
├── packages/sensor-sources/  Sensor implementations behind one interface
├── packages/eval/            Evaluation CLI + ablation runner (Phase 7)
├── data/routes/              Simulation routes (GeoJSON)
├── data/replay/              Recorded sensor logs (JSONL)
├── data/maps/                Road graph + offline basemap
├── ml/                       IO-VNBD training pipeline (Phase 8)
├── configs/                  Ablation configurations (Phase 7)
├── scripts/                  Build + lint tooling
└── docs/                     Generated benchmarks
```

## How it works

```
INITIALIZING
   └─ 3 consecutive fixes under 20 m ────────→ GNSS

GNSS  (dead reckoning is ALSO running here — shadow mode)
   └─ accuracy > 25 m, or < 4 sats,
      or no fix for 1.5 s ───────────────────→ GNSS_DEGRADED

GNSS_DEGRADED
   ├─ 2 consecutive good fixes ──────────────→ GNSS
   └─ degraded for 2 s ──────────────────────→ DEAD_RECKONING

DEAD_RECKONING
   ├─ propagate from IMU every sample
   └─ 2 consecutive good fixes ──────────────→ RECOVERING

RECOVERING
   ├─ measure drift = |estimate − truth|
   ├─ slew the offset to zero over 2 s
   └─ done ──────────────────────────────────→ GNSS
```

Three decisions do most of the work:

**Shadow mode.** Dead reckoning is not started when GNSS fails — it runs
continuously in every mode, reset by each good fix. When GNSS drops there is
nothing to spin up and no initialisation to perform. That is how the problem
statement's *"seamless handover within milliseconds"* is met: there is no
handover.

**Hysteresis everywhere.** Every transition needs several consecutive
confirmations or a sustained condition, never a single sample. Without it a fix
hovering near the accuracy threshold makes the badge strobe several times a
second, and the demo reads as broken however good the maths is.

**Never teleport.** When GNSS returns, our estimate is some metres from truth.
Snapping to the correct answer is mathematically ideal and looks like a bug, so
the offset is eased to zero over two seconds instead — against a *live* GNSS
target, because the vehicle is still moving.

## Demo features — and how to use them

Phase 5 exists for one reason: a judge's default assumption is that the demo is
playing back canned data, and nothing in a HUD can disprove that, because a
scripted animation can display any numbers it likes. These five can.

| Feature | Where | How to use it in the demo |
| --- | --- | --- |
| **HUD** | top-left | Big mode badge, speed, drift, drift %, distance, time since GNSS, confidence bar. The update rate is counted from real frames and turns amber below 10 Hz — the problem statement's floor. |
| **Live raw sensors** | Debug → SENSORS | Put the phone flat on the table. The accelerometer still twitches by 0.01-0.05. Real sensor data is always slightly dirty; canned data is suspiciously smooth. Then hand the phone to the judge and let them rotate it — heading moves, gyro jumps. |
| **Constraint toggles** | Debug → CONSTRAINTS | ★ The strongest one. Mid-outage, switch ZUPT or NHC off and the estimate visibly degrades; switch it back and it recovers. **A fake demo never breaks.** Anything you can break on request is real. Changes take effect on the next sample — no restart. |
| **Event log** | Debug → EVENTS | Every mode change with its *reason* and a millisecond timestamp: `MODE_CHANGE GNSS -> GNSS_DEGRADED (accuracy 31.0m)`. An animation cannot explain itself. Exportable as JSON so the run can be checked afterwards. |
| **Session stats** | Debug → STATS | Duration, distance, outage count and durations, best/worst/mean drift. The drift figures here are **measured against a real fix on recovery**, not the engine's own uncertainty model. |
| **Walking Mode** | Debug → CONSTRAINTS | Clamps speed to 3 m/s so you can walk the corridor with the phone and watch the dot move. Live physics, no vehicle needed. |

The debug panel states `n/a` for satellite count and C/N0 rather than inventing
them — those need the native `GnssStatus` API in Phase 15. Road snapping has no
toggle yet because it is not built; a switch that did nothing would be worse
than its absence.

## Constraints

Each of these is a runtime flag on `EngineConfig`, so it can be switched off
live — which is both the ablation table and the strongest anti-fake demo there
is. A scripted animation cannot be broken on request.

| Constraint | Physics | What it fixes |
| --- | --- | --- |
| **Attitude** (`alignment/attitude.ts`) | Gravity marks the vertical; yaw is rotation about it | Heading that only worked with the phone flat on its back |
| **NHC** | A car cannot slide sideways or fly | Cross-track drift — the error that puts the marker inside a building |
| **ZUPT** | A stopped vehicle has exactly zero velocity | A stationary phone inventing kilometres of travel; also calibrates accelerometer bias free at every red light |
| **ZARU** | A stopped vehicle is not turning, so the gyro reading is pure bias | Heading drift — 0.01 rad/s of bias is 113° over a 197 s outage |
| **Road snapping** | A vehicle is on a road, and that fact is perpendicular to it | Cross-track error, and via the matched road's speed limit, along-track too |
| **Accel high-pass** | Real longitudinal acceleration averages to zero over a minute; tilt error does not | The acceleration runaway — dead reckoning speeding up on its own until it hits its clamp |
| ~~Forward bias~~ | GNSS Doppler as a truth signal for longitudinal acceleration | **Off — measured worse.** 12.7% drift without it, 19.1% with. Superseded by the high-pass; kept and documented as a negative result |
| **Speed clamp** | Vehicles obey physics, and roads have limits | Integrated sensor error masquerading as motion |
| **Adaptive fix timeout** | The receiver's cadence is observable, so observe it | "DEAD RECKONING" being announced under open sky on a 0.2 Hz receiver |

The ablation is generated in CI by
`packages/sensor-sources/test/ablation.test.ts`. Ground truth is the GNSS the
simulator withheld: drive with good GNSS, record, then delete it in software —
honest and reproducible.

### Why attitude accuracy is position accuracy

An accelerometer measures gravity and motion mixed together. A **1 degree**
error in knowing which way is down injects sin(1°) × 9.81 = 0.171 m/s² of false
acceleration — which double-integrates to **~308 metres of position error per
minute**. One degree. This is why Phase 12 builds a real alignment engine.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ UI LAYER          Next.js + React + MapLibre               │
│ map · marker · mode badge · HUD · debug panel · replay     │
└──────────────────────────┬─────────────────────────────────┘
                           │ 10 Hz NavigationState
┌──────────────────────────▼─────────────────────────────────┐
│ nav-core     ★ PURE TYPESCRIPT — NO React, NO browser API  │
│    filters → alignment → deadreckoning → constraints       │
│                     road snap / map match                  │
│                    state machine + metrics                 │
└──────────┬─────────────────────────────────┬───────────────┘
           │                                 │
┌──────────▼──────────┐          ┌───────────▼──────────────┐
│ SENSOR SOURCES      │          │ MAP LAYER                │
│ · SimulationSource  │          │ OSM tiles (cached)       │
│ · WebSource         │          │ Local road graph (JSON)  │
│ · NativeSource      │          │ PMTiles offline basemap  │
│ · ReplaySource      │          └──────────────────────────┘
└─────────────────────┘
```

### Golden Rule #1 — `nav-core` is pure

`packages/nav-core` must never import or reference `window`, `document`,
`fetch`, `navigator`, `localStorage`, React, or any Node runtime API. Pure
functions only: input in, output out.

This is not style policing. It is the single decision the whole project rests
on, because it means **one implementation of the navigation math serves four
targets**:

- the browser during development (refresh in 1 second, not a 3-minute rebuild)
- the Capacitor Android APK
- headless replay tests and the ablation harness in CI
- the Part B **edge engine** at 200 Hz on an external IMU — which the problem
  statement lists as a compulsory deliverable, not future scope

Break the rule and Part B becomes a rewrite. It is enforced mechanically:

```bash
pnpm lint:core-purity
```

The checker strips comments and string literals before scanning, so the file
that documents the rule does not trip it.

## Geodesy notes

`nav-core/src/geo` converts between geodetic coordinates and a local
**East-North-Up** tangent plane in metres, via full WGS84 ECEF (Bowring's
closed-form inverse — no convergence loop to blow the 10 Hz budget).

Dead reckoning integrates metres per second. Doing that in degrees would drag a
latitude-dependent scale factor through every step. So we convert once at the
reference point, do all the math in flat metres, and convert back only for
display.

`haversineDistance` is deliberately spherical and is used only for reporting
distances. It disagrees with the ellipsoidal ENU path by ~0.3% at Delhi's
latitude; that is model difference, not drift, and the tests assert it stays
within 0.5%.

## Team

**Team Avinya** — SIH 2026, Problem Statement SIH26168 (ISRO).
