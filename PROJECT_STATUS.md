# PROJECT STATUS

**CURRENT PHASE:** Phase 6 — Constraints (NHC, ZUPT, ZARU, road snapping) ✅ COMPLETE
**LAST UPDATED:** 2026-08-27
**NEXT PHASE:** Phase 7 — eval harness + ablation CLI

> Phases 0-6 are complete. Phase 7 formalises the ablation below into the
> standalone eval CLI and config files the guide specifies.

> ### Drift across 24 scenarios: **9.6% mean** — inside the PS target
>
> Two routes x four seeds x three outage windows, generated in CI by
> `packages/sensor-sources/test/ablation.test.ts`. Ground truth is the GNSS the
> simulator withheld.
>
> | Configuration | Mean drift % | Median | p90 | Max |
> |---|---|---|---|---|
> | naive (no constraints) | 208.8 | 162.0 | 668.5 | 709.0 |
> | + filters | 206.6 | 162.5 | 663.1 | 700.6 |
> | + ZARU | 126.2 | 83.9 | 280.7 | 389.2 |
> | + ZUPT | 105.9 | 93.4 | 181.9 | 190.6 |
> | + NHC | 77.6 | 81.2 | 187.9 | 215.3 |
> | + speed clamp | 75.6 | 81.2 | 187.9 | 215.3 |
> | + accel high-pass | 12.7 | 11.5 | 22.9 | 25.2 |
> | **+ road snapping (shipped)** | **9.6** | 8.2 | 21.5 | 22.6 |
> | + forward-bias | 12.6 | 12.1 | 23.0 | 29.7 |
>
> **The last row is a negative result, reported deliberately** — see Phase 6D
> below. Three earlier figures in this file are retracted: 6.26% (one
> favourable scenario), 19.1% and 12.7% (both measured before later fixes).
>
> Still simulation, not a real drive. The p90 of 21.5% is the honest tail: the
> mean clears the target, the worst cases do not.

---

## ★ FIELD TEST 2026-08-27 — six defects found and fixed

Testing the Phase 4 APK on a real phone showed the marker wandering off-road
with GNSS on, and continuing to "drive" at 25 km/h while the handset was
standing still. Six separate causes, all now fixed and pinned by tests in
`packages/nav-core/test/constraints.test.ts`.

**1. Yaw was read from device Z instead of the true vertical.**
`DeadReckoningEngine` integrated `gz` directly. That is only yaw when the phone
lies flat on its back; upright in a cradle, `gz` measures roll. New
`alignment/attitude.ts` projects the gyro vector onto measured gravity, so yaw
is correct in any orientation. Heading now tracks truth within 1-2° through a
60 s outage; it was 14° out and growing.

**2. Nothing ever called ZUPT, ZARU, or the bias setters.**
`applyZeroVelocity()`, `setGyroBias()` and `setAccelBias()` existed since Phase
4 and had **zero call sites**. Stationarity was computed every sample and
discarded. With no ZUPT, `speed = speed + accel*dt` held the last speed forever:
197 s of standing still produced 4 km of imaginary travel. Now in
`constraints/zupt.ts` and `constraints/zaru.ts`.

**3. DEAD RECKONING was announced under open sky.**
The state machine's 1.5 s no-fix timeout assumes a 1 Hz receiver. The device
delivered **0.05–0.20 Hz** — a fix every 5 to 20 s — so it dropped to dead
reckoning ~3.5 s after every fix and free-ran until the next one. That is the
sawtooth trail in the field screenshots. The timeout now tracks the receiver's
observed median fix interval, with a 6 s provisional value during warm-up.

**4. The simulator disagreed with every real device by a sign.**
`simulation/imu.ts` emitted `gz` as a compass-sense yaw rate; real hardware
(`DeviceMotionEvent.rotationRate`, Android `SensorManager`) uses the right-hand
rule, where a right turn is negative. The engine could be tuned to look perfect
in simulation while turning the wrong way on a phone. The contract is now
documented on `SensorSample.imu` and the simulator obeys it.

**5. The stationarity threshold was above the moving-vehicle distribution.**
Measured against the simulator's own ground-truth speed: moving p05 = 0.0296,
stopped p50 = 0.0065. The threshold was 0.05 — so a cruising vehicle read as
"stationary" and ZUPT zeroed a real 13.8 m/s. Now 0.015, with asymmetric
hysteresis: 25 samples to enter a stop, one sample to leave it.

**6. Gravity removal ate the vehicle's acceleration.**
A 0.25 Hz low-pass "gravity" estimate follows a five-second acceleration, so
subtracting it cancels the very signal being measured — speed never rebuilt
after a stop. Replaced with a complementary filter: gyro carries the vertical
short-term, accelerometer anchors it over ~30 s.

**Also fixed:** the marker teleported 63 m backwards on entering dead reckoning
(the smoothed seed rewound position and heading — Golden Rule #6); the recovery
slew targeted a frozen fix, so at 0.2 Hz it lurched instead of sliding; and both
live sources emitted a second sample per fix, pushing the same IMU reading
through every filter window twice.

**New:** `constraints/forwardBias.ts` — learns the residual forward-acceleration
error from GNSS Doppler while GNSS is available and cancels it during the
outage. Capped at 0.35 m/s², which is sin(2°)×9.81: two degrees of mount tilt.
Worth 194 m → 37 m in the table above.

---

## COMPLETED

### Phase 0 — Repo skeleton
pnpm monorepo, pure `nav-core` (types + WGS84 geodesy, Bowring ECEF/ENU),
Next.js 14 static export, `scripts/check-core-purity.mjs`.

### Phase 1 — Map + live GNSS marker
MapLibre dark basemap behind `resolveMapStyle()`, heading-rotated
`VehicleMarker`, mode-coloured `TrailLayer`, `useGeolocation`, permission gate
that distinguishes insecure-origin from real denial. Trail segment logic lives
in `nav-core` and is unit tested.

### Phase 2 — Sensor Abstraction + Simulation

**`packages/sensor-sources`** — browser APIs allowed here, never in nav-core.

- `types.ts` — the `SensorSource` interface all four implementations satisfy
- `simulation/rng.ts` — seeded mulberry32 + Box-Muller Gaussian
- `simulation/route.ts` — `RoutePath`: GeoJSON → ENU polyline, arc-length
  addressing, and **heading smoothed over a 14 m window** so corners produce a
  finite yaw rate instead of the infinite one a raw polyline implies
- `simulation/vehicle.ts` — kinematic model: accelerates, brakes for stop
  lines, slows for bends via a lateral-acceleration limit, holds 10 s at red
  lights. `CITY_VEHICLE` / `HIGHWAY_VEHICLE` presets.
- `simulation/imu.ts` — specific-force synthesis: gravity included (+9.81 up
  when level), Gaussian noise, **constant bias**, and 20 Hz vertical vibration
  scaled by whether the vehicle is moving
- `simulation/SimulationSource.ts` — 50 Hz IMU, 1 Hz GNSS,
  `simulateGnssOutage(startMs, durationMs)`, 1×–5× playback, deterministic
  per seed
- `replay/ReplaySource.ts` — JSONL replay at original timing; tolerates a
  truncated final line and sorts out-of-order samples
- `recording/RecordingWrapper.ts` — wraps any source, records verbatim JSONL
- `web/WebSource.ts` — DeviceMotion + Geolocation, iOS `requestPermission`
  from a gesture, deg/s → rad/s conversion

**`data/routes/`** — generated by `scripts/make-routes.mjs` from **OSRM /
OpenStreetMap**, so every coordinate sits on a real carriageway:
- `route_city.json` — **1995 m**, 8 turns, 3 stops. Outer Circle → Kasturba
  Gandhi Marg → Connaught Lane → Atul Grove Road.
- `route_highway.json` — **2995 m**, 2 turns. Outer Ring Road / Khelgaon
  Flyover — sweeping bends, no junctions.

The first version generated these geometrically ("400 m east, turn right,
350 m south"). Lengths were exact but the vehicle drove **through buildings**,
which looks broken on the map and would not survive a judge glancing at it.
Regenerating needs network; the committed JSON means the app, the tests and the
eval harness never do.

**`apps/web`**
- `hooks/useSensorSource.ts` — owns the active source, measures real sample
  rates, exposes play/pause/reset/speed/outage/download
- `components/SourcePanel.tsx` — source dropdown, route picker, transport
  controls, 1×–5× slider, progress bar, GNSS-loss button, recording download
- **`hooks/useMockTrack.ts` deleted** — superseded, as promised in Phase 1

### Phase 3 — Android APK via Capacitor

- **Capacitor 6.2.1**, not 8. Capacitor 7+ requires JDK 21; this machine has
  JDK 17. Pinned deliberately, recorded here so it is revisited on purpose.
- `capacitor.config.ts` — appId `in.avinya.pathpulse`, `webDir: 'out'`,
  `androidScheme: 'https'`. That scheme matters: it makes the WebView a
  **secure context**, so geolocation works inside the APK without the
  http-origin block that stops it over a LAN.
- `AndroidManifest.xml` — 9 permissions incl. `HIGH_SAMPLING_RATE_SENSORS`;
  GPS/accelerometer/gyroscope declared `required="false"` so the app still
  installs and degrades on a device that lacks them.
- `sensor-sources/src/native/NativeSource.ts` — Capacitor Geolocation + Motion
  behind the same `SensorSource` interface. Capacitor modules are imported
  **lazily**, or they would be pulled into the web bundle and break
  `next build`. Live mode picks Native inside the APK and Web in a browser.
- `apps/web/lib/platform.ts` + `components/DeviceInfo.tsx` — Device screen
  showing platform, model, OS, WebView version, secure-context flag, measured
  IMU/GNSS rates and permission state.
- `scripts/apk-path.mjs` — prints APK path and size after a build.

**Verified by inspecting the built binary, not the source manifest:**
package `in.avinya.pathpulse`, all 9 permissions present including
`HIGH_SAMPLING_RATE_SENSORS`, web assets bundled under `assets/public/`
including `index.html`. **4.7 MB.**

### Phase 4 — State Machine + Dead Reckoning + Recovery

All in `nav-core`, still pure (24 files, 0 violations).

- `filters/` — `MedianFilter` (spike/pothole rejection), `LowPassFilter`
  (2nd-order Butterworth, primed at the first sample so it injects no startup
  transient), `StationarityDetector` (keys on accel *variance*, not magnitude —
  magnitude is ~9.81 whether parked or cruising)
- `alignment/` — `GravityRemover` (quaternion path preferred, low-pass
  fallback) and `SimpleAlignment`. Carries the project's most important
  comment: **1° attitude error = 0.171 m/s² false acceleration ≈ 308 m of
  position error per minute.**
- `deadreckoning/` — `DeadReckoningEngine`. Compass sign convention documented
  explicitly. Speed priority: GNSS Doppler → integrated accel, clamped to
  0–40 m/s. Seeds an outage from a **smoothed** pre-outage state and rejects a
  final fix whose accuracy is an outlier, because the last fix before a tunnel
  is usually the worst one in the drive.
- `state/` — `NavigationStateMachine` with hysteresis on every transition, plus
  a bounded `EventLog` recording each change *with its reason*.
- `fusion/` — `RecoveryBlender`. Eased slew over 2 s (1 s for gross drift), and
  it decays the offset against a **live** GNSS target, not a frozen one, since
  the vehicle keeps moving during recovery.
- `engine/` — `NavigationEngine` ties it together and suppresses non-finite
  states rather than letting a NaN move the marker to nowhere.

**★ Shadow mode**: dead reckoning propagates on *every* sample in *every* mode,
reset by each good fix. There is no start-up when GNSS drops because there is
no handover — that is how the PS's "seamless within milliseconds" is met.

`apps/web` now renders **from `NavigationState`**, never from raw GNSS. That
single change is what lets the marker keep moving during an outage.

**Verified in-browser** on the production export: full
GNSS → DEAD RECKONING → RECOVERING → GNSS loop, marker moving at 50 km/h with
GNSS gone, drift and confidence live on screen, measured update rate
**11–12 Hz** (requirement is ≥10).

## HOW TO RUN

```bash
pnpm install
pnpm dev              # http://localhost:3000
pnpm build:android    # -> apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Pick **Simulation → City**, press **Play**. No GPS, no car, no tunnel needed.

## HOW TO TEST

```bash
pnpm test             # 144/144
pnpm typecheck        # clean across 4 packages
pnpm lint:core-purity # 0 violations
pnpm build            # static export
node scripts/make-routes.mjs   # regenerate routes
```

| Package | Tests |
| --- | --- |
| `nav-core` | 70 — geodesy (18), trail (15), filters (10), engine (27) |
| `sensor-sources` | 38 — simulation (21), replay/recording (11), engine integration (6) |
| `apps/web` | 36 — geolocation (16), map config (11), modes (6), deriveMode (5) |

Verified in a browser against the production static export: IMU **50.0 Hz**,
GNSS **1.00 Hz** (measured, not hardcoded), vehicle turned 90°→180° on schedule,
stopped at the first red light, 3962 samples recorded, GNSS-loss button flipped
the badge to DEAD RECKONING and blanked accuracy.

## ARCHITECTURE NOTES

- **The simulation physics is pure and deterministic.** `advance(dtMs)` is the
  entry point; `start()` merely calls it on a timer. Tests run a 400-second
  drive in milliseconds, and the Phase 7 ablation table compares constraint
  configs rather than random seeds.
- **Bias matters more than noise.** White noise averages out; a constant
  0.02 m/s² accelerometer bias double-integrates into ~36 m after a minute.
  Simulating without it would make dead reckoning look far better than it is.
- **The accelerometer reports specific force, not acceleration** — +9.81 on the
  up axis at rest. A test pins this, because the sign error makes the estimator
  believe the vehicle is accelerating upward forever.
- **Outages remove the `gnss` field entirely**, never zero or fake it — the same
  shape a real tunnel produces.
- **Routes follow real roads, not synthetic geometry.** Also means the
  simulated drive is a fair test for Phase 6 road snapping — snapping to a road
  the route was never on would prove nothing.
- **The noise test differences two runs sharing a seed** — one with the real
  sensor model, one ideal. The difference is exactly bias plus white noise. An
  earlier version sampled "steady cruise" instead and ended up measuring real
  cornering once the routes became road-shaped.
- **Stops and bends are in the model on purpose.** ZUPT fires at red lights and
  NHC is exercised by turns; a constant-speed simulator would make the whole
  harness worthless.

## KNOWN ISSUES

- **Device-verified 2026-08-27**: APK installed via LAN download on a physical
  Android phone. Location permission granted, map rendered, live source
  selected, and the marker tracked real movement while walking around indoors.
  Installs → runs → real GNSS works inside the APK, confirming the
  `androidScheme: 'https'` secure-context decision.
- **`@capacitor/motion` has no native Android implementation.** It wraps the
  WebView's `DeviceMotionEvent`, so IMU rate is whatever the WebView allows,
  not `SENSOR_DELAY_FASTEST`, and it is throttled with the screen off.
  Satellite count and constellation are not exposed either. Both need the
  native Kotlin sensor loop in Phase 15. The Device screen states this
  on-screen rather than implying we have 200 Hz.
- **Capacitor pinned to 6** for JDK 17. Moving to 7/8 means installing JDK 21.

- **Browser timers throttle in background tabs.** `SimulationSource` drives
  itself with `setInterval`, which drops to ~1 Hz when the tab is hidden. Fine
  in the foreground; the same class of problem the guide flags for Android
  WebView in Phase 15.
- MapLibre pinned to 5.24.0 — a risk choice, not a bug fix. v6 was verified
  working in isolation; its worker under Next/webpack is untested.
- Satellite count unavailable on web; needs native `GnssStatus` (Phase 15).
- Real GPS needs a secure context — see README for phone testing.
- Do not run `pnpm build` while `pnpm dev` is live.

## KNOWN LIMITS AFTER THE FIELD FIXES

- **Along-track error still dominates.** Heading is now good to 1-2° over a
  60 s outage, so what remains is speed. Unaided accelerometer integration
  cannot distinguish a parked car from one cruising at a steady 50 km/h, which
  is a property of the sensor, not of the code. `coastingDecay` bleeds an
  unaided estimate off after 45 s rather than asserting it indefinitely.
  Road snapping (6D) and the ML speed model (Phase 8) are the real answers.
- **Road snapping is not implemented.** `constraints/roadsnap.ts` and the road
  graph are still to do, so cross-track error is bounded only by NHC.
- **GNSS fix rate on the test device is 0.05-0.20 Hz**, not the 1 Hz the
  Capacitor plugin implies. The engine now adapts to it, but the underlying
  rate is a WebView/bridge limitation that Phase 15's native Kotlin loop is
  meant to remove.
- **The ablation is one route, one seed, one outage, in simulation.** It is a
  regression guard, not a benchmark. Treat it as such in the deck.

### Phase 5 — HUD + Debug Panel + Trust Features

- **`components/Hud.tsx`** (5A) — large mode badge, speed in 2 rem monospace,
  heading, drift and drift %, distance, time since GNSS, along/cross
  uncertainty, confidence bar. The measured output rate turns amber below
  10 Hz, so falling under the PS floor is visible rather than silent.
- **`components/TrustPanel.tsx`** — the four anti-fake features as tabs, so it
  stays legible on a phone held up in front of a judge:
  - **SENSORS** (5B) — raw accel/gyro every frame, measured IMU/GNSS/engine
    rates, the *observed* GNSS fix interval and the resulting loss timeout,
    stationarity and accel variance, accel/gyro/forward biases, ZUPT and ZARU
    counters. Satellites and C/N0 show `n/a`, not a fabricated number.
  - **CONSTRAINTS** (5C) — eight live toggles plus Walking Mode. Wired to real
    `ConstraintFlags`, not placeholders: `NavigationEngine.setConfig()` applies
    them on the next sample with no restart.
  - **EVENTS** (5D) — newest first, `mm:ss.mmm` timestamps, colour-coded by
    type, JSON export.
  - **STATS** (5F) — from a new pure `state/SessionStats.ts`: duration,
    distance, max speed, outage count/total/longest, and best/worst/mean drift
    **measured on recovery** rather than modelled.
- **Walking Mode** (5E) — drops the speed ceiling to 3 m/s through the same
  live config path.
- `components/StatusBar.tsx` deleted — superseded by `Hud.tsx`.

**Tested:** `SessionStats` has 8 unit tests; `setConfig` has 4, including one
that drives two engines through an identical 20 s aided run and a 70 s
stationary outage with ZUPT toggled off on one of them, asserting they end
**more than 100 m apart**. That is the assertion the demo claim rests on — a
toggle that produced identical output would make the whole panel theatre.

**Verified:** `pnpm build` static export succeeds; the dev server renders the
page with no console or hydration errors; 14 hook tests cover throttling,
diagnostics, stats, live toggles, Walking Mode, reset and hostile input.
**Not verified: the rendered UI in a real browser** — no browser automation was
available in this session, so no toggle has ever been clicked. Run the TEST
steps on the phone before relying on it.

### Field test 2 — five more defects (2026-08-27, evening)

Screenshots from the Xiaomi 2406ERN9CI showed 144 km/h while the phone was
being moved hand to hand, a grey line drawn from Delhi to the user's location
after switching source, and the badge stuck on ACQUIRING.

1. **Dead reckoning ran before it had an anchor.** Shadow mode propagated on
   every sample in every mode — including INITIALIZING, when there is no
   position, heading or speed to correct against. It was integrating hand
   movement and gravity leakage. 144 km/h is 40 m/s: exactly the plausibility
   ceiling, which is what a runaway integration always saturates at. It also
   claimed 551 m travelled before the system knew where it was. Propagation is
   now gated on `dr.isInitialised`.
2. **The device reports no Doppler speed or heading.** `coords.speed` is
   nullable and this handset returns null, so the engine had NO speed
   reference at all and `ForwardBiasEstimator` never received an observation —
   the panel read `FWD BIAS 0.000 (0)` for a whole session. Both are now
   derived from consecutive trusted fixes (heading only past 5 m of
   displacement, below which the direction is fix noise).
3. **The trail drew during ACQUIRING.** With no ENU origin the engine reports
   (0, 0), and INITIALIZING is grey — hence a grey line from the old source's
   position to the first real fix. The trail and the follow-camera now ignore
   states with no valid position.
4. **Engine output was 8.3 Hz, below the PS's 10 Hz floor.** The UI throttle
   emitted on the first sample *past* 100 ms; at the 37 Hz this device
   delivers that is 108 ms. It now emits one sample early, landing at ~81 ms.
5. **ACQUIRING lasted over 30 s.** Three consecutive fixes at one fix per 11 s.
   Reduced to two; each must still clear the accuracy gate.

### Deep test pass 2 — coverage-driven, three latent bugs found

Ran coverage rather than guessing where the holes were, then wrote tests for
the least-covered code. Three real defects fell out, all of them silent.

**1. `RecordingWrapper` recorded nothing unless somebody subscribed** — and
recorded every sample TWICE if two things did. It registered its recording
callback inside `onSample`, so the buffer's contents depended on who happened
to be listening. A duplicated log still looks plausible: same timestamps, just
twice each. Now subscribes to the inner source exactly once, in the
constructor.

**2. `NativeSource.stop()` never released the GPS watch.** `this.watchId = null`
ran synchronously, long before the lazy `import('@capacitor/geolocation')`
resolved — so `clearWatch` was called with `null`. The watch kept running after
stop, draining battery and delivering fixes to a source the app believed was
shut down, with nothing on screen to show it. The id is now captured first.

**3. `SimpleAlignment.toVehicleFrame` applied the inverse rotation.** The offset
is `atan2(meanX, meanY)`, so the vehicle's forward direction in device
coordinates is `(sin θ, cos θ)` and the forward component must be
`x·sin θ + y·cos θ`. Both signs were the other way round. Latent only because
the offset is zero until calibration runs and nothing calls
`startCalibration()` yet — but a phone mounted at 90 degrees would have
reported forward acceleration as backward, and dead reckoning would have driven
the vehicle in reverse.

Also removed `GravityRemover` outright. It was dead code — defined, exported,
referenced only in a comment — and its low-pass approach is the very thing the
complementary filter replaced. Dead code that still looks plausible is worse
than no code, because the next reader assumes it is the path in use.

**Coverage:** nav-core 89.3% → **93.7%**, sensor-sources 63.6% → **93.1%**,
`WebSource` 7.7% → **93.3%**, `NativeSource` 8.0% → **~93%**,
`RecordingWrapper`/`nhc`/`roadsnap`/`events`/`gravity` at **100%**.
**394 tests** (was 289).

**Still uncovered, deliberately:** `apps/web/lib/platform.ts` (Capacitor Device
plugin, no logic of its own) and the React components (rendering, not logic —
and no browser automation has been available in any session, so the UI has
still never been clicked).

### Phase 6D — road graph + road snapping ✅

- **`scripts/build-road-graph.mjs`** — Overpass -> `data/maps/road_graph_<name>.json`
  plus an `index.json` manifest of bounding boxes. Takes `--route city|highway`,
  `--centre lat,lon --radius m`, or an explicit `--bbox`. Excludes footways and
  cycleways, so a car can never be snapped onto a pavement. Run once and
  committed: a demo that needs a live API is a demo that fails on bad wifi.
  (Overpass answers **406** without an identifiable `User-Agent` — that cost
  two failed runs before it was obvious.)
- **`nav-core/src/mapmatch/RoadIndex.ts`** — 100 m grid, segments pre-projected
  into ENU once at construction and stamped into *every* cell they cross, so a
  1 km road is findable from its middle and not only its ends.
- **`nav-core/src/constraints/roadsnap.ts`** — perpendicular projection,
  candidate scoring (distance + heading + continuity bonus), and a blended
  correction that is **cross-track only**. Two-way roads fold the reverse
  direction to a zero mismatch; one-way roads keep it, which is what separates
  the carriageways of a dual carriageway.
- Wired in the guide's order — propagate -> NHC -> ZUPT/ZARU -> road snap ->
  clamp — and applied to the position about to be *drawn*, never to the
  dead-reckoning state, so a bad match cannot be integrated forward.
- The app picks the graph whose bbox contains the first fix, from the manifest,
  and reports "none here" when there isn't one rather than looking broken.

**What it actually bought, measured honestly:**

| | cross-track | along-track |
|---|---|---|
| off | 78.3 m | 68.1 m |
| on | ~75 m | 31.9 m |

Almost none of the gain is the snapping geometry. Cross-track error (~78 m)
exceeds the 50 m search radius, so the nearest road is frequently the *wrong*
road — the known failure of nearest-road matching, and exactly why the guide
schedules Newson-Krumm HMM for Phase 14.

**The gain is 6E, the road speed-limit clamp** — and it only works when gated
on match confidence. Feeding the limit from any match inside the full radius
made highway along-track error *worse*, 107 m -> 135 m, by applying a service
road's limit to a vehicle on a trunk road. Restricting it to matches within
20 m and 45 degrees turns the same mechanism into 107 m -> 34 m, and the result
becomes stable across search radii of 25, 50 and 80 m — parameter-insensitivity
being the difference between a fix and a fitted constant.

Road snapping is still shipped and on: it does what it claims (92% match rate,
cross-track only, tested), it is what keeps the marker off the buildings during
a demo, and it is the hook Phase 14 replaces with a real map matcher.

### Field test 3 — the acceleration runaway, and a component demoted

A terrace walk with a hand-held phone gave 288 m drift over 555 m (52%) on one
recovery and 35.6 m over 796 m (4.5%) on the next. The spread is the finding.

**Dead reckoning accelerated on its own.** A residual tilt of 1.58 deg is
0.27 m/s^2 of acceleration that is not real; integrated, it reaches the 3 m/s
Walking Mode clamp in eleven seconds and the 40 m/s vehicle clamp in about two
and a half minutes. The terrace test saturated its clamp during a 136 s outage
and recorded 712 m of travel on foot.

`ForwardBiasEstimator` was supposed to remove exactly this, but it had
`minSpeedMps: 3` — above walking pace — so on foot it received **zero
observations** and corrected nothing.

The fix is a slow high-pass on forward acceleration: a vehicle's real
longitudinal acceleration averages to zero over a minute, because nothing
accelerates forever, while tilt and bias errors do not. So the slow mean *is*
the error. Measured: 75.6% -> 12.7% mean drift, the single largest improvement
of any constraint in the table — and it works without any speed reference at
all, which is what the walking case and the many handsets with no Doppler need.

Also: derived speed is now only accepted when the displacement over the fix
interval clearly exceeds the fix accuracy (3x), since a speed derived from
position noise is worse than admitting ignorance.

### Deep test pass — three bugs found

1. **The recovery slew could teleport.** It spread any drift over a fixed 2 s
   and a *gross* drift over 1 s — faster — on the reasoning that leaving the
   marker wrong for longer was worse. Backwards: a 367 m correction over 10 s
   moved the marker **22 m between consecutive samples**, over 1000 m/s. The
   slew is now bounded by RATE (60 m/s peak, accounting for easeInOutCubic
   reaching 3x its mean slope at the midpoint), and a drift too large to cover
   inside the window triggers an explicit, logged `POSITION_RESET` instead of
   a smooth correction that is really a jump in disguise. Measured across the
   24 scenarios: zero resets, every recovery slides.
2. **The attitude filter still leaked 3.15 deg** of tilt through ten seconds of
   acceleration — 0.54 m/s^2 of phantom braking. The accelerometer correction
   is now gated on a *smoothed* specific-force magnitude, so road vibration
   averages out but sustained acceleration suppresses the correction and lets
   the gyro carry the vertical. Down to 1.58 deg. ZARU's gyro bias is now fed
   into the attitude prediction as well, not just the yaw readout.
3. **The filters assumed a 50 Hz sample rate.** Field measurements showed the
   IMU arriving anywhere between 14 and 60 Hz on the same handset, and a 5 Hz
   Butterworth designed for 50 Hz becomes a 1.4 Hz filter at 14 Hz. The engine
   now tracks the observed rate and re-tunes.

**Test suites added:** `attitude.test.ts` (26 — seven mount orientations swept,
complementary-filter behaviour, robustness), `invariants.test.ts` (31 —
determinism, NaN/hostile-input fuzzing, never-teleport across eight configs,
long-outage behaviour, degenerate streams), `session.test.ts` (12),
`useNavigationEngine.test.ts` (14). **260 tests total.**

## NEXT PHASE

**Phase 6D — road graph + road snapping** (the rest of Phase 6)
- `scripts/build-road-graph.mjs` — OSM Overpass bbox → `data/maps/road_graph.json`
- `nav-core/src/mapmatch/` — 100 m grid spatial index, `getNearbyWays()`
- `constraints/roadsnap.ts` — perpendicular projection, candidate scoring with
  a continuity bonus, blended snap strength driven by confidence.
  **Cross-track only — never move along-track**
- Feed the matched way's `maxspeed` into the speed clamp, which already accepts
  it and currently never receives one
- Add its toggle to the CONSTRAINTS tab and a `roadsnap` row to the ablation
