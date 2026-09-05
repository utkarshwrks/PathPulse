# PathPulse — Master Document

**AI-ML based Intelligent Dead Reckoning for Seamless Navigation**
Smart India Hackathon · Problem Statement **SIH26168** · Sponsor **ISRO** · Team **Avinya**

**Build v0.22** · APK 7.41 MB · 1,620 tests · 60,224 lines
**6.9 % mean drift on simulated logs · 41.3 % on real vehicle sensors**

---

> **This is the single source of truth for PathPulse.**
>
> It supersedes and replaces `projectreport.md`, `docs/PROJECT_REPORT.md`,
> `docs/CODE_MAP.md` and `PROJECT_STATUS.md`, all of which were removed when
> this was written — they are still in git history. Everything they contained is
> here, and a great deal that they did not: why each decision was made, what was
> tried instead, what it measured, and why the alternative lost.
>
> **Every number in this document is produced by running the software.** The
> command that regenerates it is named next to it. Nothing here is a
> projection, an estimate, or a figure typed by hand.

---

# Table of contents

**Part I — The problem**
1. [What actually breaks](#1--what-actually-breaks)
2. [Existing solutions, and why none of them solve it](#2--existing-solutions-and-why-none-of-them-solve-it)
3. [Alternative technical approaches we rejected](#3--alternative-technical-approaches-we-rejected)
4. [The thesis](#4--the-thesis)

**Part II — What it does**
5. [Complete feature list](#5--complete-feature-list)
6. [System architecture](#6--system-architecture)
7. [The golden rules](#7--the-golden-rules)
8. [Repository layout](#8--repository-layout)

**Part III — How it works**
9. [Data contracts](#9--data-contracts)
10. [The estimator, subsystem by subsystem](#10--the-estimator-subsystem-by-subsystem)
11. [Offline coverage — roads, not pictures of roads](#11--offline-coverage--roads-not-pictures-of-roads)
12. [Where samples come from](#12--where-samples-come-from)
13. [The machine learning](#13--the-machine-learning)
14. [The Android native layer](#14--the-android-native-layer)
15. [The web application](#15--the-web-application)
16. [The edge engine](#16--the-edge-engine)

**Part IV — How we know it works**
17. [The evaluation harness](#17--the-evaluation-harness)
18. [Data tiers — S, R and F](#18--data-tiers--s-r-and-f)
19. [Results](#19--results)
20. [Tests](#20--tests)
21. [What ships disabled, and why](#21--what-ships-disabled-and-why)
22. [The honesty ledger](#22--the-honesty-ledger)

**Part V — Engineering record**
23. [Every alternative we rejected, and its number](#23--every-alternative-we-rejected-and-its-number)
24. [Bugs worth remembering](#24--bugs-worth-remembering)
25. [Build, deploy and workflows](#25--build-deploy-and-workflows)
26. [Problem-statement compliance](#26--problem-statement-compliance)
27. [Phase history](#27--phase-history)
28. [What remains](#28--what-remains)
29. [Command reference](#29--command-reference)
30. [Hard questions, answered](#30--hard-questions-answered)

---

# PART I — THE PROBLEM

# 1 · What actually breaks

## 1.1 GNSS fails where navigation matters most

Satellite positioning needs line of sight to the sky. It does not have one in:

- **tunnels** — the case everyone names
- **underpasses and flyovers** — seconds at a time, repeatedly, in every city
- **basement and multi-storey car parks** — where a driver most needs to be found
- **urban canyons** — signals arrive after bouncing off glass, so the receiver
  reports a position confidently and it is 40 m wrong
- **dense foliage** — an avenue of trees is enough
- **inside a bag or a pocket** — the phone still has to work

India has roughly **300 million registered vehicles** and no fallback for any of
them. When the signal goes, the map stops being a navigation instrument and
becomes a picture.

## 1.2 What a driver actually experiences

Three distinct failures, and they are not equally bad:

| Failure | What the driver sees | Why it is dangerous |
|---|---|---|
| **The marker freezes** | The dot stops; the app is honest but useless | Missed exits, no lane guidance |
| **The marker drifts** | The dot slides into a field, a building, the wrong flyover level | The user stops believing the app |
| **The marker lies confidently** | The dot follows a road the vehicle is not on | **The worst.** A wrong answer delivered with certainty |

The third is the one this project is built to prevent. A navigation system that
says *"I do not know"* is recoverable. One that says *"you are here"* and is
wrong is not.

## 1.3 The specific hole in the market

The dominant apps do not fail because their engineers are careless. They fail
because of a **structural assumption**: that you told them where you were going.

Remove the route and their fallback disappears. That is the hole PathPulse
occupies.

## 1.4 What the problem statement demands

SIH26168 asks, in its own words, for:

- in-vehicle alignment and calibration
- AI-based speed estimation and vibration filtering
- advanced map matching and kinematic constraints
- GNSS + INS fusion, AI-based
- a seamless GNSS-deficit handler, switching **in milliseconds**
- a real-time navigation interface
- **drift under 10 % of distance travelled**
- 10 Hz update on a smartphone; 200 Hz on an edge device with a FOG-grade IMU
- models trained on the IO-VNBD dataset
- on-device inference, no cloud
- an offline map database
- pothole and vibration rejection
- handling of phone misalignment
- support for **two-wheelers** — "millions of motorcycles and scooters"
- NavIC support

And, critically:

> *"The final deliverable must be a working mobile application **and** an Edge
> deployable software engine."*

**Not "or".** Two deliverables. In this project they are the same estimator,
byte for byte — see §16.

---

# 2 · Existing solutions, and why none of them solve it

This section exists because "why not just use X?" is the first question any
serious reviewer asks. Each answer below is about a **structural** limitation,
not a quality judgement.

## 2.1 Google Maps

**What it does when GNSS drops:** interpolates your position **along the route
it planned for you**, using the last known speed and the shape of the road
ahead.

**Why it works:** most of the time you follow the route. Interpolating along a
known line is cheap, stable and looks perfect.

**Where it breaks — and this is the demo:**

> Take an **unplanned turn inside a tunnel.**

There is now nothing to interpolate along. The system either keeps sliding you
down the road you did not take — confidently wrong, failure mode 3 — or gives
up. Neither is navigation.

**Secondary limitations:**

- **Requires a destination.** No route, no fallback. Half of all driving is not
  navigated to a destination.
- **Requires the network** for most of its function, and its offline mode is a
  reduced-capability mode.
- **It is not a sensor-fusion system**, so it cannot tell you *how* it knows —
  there is no uncertainty on screen, no way to check the claim.

**What we take from it:** the interpolation trick is genuinely good. We do the
same thing with road snapping — but constrained by physics rather than by a
route the user may have abandoned.

## 2.2 Waze

Community-sourced, route-centric, and **more** network-dependent than Google
Maps because its value is live incident data. Offline it is weaker, not
stronger. Same structural gap: no route, no dead reckoning worth the name.

## 2.3 Apple Maps

Uses the same class of technique, with tighter hardware integration on iPhone —
Apple can read the phone's motion coprocessor more cheaply than a third-party
app. But the fallback is still route-shaped, and the platform is closed. Not
available as a solution for 300 million mostly-Android Indian vehicles.

## 2.4 HERE / TomTom / MapmyIndia

Genuinely strong offline map products, and MapmyIndia in particular has the
best Indian road data. Their dead reckoning, where present, is:

- usually **hardware-assisted** — designed for a head unit wired to the
  vehicle's odometer and reverse-gear signal;
- or **licensed as an SDK** with per-device cost;
- and still, in the phone-only case, dependent on a route.

**Why we cannot simply use them:** the problem statement asks for an estimator,
not an integration. And a wired head unit is not what 300 million Indian
vehicles have.

## 2.5 Dedicated GNSS+INS hardware (u-blox, VectorNav, Advanced Navigation)

**These genuinely solve the problem.** A tactical-grade IMU with a coupled GNSS
receiver will hold sub-metre accuracy through a long tunnel.

**Why it is not an answer here:**

| | |
|---|---|
| **Cost** | ₹40,000 to several lakh per unit |
| **Installation** | professional, per vehicle |
| **Scale** | 300 million vehicles × ₹40,000 is not a plan |
| **The PS** | asks for a **smartphone** application as one of two deliverables |

**What we take from it:** the mathematics. Our ESKF is the same formulation, and
our edge engine reads exactly this class of sensor at 200 Hz — see §16. Sensor
grade is a *configuration* of our engine, not a different engine.

## 2.6 Wheel odometry / CAN-bus dead reckoning

The best possible speed source: a wheel encoder does not drift and does not care
about tunnels. This is what factory-fitted navigation uses.

**Why not:** it requires a physical connection to the vehicle — an OBD-II dongle
at minimum, and OBD-II does not expose wheel speed on most Indian vehicles
without manufacturer-specific decoding. It also fails the "works on any phone
in any vehicle" requirement, and there is no CAN bus on a scooter.

**What we take from it:** IO-VNBD's CAN bus is our **ground truth** for training
and for validating the axis conventions of the phone's own sensors (§13, §18).

## 2.7 Visual odometry / camera-based positioning

A camera watching the road can measure motion very well, and in a tunnel it has
lights and lane markings to work with.

**Why not:**

- **Power.** Continuous camera + vision inference is the fastest way to flatten
  a phone battery, and a navigation app must survive a long drive.
- **Mounting.** It requires the phone to face forward, unobstructed. Our whole
  alignment system exists precisely because we cannot assume that.
- **Night, rain, fog, dirty windscreen** — all degrade it exactly when driving
  is hardest.
- **Privacy.** A camera recording the road is a different product with a
  different consent conversation.
- **Tunnels are the worst case for vision:** repetitive walls, sodium lighting,
  no texture. The place we most need it is where it is weakest.

## 2.8 WiFi / BLE fingerprinting

Excellent indoors, in buildings that have been surveyed. Meaningless in a road
tunnel, on a highway, or anywhere nobody has walked a survey rig. Also needs the
radio on, which conflicts with the offline promise.

## 2.9 5G positioning / UWB

Genuinely promising and genuinely years away at Indian road scale. Requires
dense infrastructure precisely where tunnels are not.

## 2.10 Cloud-based sensor fusion

Ship the sensor stream to a server, run a heavy filter there, send back a
position.

**Why not, in one line:** the failure mode is *no signal*. A solution that needs
the network to survive losing the network is not a solution.

Also: latency, cost per user, and the privacy of a continuous location stream.

## 2.11 Map matching alone

Snap the last known position to the road network and slide it along at the last
known speed.

**Why not:** it is a guess with no physics behind it, and at the first junction
it has no way to choose. It also cannot detect that it is wrong. We *use* map
matching — as the **last** constraint, applied to an estimate that physics
already produced, and deliberately not fed back into that estimate (§10.9).

## 2.12 Summary

| Approach | Solves tunnels? | Needs route? | Needs network? | Needs hardware? | Cost/vehicle |
|---|---|---|---|---|---|
| Google Maps | Partly | **Yes** | Mostly | No | Free |
| Waze | Partly | **Yes** | **Yes** | No | Free |
| HERE / TomTom SDK | Partly | Often | No | Often | Licence |
| GNSS+INS hardware | **Yes** | No | No | **Yes** | ₹40k–₹5L |
| Wheel odometry | **Yes** | No | No | **Yes** | Wiring |
| Camera / VO | Partly | No | No | Mount + power | Free |
| WiFi/BLE | No | No | **Yes** | Survey | — |
| Cloud fusion | No | No | **Yes** | No | Per user |
| Map matching alone | No | No | No | No | Free |
| **PathPulse** | **Yes** | **No** | **No** | **No** | **Free** |


---

# 3 · Alternative technical approaches we rejected

§2 covered other *products*. This covers other *designs we could have built*. Each
was considered seriously; several were implemented and measured before being
rejected.

## 3.1 A tightly-coupled filter (fuse raw pseudoranges)

**The idea:** instead of consuming the receiver's position fix, consume raw
satellite pseudoranges and fuse them in the same filter. This lets you use two
satellites when four are not visible — the standard "deep coupling" win.

**Why rejected:** Android's `GnssMeasurement` API exposes raw measurements only
on some devices, inconsistently, and the ionospheric and clock modelling needed
to make them useful is a project of its own. The gain applies at the *edge* of
coverage; our problem is *zero* coverage. In a tunnel there are no pseudoranges
to be clever with.

**Kept for later:** listed in §28.

## 3.2 Deep learning end-to-end (sensors in, position out)

**The idea:** train a network to map an IMU window directly onto displacement —
the IONet / RoNIN family of work.

**Why rejected:**

- **It cannot be audited.** When it is wrong, there is no state to inspect and
  no constraint that failed. For a navigation system whose worst failure is
  confident wrongness, that is disqualifying.
- **It does not generalise across mounting.** RoNIN-class results assume a
  pedestrian phone. A phone in a bike jacket, a car cupholder, a dashboard mount
  and a pocket are four different regressions.
- **It has no uncertainty.** The ESKF gives us a covariance; we display it as
  the confidence ring. A regressor gives a point.
- **The PS asks for "AI-based fusion"**, not "AI instead of fusion".

**What we did instead:** ML at the **edges** of the pipeline where it is
supervised by physics — speed estimation (M1), context classification (M2),
sensor-quality gating (M4) — with the estimator itself remaining a filter whose
every state has a physical meaning. See §13.

## 3.3 Unscented Kalman filter (UKF)

**The idea:** replace the ESKF with a sigma-point filter, avoiding the Jacobians.

**Why rejected:** the UKF's advantage appears when the process model is strongly
non-linear over one step. Ours is not: at 100 Hz the attitude error over a step
is small, which is precisely the regime the *error-state* formulation was
designed for. The UKF costs 2n+1 = 31 propagations per step against one, on a
phone, in a foreground service, for no measured accuracy gain.

## 3.4 A full particle filter as the primary estimator

**The idea:** represent position as a cloud of hypotheses, weight them by how
well they sit on roads. This handles the "which side of the flyover?" question
natively, in a way a Gaussian cannot.

**Why rejected as the primary:** the state is 15-dimensional. Particle filters
degenerate in high dimensions unless you use a Rao-Blackwellised structure, and
the compute is not free on a phone.

**Why kept as an option:** we implemented it anyway, marginalised onto the
2-D map-matching problem only, with 500 particles. It is genuinely better at
junction ambiguity. It ships **off by default** because it costs battery and the
ESKF plus HMM matching covers the common case. See §21.

## 3.5 Complementary filter / Madgwick / Mahony for attitude

**The idea:** use a lightweight attitude filter instead of putting attitude in
the main state.

**Why rejected:** it decouples attitude error from position error, which is
exactly the coupling that matters. A 1° attitude error becomes a position error
that grows with distance; only a joint covariance lets the GNSS fix that returns
after the tunnel correct the *attitude* as well as the position. Splitting them
throws that away.

## 3.6 Rely on Android's fused location / `SensorManager.TYPE_GAME_ROTATION_VECTOR`

**The idea:** the OS already fuses sensors. Use its output.

**Why rejected:** Android's fused provider *is* the thing that fails in the
tunnel — it is GNSS-primary with WiFi assistance, both of which are gone. The
rotation vector is useful and we do read raw sensors, but the OS gives us no
position dead reckoning to build on. Also, its behaviour differs between
manufacturers in ways we cannot test or control.

## 3.7 Vector tiles (MBTiles / PMTiles) for offline maps

**The idea:** the standard answer for offline maps. Package vector tiles, serve
them locally.

**Why rejected — and this one was measured:**

| | Size for 100 km corridor |
|---|---|
| Raster tiles z0–z16 | **~150 MB** |
| Vector tiles (PMTiles, filtered) | ~25–40 MB |
| **PathPulse road graph (LOD)** | **3.5 MB** |

Vector tiles carry everything: building footprints, land use, park polygons,
labels in every language, POIs. **We need road centrelines and their topology,
and nothing else** — because the map is an *input to the estimator*, not a
picture. A tile format that we would immediately throw 90 % of is the wrong
container.

So we wrote a codec for exactly the thing we need (§11.2): **8.03× smaller than
raw JSON, 2.72× smaller than gzipped JSON**, and it decodes straight into the
structure the matcher indexes — no parse-then-transform step.

**The consequence that makes it worth it:** the road graph is not just data for
drawing. It is what the offline basemap is drawn *from* (§15.4). One artefact
serves the estimator and the display.

## 3.8 Downloading maps by named region ("download Madhya Pradesh")

**The idea:** what every offline map app does.

**Why rejected:** it asks the user a question they cannot answer. *"How much of
Madhya Pradesh?"* — and if they are driving out of it, the answer is wrong. It
also fails the actual requirement, which the user stated plainly: *the map must
just be there, without weight, anywhere in the world.*

**What we did instead:** a **worldwide slippy-map cell grid** with an LOD ring
structure and silent background prefetch, re-anchored as the vehicle moves, with
rolling eviction under a byte budget. The user never chooses a region because
there is no region. See §11.

## 3.9 Bundling a map with the APK

**Why rejected:** it makes the app national-scale-only and enormous, and it goes
stale. We measured the cost of a mistake here: an early build shipped 4.4 MB of
evaluation road graphs by accident, taking the APK from 4.2 MB to 8.65 MB. The
`--eval-only` flag now keeps them out (§24.6).

## 3.10 A server that ships map cells

**The idea:** our own backend, so we control the payload format.

**Why rejected:** it introduces a service to run, pay for and keep alive for the
lifetime of the app, and it makes the project depend on us existing. We fetch
from **Overpass**, an open public endpoint, and cache in IndexedDB. There is no
PathPulse server. There is no PathPulse account. There is nothing to shut down.

## 3.11 React Native / Flutter instead of Capacitor

**Why rejected:** the estimator is TypeScript with **zero runtime dependencies**
(§7.1). It runs unchanged in Node (tests, evaluation), in a browser (the demo)
and in a WebView (the app). A rewrite in Dart would fork the estimator into a
second implementation that has to be kept in step — and the *identical binary
across deliverables* property (§16) is one of the strongest claims this project
has. Capacitor keeps one estimator.

The heavy lifting that genuinely needs the platform — sensors at 100 Hz, GNSS,
the foreground service, the wake lock — is native Java, and is small (§14).

## 3.12 Storing the road graph in SQLite

**Why rejected:** it adds a native plugin, a schema, a migration story and a
second thing that can be corrupt. `IndexedDB` holds opaque binary blobs keyed by
cell id, which is all we need, is available in the WebView with no plugin, and
survives `navigator.storage.persist()`. The codec already did the compression;
a database would only add indirection.

## 3.13 Feeding the map match back into the filter

**The idea:** treat the snapped position as a measurement and update the ESKF
with it. This is what a naive integration does.

**Why rejected — this is one of the most important decisions in the project:**

Doing this creates a feedback loop where the filter becomes *more* confident
about being on the road it was already snapped to. Any snapping error is then
self-reinforcing: the covariance shrinks, so the next snap is trusted more, so
the error is locked in. **This is exactly the "it follows the blue line"
failure the field test showed.**

So map matching is **presentation-layer only**. The estimator's belief is
computed from physics; the snap is applied on top for display, and never returns.
When they disagree, that disagreement survives, and the off-road detector can
see it (§10.10).


---

# 4 · The thesis

Four sentences.

1. **Dead reckoning runs from the moment the app opens, whether or not GNSS is
   healthy.** It is not a fallback that starts when the signal drops — it is
   already running, already aligned, already calibrated. That is what makes the
   handover take **0 ms**.
2. **No route is required.** The estimate comes from physics — accelerometer,
   gyroscope, magnetometer, barometer — plus constraints that encode how
   vehicles actually move. It works on a road you chose thirty seconds ago.
3. **Constraints do most of the work; the map does the least.** Non-holonomic
   motion, zero-velocity detection, speed clamping and vibration rejection are
   what keep drift bounded. Road snapping is applied last, for display, and is
   never fed back.
4. **Nothing leaves the phone, and nothing needs to arrive.** No route, no
   network, no account, no server. The map database downloads itself silently
   and weighs 3.5 MB per 100 km.

## 4.1 Shadow mode, stated precisely

Most "dead reckoning" implementations are **cold-start**: on GNSS loss they
begin integrating from the last fix. The problem is that the IMU biases are
unknown at that instant, the attitude is unknown, and the scale is unknown — so
the first ten seconds of dead reckoning are the worst ten seconds, and they
happen exactly when you need them.

PathPulse runs the estimator **continuously**. While GNSS is healthy every fix
is a measurement update that:

- corrects position and velocity,
- **observes the gyro and accelerometer biases**,
- **observes the mounting rotation** between the phone and the vehicle,
- shrinks the covariance.

By the time the tunnel arrives, the filter is warm. The handover is not a mode
change; it is the absence of a measurement. **`gnssHealthy` goes false and
nothing else in the loop changes.** That is the whole design.

This is measurable: `packages/eval` reports **0 ms handover latency**, and the
reason it is 0 and not "fast" is that there is no code path that runs on
transition.

---

# PART II — WHAT IT DOES

# 5 · Complete feature list

Every item below is implemented and covered by tests. Items that ship disabled
are marked ⊘ and explained in §21.

## 5.1 Estimation

| Feature | What it does |
|---|---|
| **15-state ESKF** | Position, velocity, attitude, gyro bias, accel bias — error-state formulation, Joseph-form covariance update |
| **Shadow-mode DR** | Always running; 0 ms GNSS handover |
| **Complementary fallback** | A lighter estimator, used when the ESKF is disabled or during warm-up |
| **Non-holonomic constraint (NHC)** | Vehicles do not move sideways or vertically relative to their own frame |
| **ZUPT** | Zero-velocity update — when the vehicle is still, velocity is measured as zero |
| **ZARU** | Zero-angular-rate update — a stationary vehicle observes gyro bias directly |
| **Speed clamp** | Bounds estimated speed by physical plausibility for the detected context |
| **Accelerometer high-pass** | Removes the slowly-varying DC term that integrates into runaway speed |
| **Vibration / pothole rejection** | High-frequency energy is measured and used to gate updates rather than integrate |
| **Adaptive process noise** | Q scales with detected motion context and sensor quality |
| **Barometric altimeter** | Vertical channel aiding; distinguishes flyover levels |
| **Magnetometer heading aid** | With disturbance detection, so a car's own steel does not corrupt heading |

## 5.2 Alignment and calibration

| Feature | What it does |
|---|---|
| **In-vehicle alignment** | Estimates the rotation between phone frame and vehicle frame **while driving** — no calibration ritual |
| **Continuous re-alignment** | Handles the phone being picked up, put down, re-mounted mid-drive |
| **Gravity-vector levelling** | Roll and pitch from the accelerometer at rest |
| **Bias observability tracking** | Knows *when* a bias has actually been observed rather than assumed |
| **Mount-mode detection** | Cradle, pocket, bag, loose on seat — each has a different noise profile |

## 5.3 Motion context

| Feature | What it does |
|---|---|
| **Context classifier** | STATIONARY / PEDESTRIAN / VEHICLE, from sensor statistics |
| **GNSS-backed hold** | A halted walker is not reclassified as a vehicle just because cadence stopped (§24.2) |
| **Step detection + cadence** | Pedestrian distance from steps, not from double integration |
| **Two-wheeler handling** | Lean-angle-aware; a motorcycle's roll in a turn is not a mounting change |

## 5.4 Map matching

| Feature | What it does |
|---|---|
| **Newson–Krumm HMM matcher** | Global-optimal path through candidate road segments |
| **Heading gate** | Rejects candidates whose direction disagrees with travel by >60° (§10.9) |
| **One-way rejection** | A candidate requiring reverse travel on a one-way is rejected outright, not penalised |
| **Continuity preference** | Staying on the current way is cheaper than switching |
| **Off-road detection** | Tracks the on/off-road ratio and stops snapping when the vehicle has genuinely left the network |
| **Map-aided particle filter** ⊘ | 500 hypotheses, for junction ambiguity |
| **Presentation-only** | The snap is never fed back into the filter (§3.13) |

## 5.5 Offline coverage

| Feature | What it does |
|---|---|
| **Compact binary graph codec** | `PPG1`, LEB128 varints, zigzag deltas — 8.03× vs raw JSON |
| **Worldwide cell grid** | Slippy-map tiles; works anywhere on Earth, including across the antimeridian |
| **LOD rings** | Full detail within 20 km, majors only out to 100 km |
| **Silent background prefetch** | No dialogue, no region picker, no progress bar demanding attention |
| **Rolling re-anchor** | Re-targets after 20 km of travel, leading the vehicle by 10 km |
| **Byte-budgeted eviction** | 50 MB default cap, least-useful-first |
| **Metered-connection refusal** | Will not prefetch on a metered link |
| **Persistent storage request** | Asks the browser not to evict the cache |
| **Offline basemap** | Roads drawn from the graph, *beneath* the tile layer — a missing tile is a dimmer map, not a blank one |
| **Tile refresh on reconnect** | Only when a tile actually failed (§24.7) |

## 5.6 Application

| Feature | What it does |
|---|---|
| **Real-time map** | MapLibre GL, trail, marker, matched road, confidence ring |
| **Draggable, collapsible HUD** | Snaps to any of four corners; state persisted |
| **Device screen** | Live sensor rates, quality grades, permissions, diagnostics |
| **Replay screen** | Load a `.jsonl` log and watch the estimator run on it |
| **Foreground service** | Keeps sensing alive with the screen off |
| **Monotonic clock** | Elapsed-realtime, immune to wall-clock changes |
| **Installable PWA** | Plus a native APK |
| **No account, no telemetry** | Nothing is sent anywhere |

## 5.7 Edge deployment

| Feature | What it does |
|---|---|
| **Same estimator binary** | `@pathpulse/edge-engine` imports `nav-core` unchanged |
| **200 Hz operation** | Verified by benchmark |
| **Sensor-grade configs** | Phone MEMS / tactical / FOG |
| **Headless CLI** | Runs on a Jetson-class box with no display |

## 5.8 Evaluation

| Feature | What it does |
|---|---|
| **Tiered corpus** | S (simulated) / R (real sensors) / F (field) — never mixed (§18) |
| **Ablation harness** | Turn each constraint off and measure what it was worth |
| **Alignment benchmark** | Mounting-recovery accuracy |
| **Off-road benchmark** | Snapping behaviour off the network |
| **Tier R harness** | Scores on real IO-VNBD vehicle sensors |
| **Core-purity linter** | Fails the build if `nav-core` acquires an import or a dependency |

---

# 6 · System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  SENSORS                                                             │
│  accel 100 Hz · gyro 100 Hz · mag 50 Hz · baro 10 Hz · GNSS 1 Hz     │
│  Android: SensorLoopService.java  ·  Browser: DeviceMotion           │
│  Replay:  data/replay/*.jsonl                                        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  SensorSample  (one contract, §9)
┌────────────────────────────▼─────────────────────────────────────────┐
│  @pathpulse/sensor-sources    delivery, permissions, rate policing   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  @pathpulse/nav-core          ZERO imports · ZERO dependencies       │
│                                                                      │
│   ┌── calibration ──┐  ┌── motion ──┐  ┌── quality ──┐              │
│   │ alignment       │  │ context    │  │ vibration   │              │
│   │ gravity level   │  │ steps      │  │ grading     │              │
│   │ bias tracking   │  │ cadence    │  │ disturbance │              │
│   └────────┬────────┘  └─────┬──────┘  └──────┬──────┘              │
│            └─────────────────┼────────────────┘                     │
│                              ▼                                       │
│                    ┌───────────────────┐                            │
│                    │  ESKF (15 state)  │  ← GNSS when healthy        │
│                    │  Joseph form      │  ← baro, mag                │
│                    └─────────┬─────────┘                            │
│                              ▼                                       │
│              ┌───────── CONSTRAINTS ─────────┐                      │
│              │ NHC · ZUPT · ZARU · clamp     │                      │
│              │ high-pass · adaptive Q        │                      │
│              └───────────────┬───────────────┘                      │
│                              ▼                                       │
│                     NavigationEngine.step()                          │
│                              │                                       │
│                    ┌─────────▼──────────┐                           │
│                    │  map matching      │  presentation only,        │
│                    │  HMM · heading gate│  NEVER fed back (§3.13)    │
│                    └─────────┬──────────┘                           │
└──────────────────────────────┼───────────────────────────────────────┘
                               │  NavState + Diagnostics
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌───────────────┐      ┌──────────────┐      ┌────────────────┐
│  apps/web     │      │ edge-engine  │      │ packages/eval  │
│  map · HUD    │      │ 200 Hz CLI   │      │ tiers S/R/F    │
│  Capacitor    │      │ FOG/tactical │      │ ablation       │
│  APK 7.41 MB  │      │ headless     │      │ 0 ms handover  │
└───────────────┘      └──────────────┘      └────────────────┘
```

## 6.1 The shape that matters

Everything above the dashed line is **one pure function of a sample stream**.
That is what makes the same estimator run in a phone, a Jetson and a test
runner, and it is what makes the results reproducible.

---

# 7 · The golden rules

These are enforced, not aspirational.

## 7.1 `nav-core` is pure

**Zero runtime dependencies. Zero imports outside itself.** No `fs`, no `fetch`,
no `Date.now()`, no `Math.random()` in the estimation path, no DOM, no
Capacitor.

Enforced by `scripts/check-core-purity.mjs`, which runs in `pnpm lint:core-purity`
and fails the build.

**Why it matters:**

- The estimator is **deterministic**: the same log produces the same numbers on
  any machine, any time. That is what makes an ablation result meaningful.
- It runs **anywhere** JavaScript runs — which is what delivers "the app and the
  edge engine are the same estimator".
- It cannot be accidentally coupled to a platform, because the linter will catch
  it at the first import.

## 7.2 Time is passed in, never read

The engine never asks what time it is. Every sample carries `t`, and the engine
uses only that. On Android that `t` comes from `SystemClock.elapsedRealtimeNanos`
— a **monotonic** clock, so an NTP correction or a timezone change mid-drive
cannot make the filter integrate a negative interval.

## 7.3 Generated files are never hand-edited

`docs/benchmarks.md`, `docs/benchmarks-tier-r.md`, `docs/offroad.md`,
`docs/alignment.md` and `docs/edge-benchmarks.md` are written by scripts. Editing
them is silently undone by the next run — which happened once, and is recorded in
§24.5.

## 7.4 Data tiers are never mixed

A number computed on simulated data is never quoted alongside one computed on
real sensors without saying which is which. See §18.

## 7.5 A test asserts a trap, not a line

Test comments in this repository name the specific failure the assertion exists
to catch, and several say explicitly that the trap was hit in practice. See
`packages/eval/test/iovnbd.test.ts` for the clearest example: every check there
corresponds to a bug that actually occurred.


---

# 8 · Repository layout

pnpm workspaces, TypeScript throughout, Vitest for tests.

```
PathPulse/
├── MASTER.md                    ← this document
├── README.md                    ← how to run it
├── package.json                 ← every command in §29
│
├── packages/
│   ├── nav-core/                ★ THE ESTIMATOR — zero deps, 15,261 lines
│   │   └── src/
│   │       ├── types.ts             SensorSample, NavState, Diagnostics
│   │       ├── engine/              NavigationEngine — the top-level step()
│   │       ├── eskf/                ErrorStateKalmanFilter, matrix, quaternion, noise
│   │       ├── deadreckoning/       DeadReckoningEngine — the lighter estimator
│   │       ├── constraints/         nhc · zupt · zaru · speedclamp · roadsnap · forwardBias
│   │       ├── alignment/           autoAlign · gravity · attitude · altimeter
│   │       ├── motion/              context · steps
│   │       ├── mapmatch/            hmm · RoadIndex · RoadTopology · graphCodec · turnDetector
│   │       ├── particle/            ParticleFilter · TurnRelocaliser
│   │       ├── ml/                  speedModel · motionModel · gnssQualityModel · residualModel · cnn
│   │       ├── fusion/              RecoveryBlender
│   │       ├── filters/             lowpass · median · stationarity
│   │       ├── geo/                 enu · distance · angles · constants
│   │       ├── gnss/                constellations (GPS · GLONASS · Galileo · BeiDou · NavIC)
│   │       ├── detect/              spoofing
│   │       ├── confidence/          ellipse
│   │       ├── state/               NavigationStateMachine · SessionStats · drift · events
│   │       ├── twowheeler/          VehicleTypeDetector · lean
│   │       ├── trail/               trail decimation
│   │       └── trip/                export
│   │
│   ├── sensor-sources/          1,555 lines — where samples come from
│   ├── eval/                    2,081 lines — the harness that produces the numbers
│   └── edge-engine/             1,388 lines — the second deliverable
│
├── apps/web/                    12,706 lines — Next.js 14 static export + Capacitor
│   ├── app/                     routes: map · device · replay
│   ├── components/              Map, Hud, OfflineBasemapLayer, TileRefresh, …
│   ├── lib/                     graphCells · graphCellStore · graphPrefetch · rollingCoverage · …
│   ├── hooks/                   useSensorSource, …
│   └── android/                 Capacitor shell + SensorLoopService.java
│
├── ml/                          3,481 lines — Python training, exports to TS
├── scripts/                     1,644 lines — build, publish, convert, lint
├── configs/                     13 ablation configurations
├── data/
│   ├── replay/                  sim_*.jsonl (Tier S) · iovnbd_*.jsonl (Tier R)
│   ├── maps/                    road graphs
│   └── routes/                  synthetic route definitions
└── docs/                        generated benchmarks + the few hand-written docs that remain
```

**Total: 60,224 lines across 98 test files.** `nav-core/src` alone is 71 files.

## 8.1 The 13 configurations

`configs/` holds one JSON per ablation arm. Each turns exactly one thing on or
off so the harness can attribute the difference.

| Config | What it isolates |
|---|---|
| `naive.json` | Pure integration, no constraints — the control |
| `filtered.json` | Filtering only |
| `highpass.json` | + accelerometer high-pass |
| `nhc.json` | + non-holonomic constraint |
| `zupt.json` | + zero-velocity update |
| `zaru.json` | + zero-angular-rate update |
| `speedclamp.json` | + speed clamp |
| `eskf.json` | The ESKF instead of the complementary estimator |
| `hmm.json` | + HMM map matching |
| `particle.json` | + map-aided particle filter |
| `full.json` | Everything that ships enabled |
| `full_ml.json` | + the ML models |
| `full_forwardbias.json` | + forward-bias compensation |

---

# 9 · Data contracts

Everything in the system speaks these three types, defined in
`packages/nav-core/src/types.ts`. They are the only coupling between the
platform layer and the estimator.

## 9.1 `SensorSample` — the input

```ts
interface SensorSample {
  t: number;                    // ms, MONOTONIC. Never wall-clock.
  imu?: {
    ax: number; ay: number; az: number;   // m/s², SPECIFIC FORCE (gravity included)
    gx: number; gy: number; gz: number;   // rad/s
  };
  mag?: { mx: number; my: number; mz: number };   // µT
  baro?: { pressureHpa: number };
  gnss?: {
    lat: number; lon: number;
    accuracyM?: number;
    speedMps?: number;
    headingDeg?: number;        // compass bearing, CLOCKWISE positive
    altM?: number;
    satellites?: number;
  };
}
```

**Three conventions that have each caused a real bug:**

1. **Specific force, gravity included.** A log with gravity already removed reads
   to the filter as permanent free-fall. `iovnbd.test.ts` asserts the median
   accelerometer magnitude is between 9.4 and 10.4 m/s² for exactly this reason.
2. **rad/s, not deg/s.** A car's yaw rate peaks near 0.5 rad/s; the same turn in
   deg/s reads as 30. The test asserts nothing exceeds 6.
3. **Heading is a compass bearing, clockwise positive.** Vehicle CAN buses follow
   ISO 8855, which is counter-clockwise positive. Mixing them inverts every
   turn while leaving every magnitude correct — see §24.3, the most instructive
   bug in the project.

**And one about rate:** a GNSS fix is attached to **one** sample, not repeated on
every sample in that second. Repeating it tells the engine it has a 10 Hz
receiver, and every adaptive-timeout and Doppler-hold decision downstream is then
computed from a fiction. Both `SensorLoopService.java` and the IO-VNBD converter
enforce this, and the test asserts fixes are fewer than one in ten samples.

## 9.2 `NavState` — the output

Position, velocity, attitude, speed, heading, and the covariance-derived
confidence ellipse. This is what the map draws.

## 9.3 `Diagnostics` — how it knows

The second output, and the reason the app can be trusted. It carries, among
others:

- `gnssHealthy`, `gnssSpeedAgeMs`, `observedFixMs`
- `context` and the human-readable `contextReason`
- `forwardAccelMps2` and `forwardAccelDcMps2` — the raw and de-biased forward
  acceleration, which is how the speed-runaway bug was found (§24.1)
- `offRoad` — whether the vehicle has left the road network
- per-constraint activation flags
- sensor quality grades

The Device screen renders these live. **A navigation system that can be
interrogated is a different kind of object from one that cannot.**

---

# 10 · The estimator, subsystem by subsystem

## 10.1 `NavigationEngine.step(sample)`

The top-level entry point. One sample in, one `NavState` + `Diagnostics` out.
Ordering matters and is fixed:

1. **Reject non-advancing time.** A sample whose `t` does not exceed the previous
   is dropped. (IO-VNBD's S3b log has genuine repeats: 6,813 raw rows collapse to
   2,043 usable samples.)
2. **Sensor quality grading** — what can be trusted this step.
3. **Alignment update** — refine the phone→vehicle rotation.
4. **Context classification** — STATIONARY / PEDESTRIAN / VEHICLE.
5. **Propagate** the ESKF with the IMU.
6. **Apply constraints** as measurement updates: NHC, ZUPT, ZARU, speed clamp.
7. **Apply aiding measurements**: GNSS if healthy, baro, mag.
8. **Map match** — presentation only.
9. **Emit** state and diagnostics.

## 10.2 The ESKF

`packages/nav-core/src/eskf/ErrorStateKalmanFilter.ts`. Fifteen states:

| States | Meaning |
|---|---|
| 0–2 | Position error (ENU, metres) |
| 3–5 | Velocity error (ENU, m/s) |
| 6–8 | Attitude error (small-angle, rad) |
| 9–11 | Gyro bias (rad/s) |
| 12–14 | Accelerometer bias (m/s²) |

**Why error-state rather than direct:** the nominal state carries the large,
non-linear quantities (a full quaternion, a global position); the filter carries
only the small *error* about it. The error dynamics are near-linear, so a first-
order Jacobian is accurate — which is the reason §3.3 rejects the UKF. The
attitude error being a 3-vector rather than a 4-vector quaternion also removes
the normalisation constraint that makes a direct EKF awkward.

**Joseph form** for the covariance update:

```
P⁺ = (I − KH) P⁻ (I − KH)ᵀ + K R Kᵀ
```

The short form `P⁺ = (I − KH)P⁻` is algebraically equal and numerically worse:
it loses symmetry and positive-definiteness after enough updates in float, and a
filter with a non-PSD covariance produces a Kalman gain that makes things worse
with total confidence. Joseph costs more multiplications and is worth every one.

Reference: Joan Solà, *Quaternion kinematics for the error-state Kalman filter*.

**Every matrix operation is hand-written** in `eskf/matrix.ts` — see §7.1.

## 10.3 Non-holonomic constraint (NHC)

**The physics:** a wheeled vehicle moving forward does not slide sideways and
does not levitate. In the *vehicle* frame, lateral and vertical velocity are
approximately zero.

**As a filter update:** two pseudo-measurements of zero, applied every step while
the context is VEHICLE.

**Why it is powerful:** it is free information, available at 100 Hz, with no
sensor. It is the single largest contributor to bounded drift after the ESKF
itself, because it collapses two of the three velocity error directions
continuously.

**Why it needs the alignment:** the constraint is stated in the *vehicle* frame,
so it is only correct if we know how the phone is rotated relative to the
vehicle. A wrong alignment turns NHC from the best constraint into an active
source of error. This is why §10.6 runs continuously.

**Why it is gated:** it is false when the vehicle skids, and false for a
two-wheeler leaning hard. The lean detector (§10.13) relaxes it.

## 10.4 ZUPT — zero-velocity update

When the vehicle is detected stationary, velocity is **measured** as exactly
zero, with small noise.

Without it, sensor noise integrates and a parked vehicle drifts across the map.
This was one of the field-test failures: *"it does not stop anywhere"*. The fix
turned out to be in the context classifier rather than in ZUPT itself (§24.2).

Stationarity comes from `filters/stationarity.ts`, which looks at accelerometer
variance, gyro magnitude and their persistence — not from a single threshold,
because a smooth highway cruise and a stopped engine have similar instantaneous
variance and completely different persistence.

## 10.5 ZARU — zero-angular-rate update

When stationary, the *true* angular rate is zero, so **whatever the gyro reports
is bias**. This makes gyro bias directly observable without GNSS, which is why
sitting at a red light before a tunnel measurably improves the drive through it.

This is the cheapest calibration in the system and it happens automatically at
every traffic light in India.

## 10.6 In-vehicle alignment

`alignment/autoAlign.ts`. The problem: the phone is at an unknown rotation
relative to the vehicle, and the user will not perform a calibration ritual.

**How it is solved without one:**

- **Gravity gives roll and pitch.** At rest, the accelerometer points at the
  centre of the Earth. Two of three angles, free.
- **Acceleration gives yaw.** Under forward acceleration or braking, the specific
  force has a large horizontal component *along the vehicle's forward axis*. The
  direction of that component in the phone frame is the vehicle's forward
  direction in the phone frame.
- **Turning gives yaw too.** During a turn the gyro's rotation axis is the
  vehicle's *up* axis; the centripetal acceleration is along its *lateral* axis.
- **GNSS closes the loop.** While the signal is good, the discrepancy between the
  heading GNSS reports and the heading the aligned IMU predicts is an error
  signal that refines the rotation.

It runs continuously, so the phone being picked up mid-drive is recovered from
rather than fatal. `packages/eval`'s alignment benchmark measures how fast and
how accurately, and writes `docs/alignment.md`.

## 10.7 Speed estimation, the high-pass, and the runaway

Speed is the hardest quantity in the system, because it is the **first integral**
of an accelerometer that has a bias.

A constant accelerometer bias of 0.01 m/s² — which is a *good* phone MEMS part —
integrates to 0.6 m/s after one minute and 3.6 m/s after six. That is the speed
runaway, and it is not a bug in the code; it is what the physics says will happen
unless something stops it.

**Four things stop it:**

1. **Bias estimation in the ESKF** — states 12–14. While GNSS is healthy, the
   bias is observable, and by the time the tunnel arrives it is largely known.
2. **The accelerometer high-pass.** The slowly-varying DC component of forward
   acceleration is removed before integration. A real vehicle does not accelerate
   in one direction for minutes; a biased sensor claims to.
3. **The speed clamp.** `constraints/speedclamp.ts` bounds the estimate by what
   the detected context can physically do.
4. **GNSS speed hold.** When the fix is stale but recent, the last *Doppler*
   speed — which is far more accurate than differencing positions — is held as a
   measurement.

Diagnostics reports both `forwardAccelMps2` and `forwardAccelDcMps2` so the DC
term is visible on the Device screen. That is how the residual runaway in §24.1
was located.

## 10.8 Motion context

`motion/context.ts` classifies STATIONARY / PEDESTRIAN / VEHICLE, because almost
every other decision depends on it: NHC only applies to vehicles, the speed clamp
differs by an order of magnitude, step detection only applies to pedestrians,
and process noise scales with it.

The classifier uses accelerometer variance, gyro energy, step cadence, and
GNSS-reported speed when available — plus a **hold rule** that is worth stating,
because getting it wrong caused a visible field failure:

> If speed is below the pedestrian threshold and there is a GNSS-backed prior,
> **keep the prior**. A walker who stops has no cadence, and "no cadence" is not
> evidence of being in a vehicle.

Before this rule, standing still reclassified the user as a vehicle, which
enabled NHC and the vehicle speed clamp on a stationary pedestrian and produced
drift. The diagnostics string reports it in plain words:
`held PEDESTRIAN — no cadence at 0.3 m/s`.

## 10.9 Map matching

`mapmatch/hmm.ts` implements Newson & Krumm's hidden Markov model matcher:
candidate road segments are states, emission probability comes from perpendicular
distance to the segment, transition probability from how plausible the road-
network path between two candidates is compared with the straight-line distance.
Viterbi gives the globally best sequence rather than a greedy nearest-road pick.

**On top of the standard formulation we added three gates**, each of which was
worth a measurable amount:

```ts
maxHeadingMismatchDeg: 60,        // reject candidates pointing the wrong way
continuityMaxMismatchDeg: 40,     // tighter when staying on the current way
rejectOnewayReverse: true,        // a one-way traversed backwards is not a candidate
```

The heading gate alone took mean drift from **9.2 % to 6.9 %**.

**The one-way finding is the interesting one.** We first tried a 150 m penalty on
reverse-one-way candidates, then a last-resort fallback that allowed them only
when nothing else fitted. **Both measured 9.1 % — identical to doing nothing at
all.** Only outright rejection worked. A penalty large enough to matter is
indistinguishable from rejection; a penalty small enough to be a penalty changes
nothing. There was no middle.

## 10.10 Off-road detection

The field test surfaced a failure that no amount of better snapping fixes: the
vehicle left the road network — a yard, a service lane, a track — and the matcher
kept confidently snapping it to the nearest road.

`NavigationEngine` now tracks `offRoadFixes` and `onRoadFixes` and exposes an
`offRoad` flag. When the ratio says the vehicle has genuinely left the network,
**snapping stops** and the raw estimate is displayed.

This is the direct implementation of §1.2's rule: not knowing is acceptable;
being confidently wrong is not.

Measured by `pnpm eval:offroad` → `docs/offroad.md`.

## 10.11 The map-aided particle filter ⊘

`particle/ParticleFilter.ts`. 500 hypotheses, each a position on the road
network, resampled by agreement with the estimate. It answers questions a
Gaussian cannot: *which level of the flyover*, *which of two roads that diverge
at 5°*.

Ships **disabled**. Reason in §21.

`particle/TurnRelocaliser.ts` is the related idea: a distinctive sequence of turns
is nearly a fingerprint of a location in the road network, so a vehicle that has
drifted can be re-located by matching its recent turn sequence against the graph.

## 10.12 GNSS handling

`gnss/constellations.ts` recognises GPS, GLONASS, Galileo, BeiDou and **NavIC**
(IRNSS) — the last being an explicit requirement of an ISRO-sponsored problem
statement, and one that matters practically because NavIC's geostationary and
inclined-geosynchronous satellites sit high over India, which is a different and
often better visibility geometry in an urban canyon.

`detect/spoofing.ts` flags fixes that are physically impossible given the
filter's own state — a jump no vehicle could make, a speed that contradicts the
IMU. A spoofed or reflected fix that the filter accepts is worse than no fix.

`fusion/RecoveryBlender.ts` handles the *other* transition. When GNSS returns
after a long outage, the true position and the dead-reckoned position differ.
Snapping instantly is visually violent and can be wrong if the first returning
fix is a multipath artefact. The blender eases in over a short window, weighted
by the returning fix's accuracy.

## 10.13 Two-wheeler support

The PS names motorcycles and scooters explicitly, and they break assumptions cars
do not:

- **A two-wheeler leans.** In a turn it rolls 20–40°, which a naive alignment
  reads as the phone having moved. `twowheeler/lean.ts` recognises lean as lean —
  correlated with yaw rate and lateral acceleration — and does not re-align.
- **NHC is weaker.** A leaning bike genuinely has lateral acceleration in its own
  frame. The constraint is relaxed during detected lean.
- **Vibration is far higher.** A single-cylinder engine at idle produces a strong
  periodic signal directly in the accelerometer band. This is what the vibration
  grading in `quality` is for.

`twowheeler/VehicleTypeDetector.ts` distinguishes the vehicle class from the
signature of its motion.

---

# 11 · Offline coverage — roads, not pictures of roads

This is the part of the project that started as a bug report and became the
strongest piece of engineering in it.

## 11.1 The requirement, in the user's words

> *"Even 100 km of map doesn't take any weight… after it passes 20 to 40 km then
> again a hundred kilometres… the map should be precise… and it must work for
> every person using this app,"* — that is, **worldwide, not one city** — *"and
> it has to be free."*

And the constraint that ruled out the obvious answer:

> *"I understand it makes the app so heavy, but 150 MB is so, so big."*

## 11.2 The codec

`packages/nav-core/src/mapmatch/graphCodec.ts` — `encodeGraph` / `decodeGraph`.

| Element | Choice | Why |
|---|---|---|
| Magic | `PPG1` | Version the format from day one |
| Integers | **LEB128 varints** | Most values are small; fixed-width wastes the high bytes |
| Coordinates | **zigzag delta** | Consecutive nodes on a way are metres apart, so deltas are tiny; zigzag keeps negatives small |
| Scale | `COORD_SCALE = 1e5` | **0.79 m** precision — finer than lane width, coarser than pointless |
| Flags | bitfield, incl. `F_RENDER_ONLY` | A way that should be drawn but never matched against |

**Measured: 8.03× smaller than raw JSON, 2.72× smaller than gzipped JSON.**

Beating gzip by 2.72× matters because gzip is what any generic solution would
give you for free. The win comes from the delta+varint structure being
*semantically* right for road geometry, which no general-purpose compressor can
discover.

`F_RENDER_ONLY` deserves a note: some ways should appear on the basemap but must
never be map-match candidates — a footpath, a driveway. `RoadWay.renderOnly`
filters them out at index construction in `RoadIndex.ts`, so the matcher never
sees them and the renderer always does. One artefact, two consumers, no
duplication.

## 11.3 The cell grid

`apps/web/lib/graphCells.ts`. Coverage is addressed by **slippy-map tile
coordinates** — the same `z/x/y` scheme every web map uses.

**Why that and not a named region:** it is defined everywhere on Earth, it needs
no gazetteer, it needs no user decision, and it is trivially computable from a
latitude and longitude. Antimeridian wrap is handled explicitly.

## 11.4 Level of detail — where the 3.5 MB comes from

```ts
LOD_ZOOM = { full: 13, major: 9 }
INNER_RADIUS_M = 20_000    // full detail: every road
OUTER_RADIUS_M = 100_000   // majors only: motorway, trunk, primary, secondary
```

The reasoning is a measurement:

> **Residential and service roads are 73.2 % of all nodes in a typical extract.
> Major roads are 4.8 %.**

Ninety kilometres away, residential streets are worthless — you cannot be on one,
and by the time you could be, the inner ring has moved with you. Dropping them
outside 20 km removes almost three-quarters of the data and loses nothing that
can be used.

**Result: 100 km of coverage in ~3.5 MB.** Against ~150 MB for raster tiles, that
is a **43× reduction**, achieved by storing the thing we actually need.

## 11.5 Prefetch

`apps/web/lib/graphPrefetch.ts`:

- `planCells()` decides which cells the LOD rings require and which are missing.
- The `GraphPrefetcher` fetches them **strictly serially** — one at a time. A
  parallel fetch would be faster and would get us rate-limited by Overpass, which
  is a free public service we are guests on.
- **Exponential backoff** on failure.
- **Refuses to run on a metered connection.** Downloading a map database on
  someone's mobile data without asking is exactly the behaviour this project
  exists to avoid.
- **Silent.** No dialogue, no region picker. The map is simply already there.

Overpass has two properties worth recording, both learned the hard way:

- It caps **response size**, not area. So the query must be shaped to keep
  responses small, which the LOD rings do naturally.
- **It requires a `User-Agent`.** Node's `fetch` sends none, and Overpass returns
  **HTTP 406**. This is not documented anywhere obvious.

Measured: covering 100 km takes **116 Overpass requests, not ~1,200**, because
the LOD structure means most of the area is fetched at zoom 9.

## 11.6 Rolling coverage

`apps/web/lib/rollingCoverage.ts` — the "after 20 to 40 km, again a hundred
kilometres" requirement:

```ts
RETARGET_DISTANCE_M = 20_000       // re-anchor after 20 km of travel
ANCHOR_LEAD_M = 10_000             // anchor 10 km AHEAD, not at the vehicle
MIN_REANCHOR_INTERVAL_MS = 120_000 // never thrash
```

The anchor **leads** the vehicle rather than centring on it, because coverage
behind you is worth nothing and coverage ahead is worth everything.

## 11.7 Storage and eviction

`apps/web/lib/graphCellStore.ts`:

- An injectable `CellBackend`, with `MemoryCellBackend` for tests and
  `IdbCellBackend` for the app. The estimator's purity rule reaches this far:
  storage is an interface, so the logic is testable without IndexedDB.
- `requestPersistentStorage()` calls `navigator.storage.persist()` so the browser
  does not evict the map database when space is short.
- `DEFAULT_MAX_BYTES = 50 MB`, with **least-useful-first eviction** — distance
  from the current anchor, not simple LRU, because a cell you drove through an
  hour ago and are driving back through is more valuable than one you touched
  more recently and left behind.

## 11.8 The basemap that is not tiles

`apps/web/components/OfflineBasemapLayer.tsx` draws the road graph as map
layers **beneath** the raster tiles, inserted at `firstContentLayerId()`.

The effect: online, you see normal map tiles and never notice the layer beneath
them. Offline, tiles are missing and **the roads are still there**, drawn from
the same graph the matcher is using. A missing tile is a dimmer map, not a blank
one.

This is the payoff for §3.7. Because we stored road *topology* rather than
pictures, one artefact serves the estimator, the matcher and the display.

## 11.9 Tile refresh

`apps/web/components/TileRefresh.tsx`. See §24.7 for the bug; the rule is:
re-request tiles on `online` or on returning to the foreground, **but only if a
tile actually failed**, because phones raise `online` on every wifi/cellular
handover and an unconditional refresh would re-download the visible map several
times on an ordinary drive.


---

# 12 · Where samples come from

`packages/sensor-sources` — 1,555 lines whose only job is to produce a
`SensorSample` stream and hand it to `nav-core`. Three implementations behind one
interface.

## 12.1 Android

`apps/web/android/.../SensorLoopService.java`, a **foreground service** so
sensing survives the screen going off — which is the normal case on a drive.

- Accelerometer and gyroscope registered at `SENSOR_DELAY_FASTEST`, throttled to
  100 Hz.
- Magnetometer at 50 Hz, barometer at 10 Hz.
- GNSS from `FusedLocationProvider`, attached to **one** sample per fix (§9.1).
- Timestamps from `SystemClock.elapsedRealtimeNanos` — monotonic (§7.2).
- A partial wake lock, and a persistent notification, because Android requires
  one and because the user should know when something is sensing.

## 12.2 Browser

`DeviceMotionEvent` / `DeviceOrientationEvent` plus `navigator.geolocation`.
Lower and less consistent rates, permission-gated on iOS, but enough to
demonstrate the estimator in a browser with no install.

## 12.3 Replay

Reads a `.jsonl` file, one `SensorSample` per line, and delivers it either at
recorded wall-clock pace or as fast as possible. This is what the eval harness
uses, and it is why every result in this document is reproducible: the estimator
is deterministic (§7.1), so the same log gives the same numbers forever.

The Replay screen in the app uses the same source, so a log can be watched
running in the real UI.

## 12.4 The flaky test, and what it actually was

`packages/sensor-sources` had a test that failed intermittently. The developer
brief written at the time said the cause was "delivery not awaited".

It was not. Two test files were mocking `@capacitor/core` differently and racing
each other through a shared module registry. We tried `vi.resetModules()`,
**measured no improvement, and removed it** rather than leaving a change that did
nothing. The fix is `fileParallelism: false` in
`packages/sensor-sources/vitest.config.ts`. 20 of 20 green since.

The lesson is recorded because it recurred: **the stated cause of a bug is a
hypothesis, and it was wrong three times in this project** (§24).

---

# 13 · The machine learning

The PS asks for AI. §3.2 explains why we did not make the estimator a network.
This section is what we did instead: **four small models, at the edges, each
supervised by physics**, all exported to TypeScript and running on-device with no
runtime.

| Model | Task | Size | Result |
|---|---|---|---|
| **M1** | Speed estimation from an IMU window | **27,041 params** | **MAE 2.942 m/s, R² 0.792, +0.4 % 30 s drift bias** |
| **M2** | Motion-context classification | **9,736 params** | **macro-F1 0.4795** vs 0.0884 baseline |
| **M4** | Sensor-quality / GNSS trust gating | **988 params** | 1,430 training rows |
| CNN | Vibration signature (experimental) | — | in `ml/cnn.ts` |

**M1 is scored on drift, not only on MAE, and that changed the model.** The
engine *integrates* this output, so a zero-mean 3 m/s error largely cancels over
a 30 s outage while a bias does not — it is invented distance, every time. The
weights this replaced scored the same MAE while over-stating distance by
**8.5 %** on every 30 s stretch of a held-out journey, and no metric the project
had could see it. Two changes fixed it: the model is now given the
mount-invariant channels the engine already computes at runtime (previously it
had to *learn* rotation invariance from augmentation), and training stops on
drift rather than on validation loss, because the epoch with the best per-window
score is not the epoch that drifts least. §13.2, `ml/experiments/README.md`.

| | shipped before | now |
|---|---|---|
| MAE | 2.929 m/s | 2.942 m/s |
| stopped-window MAE | 1.570 | **1.413** |
| mean 30 s drift | 21.60 % | **19.48 %** |
| **signed 30 s drift** | **+8.53 %** | **+0.38 %** |

Training lives in `ml/` (3,481 lines of Python); inference lives in
`packages/nav-core/src/ml/` as plain TypeScript with the weights inlined. **There
is no TensorFlow, no ONNX runtime, no inference library in the app.** A model of
27,041 parameters is a few matrix multiplies, and `nav-core`'s purity rule
(§7.1) means it could not have a runtime even if we wanted one.

## 13.1 Why these are small

Because they have to be honest. M1's job is to *aid* the speed estimate, not to
replace the integration — its output enters the filter as a measurement with a
covariance, so when it is wrong the filter can down-weight it. A model that
cannot be down-weighted is a model that has to be right, and none of these is
right enough for that.

**M2's numbers are worth reading carefully.** macro-F1 of 0.4795 is not
impressive in absolute terms; it is **5.4× the baseline**, and it is used as one
input among several to a classifier that also has physics available. Reporting it
as 0.4795 rather than as "AI-powered context detection" is the point.

## 13.2 Trained on IO-VNBD

The PS names the dataset. `ml/data/download.py` fetches it; the models train on
it; and — separately and more importantly — §18 turns it into a **replay corpus**
so the estimator itself can be scored on real vehicle sensors.

---

# 14 · The Android native layer

Deliberately small. Everything that can be TypeScript is TypeScript, because
that is what keeps one estimator across three runtimes (§3.11).

| Piece | Why it must be native |
|---|---|
| `SensorLoopService.java` | 100 Hz sensor access and a foreground service |
| Wake lock | Sensing with the screen off |
| Permissions | Runtime location + activity recognition |
| `elapsedRealtimeNanos` | A monotonic clock the WebView does not expose |

Capacitor bridges these to the TypeScript app. **APK: 7.41 MB.**

---

# 15 · The web application

Next.js 14, **static export** — there is no server. MapLibre GL for the map.

## 15.1 Screens

- **Map** — the live navigation view: trail, marker, matched road, confidence
  ring, offline basemap, HUD.
- **Device** — live sensor rates, quality grades, permission states, and the
  full `Diagnostics` object. This is the screen that makes the system auditable.
- **Replay** — load a `.jsonl` and watch the estimator run.

## 15.2 The HUD

Field report: *the HUD blocks the map.*

`components/Hud.tsx` is now **draggable to any of four corners** (`nearestCorner`
snapping, so it never lands somewhere awkward) and **collapsible**, with the
choice persisted to `localStorage`. Two small features; they were the difference
between a demo that works and a demo the tester was fighting.

## 15.3 Shown position

`lib/shownPosition.ts` separates *what the filter believes* from *what is drawn*.
The snap, the recovery blend and the trail decimation all live on the display
side of that line — which is the code-level expression of §3.13.

## 15.4 Offline basemap and tile refresh

§11.8 and §11.9.

---

# 16 · The edge engine

`packages/edge-engine`, 1,388 lines. **The second deliverable the PS demands.**

The claim it exists to support is precise:

> The mobile application and the edge engine run **the same estimator**. Not a
> port. Not a shared algorithm. `@pathpulse/edge-engine` imports
> `@pathpulse/nav-core` and calls the same `NavigationEngine.step()` the phone
> calls. Only the adapters around it differ.

That is only possible because of §7.1.

## 16.1 Sensor grades

`pnpm edge:bench` → `docs/edge-benchmarks.md`. Each row is 20 s of GNSS aiding
followed by a **60 s total outage at 60 km/h**:

| Grade | Rate | Gyro bias | Drift % | Cross-track | Heading err | Latency | Sustained |
|---|---|---|---|---|---|---|---|
| Phone MEMS | 50 Hz | 206.265 °/hr | 26.4 % | 258.5 m | 3.08° | 0.0117 ms | 82,756 Hz |
| Tactical | 100 Hz | 2.063 °/hr | 20.3 % | 199.4 m | 0.05° | 0.0108 ms | 89,315 Hz |
| Fibre-optic | 200 Hz | 0.001 °/hr | **15.0 %** | **140.6 m** | 0.08° | 0.0116 ms | 83,683 Hz |

**Read the cross-track and heading columns, not the total.** Along-track error
comes from not knowing the speed, and no gyroscope fixes that — unaided it is the
same problem at every grade and it dominates the total. Cross-track error comes
from heading, heading comes from the gyroscope, and that is where three orders of
magnitude of gyro bias show up: **3.08° → 0.05°**. Quoting only the total would
suggest sensor grade barely matters, which is false for the half of the error it
governs.

**The 200 Hz requirement is met with four orders of magnitude of headroom.** Mean
update latency is ~0.011 ms; sustained throughput is ~83,000 Hz. Whether a given
IMU can be *read* at 200 Hz is a property of that IMU, not of this engine.

⚠️ **Every row is simulated.** We do not own a tactical or fibre-optic IMU; those
rows are datasheet-class noise models. They demonstrate that **sensor grade is a
configuration of this engine**, not a measurement of any real hardware. Saying so
is §7.4.

---

# PART IV — HOW WE KNOW IT WORKS

# 17 · The evaluation harness

`packages/eval`, 2,081 lines. Its purpose is to make claims falsifiable.

## 17.1 How a drift number is produced

1. Take a log with recorded GNSS throughout.
2. Choose an outage window.
3. **Withhold GNSS from the estimator** over that window — it still receives IMU,
   mag and baro.
4. At the end of the window, compare the estimate with the recorded GNSS.
5. **Drift % = final error ÷ distance actually travelled**, where distance comes
   from *ground truth*, not from the estimate's own idea of how far it went —
   otherwise a configuration that under-estimates speed would flatter itself
   twice.

## 17.2 What it reports, and why the columns are split

**Along-track and cross-track are separated on purpose.** A single error figure
says how wrong the estimate is; the split says *how* it is wrong, and the two
have different causes and different fixes.

- **Cross-track** error is what puts the marker inside a building. Road geometry
  bounds it, and heading governs it.
- **Along-track** error leaves the marker on the right road at the wrong point.
  It comes from speed error, and road snapping deliberately does nothing about
  it.

**p90 and max matter more than the mean.** A good mean hiding a bad tail is a
system that works until it embarrasses you.

## 17.3 The harnesses

| Command | Produces |
|---|---|
| `pnpm ablation` | `docs/benchmarks.md`, `.csv`, `.json`, `ablation.svg` |
| `pnpm eval:tier-r` | `docs/benchmarks-tier-r.md` |
| `pnpm eval:alignment` | `docs/alignment.md` |
| `pnpm eval:offroad` | `docs/offroad.md` |
| `pnpm edge:bench` | `docs/edge-benchmarks.md` |

All generated. None hand-edited (§7.3).

---

# 18 · Data tiers — S, R and F

This is the most important honesty mechanism in the project.

| Tier | Files | What it is | What a number from it means |
|---|---|---|---|
| **S** | `sim_*.jsonl` | Simulated sensors from a physics model | The estimator behaves correctly **against a model** |
| **R** | `iovnbd_*.jsonl` | **Real** smartphone IMU in a **real** car on **real** roads, from the public IO-VNBD dataset | The estimator works **on real sensors** |
| **F** | `drive_*.jsonl` | Our own device, our own drive | The product works. **Does not exist yet.** |

`packages/eval/src/paths.ts` implements `tierOf()` and `listLogs(tier = 'S')`, so
a tier cannot be mixed into another by accident. **Rule §7.4: never average a
Tier S row with a Tier R row.**

## 18.1 Why Tier R exists

We could not do a field drive on demand. IO-VNBD gave us real vehicle sensors
with the vehicle's **own CAN bus** as an independent cross-check — better ground
truth than a phone drive would have produced.

`scripts/iovnbd-to-replay.mjs` (`pnpm data:iovnbd`) converts the dataset's CSVs
into replay logs. `packages/eval/src/tierR.ts` scores on them.

## 18.2 The converter is the most dangerous code in the repository

A replay log is **data, not code**, so nothing else in the suite would notice if
the converter silently changed. And its failures are not crashes — a permuted
gyro axis, an inverted sign, a speed column read in the wrong unit each yield a
log that parses perfectly, replays perfectly, and **describes a drive that never
happened**. Which then becomes a published number.

So `packages/eval/test/iovnbd.test.ts` asserts, and every one of these
corresponds to a trap that was actually hit:

- strictly increasing timestamps (S3b: 6,813 raw rows → 2,043 samples)
- native 10 Hz, **not upsampled** — there is no information above 5 Hz in the
  recording, so interpolated samples would be invented data the engine would
  faithfully integrate
- specific force in m/s² **with gravity included** (median 9.4–10.4)
- angular rate in rad/s, not deg/s (peak < 6)
- **one fix per second, not one per sample** (fixes < n/10)
- no fabricated barometer — IO-VNBD has none
- plausible speeds — see §24.4
- **and the one that caught an inverted gyro** — §24.3

---

# 19 · Results

## 19.1 Tier S — the ablation (`pnpm ablation`)

12 runs per configuration: 4 logs × 3 outage windows.

| Configuration | Mean % | Median % | p90 % | Max % | RMSE m | Along m | Cross m | CEP95 m |
|---|---|---|---|---|---|---|---|---|
| naive | **59.5** | 57.9 | 80.9 | 81.1 | 348.3 | 297.5 | 173.7 | 600.4 |
| filtered | **59.3** | 57.9 | 80.9 | 81.0 | 347.2 | 295.1 | 175.2 | 598.1 |
| zaru | **57.7** | 50.5 | 81.7 | 81.9 | 346.1 | 299.8 | 165.3 | 597.2 |
| zupt | **57.5** | 52.3 | 76.5 | 77.3 | 342.2 | 300.4 | 156.5 | 590.6 |
| nhc | **33.5** | 34.7 | 52.6 | 57.5 | 170.3 | 146.5 | 71.3 | 317.6 |
| speedclamp | **30.2** | 34.7 | 52.6 | 57.5 | 152.6 | 128.4 | 69.9 | 265.3 |
| highpass | **14.6** | 16.6 | 25.9 | 27.5 | 92.0 | 71.7 | 49.7 | 150.1 |
| eskf | **8.5** | 8.1 | 16.7 | 20.5 | 75.6 | 62.1 | 36.4 | 129.7 |
| hmm | **10.5** | 7.0 | 25.1 | 30.5 | 73.4 | 59.8 | 39.5 | 126.2 |
| particle | **11.5** | 8.7 | 22.8 | 28.1 | 89.0 | 84.1 | **21.8** | 175.8 |
| full_forwardbias | **10.8** | 11.0 | 21.6 | 26.8 | 82.0 | 71.6 | 33.5 | 146.7 |
| **full** | **6.9** | **4.4** | 22.6 | 28.2 | **67.0** | **57.3** | 30.4 | **110.2** |

**59.5 % → 6.9 %.** The PS asks for under 10 %.

Behaviour: **0 ms handover** on every configuration that has constraints,
**50 Hz** update, **18 ZUPTs**, **99.4 % road-snap**, **0 resets** for `full`.

⚠️ **Tier S. Every log here is simulated.** These numbers measure the estimator
against a physics model, not against a road, and they flatter it — the same
configuration measures **41.3 % on real vehicle sensors**.

### What the table tells you

- **The high-pass is the largest single win** — 30.2 % → 14.6 %. Real
  longitudinal acceleration averages to zero over a minute; tilt error does not.
- **NHC is the second** — 57.5 % → 33.5 %. Free information, no sensor.
- **ZUPT and ZARU look small here and are not.** They contribute ~2 % on a
  simulated log with few stops; in Indian traffic they fire constantly.
- **`particle` has the best cross-track of any row (21.8 m)** and a worse mean.
  That is exactly what a map-aided filter should do: it puts you on the right
  road and is less certain where along it.
- **`full_forwardbias` is a kept negative result.** The GNSS-Doppler forward-bias
  estimator measurably *worsens* drift now that the high-pass exists — 6.9 % →
  10.8 %. It is reported rather than deleted, because a table with no failures in
  it is not a measurement, it is a brochure.

## 19.2 Tier R — real vehicle sensors (`pnpm eval:tier-r`)

Config `full`, 10 outage windows of 60 s per log.

| log | n | mean % | median % | p90 % | best % | worst % |
|---|---|---|---|---|---|---|
| `iovnbd_S1.jsonl` | 10 | 43.3 | 45.9 | 107.2 | 12.9 | 107.2 |
| `iovnbd_S3c.jsonl` | 9 | 39.1 | 35.0 | 88.8 | 6.9 | 88.8 |
| **OVERALL** | **19** | **41.3** | **35.0** | 88.8 | **6.9** | 107.2 |

**41.3 %, and we publish it.** Journey: 111.7 % → 50.1 % (a converter bug of our
own, §24.3) → **41.3 %** (the speed fix, §24.1).

Three things this says:

1. **The error is along-track, not cross-track** — roughly 3–4× larger.
2. **Heading is in good shape.** Integrating the recovered yaw rate across real
   turns reproduces GPS heading change with **slope 1.002 and 0.9° mean error**.
   The estimator knows which way the vehicle is pointing.
3. **The spread is the finding.** 6.9 % in one window, 107.2 % in another. The
   good windows are fast, straight, well-fixed stretches; the bad ones are
   stop-go traffic where fixes are sparse and integration has nothing to anchor
   to. **A single mean hides that entirely**, which is why the table has six
   columns.

What is wrong is **speed once the held Doppler expires**, and that is a named
open problem in §28 rather than a rounded-off footnote.

## 19.3 Off-road accuracy (`pnpm eval:offroad`)

Drift % is blind to something a person notices immediately: a marker 30 m *along*
the road looks perfect; a marker 30 m *to the side* is sitting in somebody's
plot. Same drift, completely different demo. This measures the second thing, with
the road network itself as ground truth, counting only samples drawn while
`DEAD_RECKONING`.

| Config | samples | mean | median | p90 | max | >10 m | >25 m |
|---|---|---|---|---|---|---|---|
| **full** | 37,196 | **0.5 m** | 0.0 m | 0.0 m | 72.9 m | **1.6 %** | 0.5 % |
| highpass (snapping off) | 37,196 | 15.7 m | 5.6 m | 49.9 m | 106.5 m | 35.2 % | 21.9 % |

**0.5 m mean distance from a road. 1.6 % of samples more than 10 m off.** The gap
between the rows is what snapping is worth, measured on the axis it exists to
improve rather than on the one it was previously judged by.

## 19.4 Alignment (`pnpm eval:alignment`)

The same logs, with the raw accelerometer and gyroscope rotated about the device
vertical by a known angle before the engine sees them — which is exactly what
propping the handset at an angle in a holder does. Ground truth is untouched: the
vehicle drove where it drove.

| Mount offset | Alignment OFF, mean % | OFF p90 % | Alignment ON, mean % | ON p90 % |
|---|---|---|---|---|
| 0° | 6.7 | 22.6 | 6.9 | 22.6 |
| 15° | 8.4 | 21.8 | **6.9** | 22.6 |
| 30° | 12.7 | 31.0 | **6.9** | 22.7 |
| 45° | 15.8 | 35.0 | **6.8** | 22.7 |
| 60° | 25.0 | 47.4 | **7.0** | 22.7 |
| **90°** | **38.2** | 59.2 | **7.1** | 22.6 |

**A phone at 90° costs 38.2 % without alignment and 7.1 % with it.** The column
is flat, which is the whole claim: *mounting does not matter*.

0° is the control — there the alignment engine can only cost, and **0.2 % is the
price paid for the rest of the column**.

**Why this is not a row in the ablation table:** every recorded log was made with
the phone square to the vehicle, so on those logs the true mount offset is zero,
an alignment engine has nothing to find, and every degree it estimates is pure
error. The ablation would show a cost and no benefit and invite exactly the wrong
conclusion.

## 19.5 Compression (`graphCodec`)

| Encoding | Ratio |
|---|---|
| vs raw JSON | **8.03×** |
| vs gzipped JSON | **2.72×** |

Coordinate precision **0.79 m**. Coverage: **~3.5 MB per 100 km**, versus ~150 MB
of raster tiles — a **43× reduction**.

## 19.6 Build

| | |
|---|---|
| **APK** | **7.41 MB** |
| Tests | **1,620** passing |
| Source | **60,224 lines**, 98 test files |
| `nav-core` runtime dependencies | **zero** |


---

# 20 · Tests

**1,620 tests across 98 files.** `pnpm test` runs them; `pnpm typecheck` and
`pnpm lint:core-purity` complete the gate.

## 20.1 What a test looks like here

Tests in this repository state the trap they exist to catch. From
`TileRefresh.test.tsx`:

```
it('★ does nothing on `online` when no tile ever failed', () => {
  // Phones raise `online` on every wifi/cellular handover. Refreshing
  // unconditionally would re-download the visible map several times on an
  // ordinary drive, which is exactly what an offline-first app must not do.
```

And from `iovnbd.test.ts`:

```
// ★ THE CHECK THAT CAUGHT AN INVERTED GYRO ★
// The axis mapping was first derived against the car's CAN yaw rate and came
// out backwards, because CAN follows ISO 8855 (positive counter-clockwise) and
// GNSS heading is a compass bearing (positive clockwise). Every magnitude
// agreed and every sign was opposite.
```

A `★` marks an assertion that corresponds to a bug that actually happened. There
are many.

## 20.2 Assert statistically where the phenomenon is statistical

The gyro-integration check does **not** assert per segment, and says why: a
single segment can legitimately disagree, because GPS heading is reported only at
each fix — ~9 s apart in this data — and a stretch containing an S-bend nets out
to a small heading change while the gyro saw two large opposite ones. What cannot
happen, if the axes and signs are right, is **systematic** disagreement across a
hundred turns. So it asserts sign agreement > 90 % and a through-origin slope in
[0.75, 1.25]. Measured: **+0.917 (S1), +1.002 (S3c)**.

This is the difference between a test that catches the bug and a test that is
merely flaky.

## 20.3 The purity linter

`scripts/check-core-purity.mjs` fails the build if `nav-core` acquires any import
outside itself or any dependency in its `package.json`. It is the only reason
§7.1 has stayed true across 60,000 lines.

---

# 21 · What ships disabled, and why

Being able to name what is off is part of being able to trust what is on.

| Feature | State | Why |
|---|---|---|
| **Map-aided particle filter** | ⊘ off | Best cross-track in the table (21.8 m) and a worse mean (11.5 % vs 6.9 %). 500 hypotheses cost battery. It is the right tool for junction ambiguity and the wrong default for a phone on a long drive. |
| **Forward-bias estimator** | ⊘ off | **Measurably worse** since the high-pass exists: 6.9 % → 10.8 %. Kept in the tree and in the table as a recorded negative result. |
| **Turn relocaliser** | ⊘ off | Depends on the particle filter. |
| **CNN vibration model** | ⊘ off | Experimental; not yet earning its size. |

---

# 22 · The honesty ledger

Every claim this project makes, and exactly what backs it.

| Claim | Tier | Backing | Caveat |
|---|---|---|---|
| 6.9 % mean drift | **S** | `pnpm ablation` | Simulated sensors |
| 41.3 % mean drift | **R** | `pnpm eval:tier-r` | Real vehicle sensors, **not our handset** |
| 0.5 m from a road | **S** | `pnpm eval:offroad` | Simulated |
| 0 ms handover | **S** | `pnpm ablation` | Structural — there is no transition code path |
| 7.1 % at 90° mount | **S** | `pnpm eval:alignment` | Simulated rotation of real logs |
| 200 Hz on edge | Sim | `pnpm edge:bench` | ~83,000 Hz sustained; IMU rows are datasheet noise models, not hardware |
| 8.03× compression | Measured | `graphCodec` tests | Real OSM extracts |
| 3.5 MB per 100 km | Measured | Cell planning | Real Overpass responses |
| APK 7.41 MB | Measured | Clean Gradle build | |
| 1,620 tests | Measured | `pnpm test` | |
| Zero deps in `nav-core` | Enforced | `pnpm lint:core-purity` | |

**What we have never measured:** a drive with our own phone, in our own vehicle,
through a real tunnel, against surveyed ground truth. That is Tier F, it does not
exist, and `data/replay/README.md` says so. **Every number above should be read
as an upper bound on the estimator, not an estimate of the product.**

Saying this out loud is not modesty. It is the only thing that makes the numbers
we *do* publish worth anything.

---

# PART V — ENGINEERING RECORD

# 23 · Every alternative we rejected, and its number

The consolidated table. Where a measurement exists, it is given.

| # | Alternative | Verdict | Measured |
|---|---|---|---|
| 3.1 | Tightly-coupled pseudorange fusion | Deferred | — |
| 3.2 | End-to-end deep learning | Rejected | Unauditable, no uncertainty |
| 3.3 | UKF instead of ESKF | Rejected | 31 propagations/step, no accuracy gain |
| 3.4 | Particle filter as primary | Rejected as primary, kept as option | 11.5 % vs 6.9 % mean; **best cross-track 21.8 m** |
| 3.5 | Complementary/Madgwick attitude | Rejected | Decouples attitude from position error |
| 3.6 | Android fused location | Rejected | It is the thing that fails |
| 3.7 | Vector tiles (PMTiles/MBTiles) | Rejected | 25–40 MB vs **3.5 MB** |
| 3.7 | Raster tiles | Rejected | ~150 MB vs **3.5 MB** — **43×** |
| 3.7 | gzipped JSON graph | Rejected | Our codec is **2.72×** smaller |
| 3.8 | Named-region downloads | Rejected | Asks a question the user cannot answer |
| 3.9 | Bundling maps in the APK | Rejected | Measured cost: 4.2 → 8.65 MB |
| 3.10 | Our own map server | Rejected | Creates a dependency on us existing |
| 3.11 | React Native / Flutter | Rejected | Forks the estimator |
| 3.12 | SQLite for the graph | Rejected | Native plugin, schema, migrations, for no gain |
| 3.13 | Feeding the map match back | **Rejected** | **Causes "it follows the blue line"** |
| 10.9 | 150 m penalty on reverse one-way | Rejected | **9.1 % — identical to doing nothing** |
| 10.9 | Reverse one-way as last-resort fallback | Rejected | **9.1 % — identical to doing nothing** |
| 10.9 | Outright rejection of reverse one-way | **Adopted** | **9.2 % → 6.9 %** |
| 12.4 | `vi.resetModules()` for the flaky test | Rejected | **Measured no improvement, removed** |
| 12.4 | `fileParallelism: false` | **Adopted** | 20/20 green |
| 21 | Forward-bias estimator | Disabled | **6.9 % → 10.8 %** — worse |
| 18.2 | Upsampling IO-VNBD 10 Hz → 50 Hz | Rejected | No information above 5 Hz; would invent data |

**Four of these are negative results we kept rather than deleted.** That is
deliberate. A repository that only contains what worked cannot tell you whether
anything was actually tried.

---

# 24 · Bugs worth remembering

Every one of these was found by measurement, and in three of them **the stated
cause was wrong**.

## 24.1 The speed runaway

**Symptom:** on a real drive the estimated speed climbed and kept climbing.

**Cause:** the GNSS speed hold was being applied in the VEHICLE context even when
the receiver was updating quickly. The last Doppler speed was held past the point
where it described the vehicle, and the integration ran away from it.

**Fix**, in `NavigationEngine.ts` — hold the Doppler speed only when the receiver
is genuinely slow:

```ts
const slowReceiver =
  observedFixMs !== null && observedFixMs >= this.config.vehicleSpeedHoldMinIntervalMs;
const gnssSpeedHeld =
  !trusted && gnssHealthy &&
  (context !== 'VEHICLE' || slowReceiver) &&
  this.lastGnssSpeed !== null &&
  gnssSpeedAgeMs <= gnssSpeedHoldMs;
```

with `vehicleSpeedHoldMinIntervalMs: 3_000`.

**Result: Tier R 50.1 % → 41.3 %.** Also: pedestrian `stepSpeed` is now forced to
0 when cadence is zero, because a walker who has stopped is not moving at their
last speed.

**How it was found:** by exposing `forwardAccelMps2` and `forwardAccelDcMps2` in
diagnostics so the DC term was visible on the Device screen.

## 24.2 Stationary drift — the brief was wrong

**Symptom:** *"it does not stop anywhere"* — the marker drifted while parked.

**Stated cause** (in the developer brief written at the time): fallback ordering
in the estimator.

**Actual cause:** `motion/context.ts`. A pedestrian who stops has no cadence; the
classifier read "no cadence" as evidence of a vehicle, reclassified to VEHICLE,
and thereby enabled NHC and the vehicle speed clamp on a stationary person.

**Fix:**

```ts
if (s <= this.config.pedestrianMaxSpeedMps && this.gnssBacked !== null) {
  return { context: this.gnssBacked, reason: `held ${...} — no cadence at ${s.toFixed(1)} m/s` };
}
```

## 24.3 The inverted gyro — the most instructive bug in the project

**Symptom:** Tier R measured **111.7 % drift**. Worse than not trying.

**Cause:** partly our own converter. The IO-VNBD gyro columns are **Euler angle
rates**, not body-frame axes. Correcting that took 111.7 % → 50.1 %.

But underneath it was something better:

> The axis mapping was first derived against the car's **CAN yaw rate**, which
> follows **ISO 8855: positive counter-clockwise**. It was validated against
> **GNSS heading**, which is a **compass bearing: positive clockwise**.
>
> **Every magnitude agreed. Every sign was opposite.**

A sign convention mismatch between two correct sources. No test that checks
magnitude could have caught it. It was caught by re-deriving against **GPS
heading change** and checking the *sign* — slope **1.002**, mean error **0.9°**.

That check is now a permanent test (§20.2), asserted statistically.

## 24.4 `GPS SPEED (Kmh)` is in m/s

The IO-VNBD column header says km/h. It is m/s. Read as km/h, S1's peak speed
came out at **5.2 m/s for a car on a trunk road** — a crawl. Confirmed against
the CAN bus: ratio 3.659 / 3.633.

The test now asserts peak speed is between 8 and 60 m/s, because "anything under
8 m/s peak means the conversion regressed".

## 24.5 We hand-edited a generated file

A Tier R section was added by hand to `docs/benchmarks.md`. The next `pnpm
ablation` silently wiped it.

**Fix:** Tier R gets its own **generated** file, `docs/benchmarks-tier-r.md`,
produced by `packages/eval/src/tierR.ts`. Rule §7.3 dates from here.

## 24.6 The APK was 8.65 MB

Two causes, both measured:

- **4.4 MB of UK evaluation road graphs** were being bundled into the app.
  `scripts/build-road-graph.mjs` gained `--eval-only`.
- **1.16 MB of zip padding** from incremental Gradle builds. A clean build
  removes it.

**4.2 MB → 8.65 MB → 7.41 MB.**

## 24.7 The map loaded "the place that came after"

**Symptom**, verbatim from the field test: *"I switch off the internet, map goes
proper right, and when I turn on the internet it does not load the proper current
place. It load the place that came after."* Also: locking and unlocking the phone
left a blank map.

**Cause:** MapLibre requests a tile once. If that request fails — and offline it
fails immediately — the tile is marked errored and **is never asked for again**.
Reconnecting does not help, because nothing tells the map anything changed.
Nothing in the app was listening for `online` at all.

The second half of the report is the same fault from the other side: the tiles
that *do* eventually appear are the ones requested after the network returned,
which are wherever the camera has since travelled to. The area the vehicle was in
when the connection dropped stays permanently empty — so the map looks like it
"loaded the place that came after".

**Fix:** `TileRefresh.tsx`, and the choice of mechanism was not obvious:

| Mechanism | Verdict |
|---|---|
| `sourceCache.reload()` | Reaches into MapLibre internals; differs between versions, silently absent when it changes |
| **`source.setTiles([...source.tiles])`** | **Adopted.** Public API. Re-declaring the *same* template invalidates the source's tiles and re-requests the ones on screen. Nothing else moves. |
| `map.setStyle(...)` | Works, and flashes the whole map while discarding every layer the app added — the trail, the marker, the matched road, the offline basemap. **Visually it reads as a crash.** |

And there is **no fallback to setStyle**: if `setTiles` is unavailable, the honest
outcome is that tiles stay missing until the user pans, which is exactly what the
offline basemap underneath makes survivable.

`TileRefresh` is the smaller half of the fix. `OfflineBasemapLayer` is the larger.

## 24.8 Seven eval tests broke when Tier R arrived

Adding `iovnbd_*.jsonl` to `data/replay/` broke seven tests that assumed
everything in that directory was simulated. **Fixed by tier filtering** in
`listLogs()`, which is where the tier system in §18 came from — the tests forced
us to make the distinction explicit in code rather than in a convention.

---

# 25 · Build, deploy and workflows

## 25.1 The build

```bash
pnpm install
pnpm test                 # 1,620 tests
pnpm typecheck
pnpm lint:core-purity     # nav-core must stay pure

pnpm build:android        # Next.js static export → Capacitor → Gradle
pnpm publish:apk          # copy to apps/web/public/downloads
pnpm build                # the site
```

`pnpm build:site` does all three of the last steps in order.

`scripts/android-toolchain.mjs` (`pnpm android:doctor`) checks the environment
before a build rather than failing halfway through Gradle.

## 25.2 What ships

- **APK**, 7.41 MB, at `apps/web/public/downloads/`, also copied to the Desktop
  on each build.
- **The site** — a Next.js static export, no server.
- `scripts/strip-apk-from-assets.mjs` prevents the APK being packaged **inside
  itself**, which is exactly the kind of recursion a static-export build will do
  cheerfully if nothing stops it.

## 25.3 Regenerating every number in this document

```bash
pnpm ablation          # docs/benchmarks.md + .csv + .json + ablation.svg
pnpm eval:tier-r       # docs/benchmarks-tier-r.md
pnpm eval:alignment    # docs/alignment.md
pnpm eval:offroad      # docs/offroad.md
pnpm edge:bench        # docs/edge-benchmarks.md
```

---

# 26 · Problem-statement compliance

| SIH26168 requirement | Status | Evidence |
|---|---|---|
| In-vehicle alignment & calibration | ✅ | §10.6; **7.1 % at a 90° mount** vs 38.2 % without |
| AI-based speed estimation | ✅ | M1: 27,041 params, MAE 2.942 m/s, R² 0.792, unbiased over an outage |
| Vibration filtering | ✅ | `filters/`, quality grading, `filtered` ablation row |
| Advanced map matching | ✅ | Newson–Krumm HMM + heading/one-way gates; **99.4 % snap** |
| Kinematic constraints | ✅ | NHC, ZUPT, ZARU, speed clamp — each ablated |
| GNSS+INS fusion, AI-based | ✅ | 15-state ESKF + M1/M2/M4 |
| **Seamless handover, milliseconds** | ✅ | **0 ms** — structural, §4.1 |
| Real-time navigation interface | ✅ | `apps/web`, MapLibre, HUD, Device, Replay |
| **Drift < 10 % of distance** | ✅ **S** / ⚠️ **R** | **6.9 % Tier S**; **41.3 % Tier R** — stated, not hidden |
| 10 Hz on a smartphone | ✅ | **50 Hz** measured |
| 200 Hz on edge + FOG IMU | ✅ | ~83,000 Hz sustained; 15.0 % drift at FOG grade |
| Trained on IO-VNBD | ✅ | `ml/data/download.py`; also the Tier R corpus |
| On-device inference, no cloud | ✅ | Weights inlined in TypeScript; no runtime |
| **Offline map database** | ✅ | §11 — **3.5 MB per 100 km, worldwide** |
| Pothole / vibration rejection | ✅ | §5.1, §10.13 |
| Phone misalignment | ✅ | §10.6, §19.4 |
| **Two-wheeler support** | ✅ | §10.13 — lean detection, relaxed NHC, vibration profile |
| NavIC | ✅ | `gnss/constellations.ts` |
| **Mobile app AND edge engine** | ✅ | **The same estimator binary**, §16 |


---

# 27 · Phase history

94 commits. The project was built in numbered phases, each one a measurable
addition rather than a refactor.

| Phase | What it added |
|---|---|
| **0** | Repo skeleton, geo utilities, ENU round-trip |
| **1** | MapLibre, live GNSS marker, trail |
| **2** | Sensor abstraction + simulation source |
| **3** | Capacitor Android APK + native sensors; device verification |
| **4** | State machine, dead reckoning, recovery |
| **5** | HUD, debug panel, trust features |
| **6D** | Road graph + road snapping |
| **7** | **The eval harness and the ablation table** — the point at which claims became falsifiable |
| **8A** | IO-VNBD speed model (M1) + the position plot ISRO requires |
| **8B** | Run the speed model on the phone, in 150 lines of TypeScript |
| **8** | What it does, what it cannot, and what it costs |
| **9A** | The confidence ellipse, replacing an uninformative halo |
| **9B** | Turn detection, from yaw about the *true* vertical |
| **9C** | **Offline basemap** — so aeroplane mode keeps the map too |
| **9D** | GNSS anomaly detection that warns and never acts |
| **9E** | NavIC breakdown, where the feature is the provenance |
| **9F** | Trip export — the claim a judge can check after we leave |
| **10A–10F** | Demo mode, error boundaries, in-app pitch deck, perf, backups, and **an audit that caught a broken headline** |
| **11** | **Error-state Kalman filter**, and what it cost to measure it |
| **12** | **The phone does not have to be straight any more** (§19.4) |
| **11–12** | Offline road-graph download |
| **13/M2** | Motion-state classifier |
| **13/M3** | AI drift residual — **a documented negative result** |
| **13/M4** | GNSS quality classifier |
| **14** | **Newson–Krumm HMM map matching** |
| **15** | The sensor loop that survives the screen going off |
| **16** | Edge engine, UI system, web deploy, two field fixes |
| **17** | Map-aided particle filter and turn relocalisation |
| **18B** | **Two-wheelers, which lean** |
| **19+** | Field-test fixes: road-snap over-trust, stationary drift, tile refresh, draggable HUD, off-road detection |
| **20** | **Worldwide offline coverage** — codec, cell grid, LOD, prefetch, rolling re-anchor, eviction |
| **21** | **Tier R** — IO-VNBD converted to a replay corpus; scoring on real sensors |
| **22** | The speed-runaway fix; APK 7.41 MB |

Two entries are worth pointing at:

- **"an audit that caught a broken headline"** — a published number was wrong and
  our own audit found it before anyone else did.
- **"Phase 13, Model 3: AI drift residual — a documented negative result"** — a
  model that did not work, kept in the record.

---

# 28 · What remains

Named honestly, in priority order.

## 28.1 Tier F — a real drive

**The single most valuable thing left.** Our own phone, our own vehicle, a real
tunnel, surveyed ground truth. `docs/field-protocol.md` is the procedure.

Until this exists, every headline number is an upper bound.

## 28.2 Along-track speed after the Doppler expires

Tier R says heading is good (slope 1.002, 0.9°) and speed is not: the error is
**3–4× larger along-track than cross-track**, and the spread runs from 6.9 % to
107.2 % depending on whether the window is free-flowing or stop-go.

The plausible directions, none yet measured:

- feed **M1's speed estimate** into the filter with a proper covariance during
  outages rather than only as a diagnostic
- use **road-graph geometry** to bound speed — a 30 km/h residential street is
  information
- **learned per-vehicle scale** — a given car and phone pairing has a repeatable
  accelerometer scale error
- **wheel-speed via CAN** where a dongle is available, as an optional aid

## 28.3 Tightly-coupled GNSS

§3.1. Real value at the *edge* of coverage, where the receiver has two satellites
and discards them.

## 28.4 The particle filter, on by default

It has the best cross-track number in the project (21.8 m). Making it the default
needs a battery measurement we have not taken.

## 28.5 CI

The repository has `keepalive.yml` and nothing that runs the 1,620 tests on push.
For a project whose entire credibility rests on those tests being green, that is
a gap.

## 28.6 Smaller items

- `version` field in `apk.json`
- more Tier R logs — IO-VNBD has more sessions than the two converted
- iOS

---

# 29 · Command reference

Every script in `package.json`.

## Development
| Command | Does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm dev:lan` | …bound to the LAN, for testing on a phone |
| `pnpm dev:https` | …over HTTPS, which sensor APIs require |
| `pnpm build` | Static export |
| `pnpm start` | Serve the export |

## Quality gate
| Command | Does |
|---|---|
| `pnpm test` | **1,620 tests** |
| `pnpm test:watch` | `nav-core` in watch mode |
| `pnpm typecheck` | Every package |
| `pnpm lint:core-purity` | **Fails if `nav-core` gains an import or a dependency** |

## Evaluation
| Command | Produces |
|---|---|
| `pnpm eval` | A single run |
| `pnpm ablation` | `docs/benchmarks.md` + `.csv` + `.json` + `ablation.svg` |
| `pnpm eval:tier-r` | `docs/benchmarks-tier-r.md` — **real sensors** |
| `pnpm eval:alignment` | `docs/alignment.md` |
| `pnpm eval:offroad` | `docs/offroad.md` |
| `pnpm eval:drift-dataset` | Drift training data |
| `pnpm eval:gnss-dataset` | GNSS-quality training data |
| `pnpm eval:record` | Record a log |

## Edge
| Command | Does |
|---|---|
| `pnpm edge` | Run the headless engine |
| `pnpm edge:bench` | `docs/edge-benchmarks.md` |

## Android
| Command | Does |
|---|---|
| `pnpm android:doctor` | Check the toolchain **before** building |
| `pnpm build:android` | Export → Capacitor → Gradle → APK |
| `pnpm android:gradle` | Gradle only |
| `pnpm cap:sync` | Capacitor sync |
| `pnpm publish:apk` | Copy the APK into `public/downloads` |
| `pnpm build:site` | APK + publish + site, in order |

## Data
| Command | Does |
|---|---|
| `pnpm data:iovnbd` | Convert IO-VNBD CSVs → Tier R replay logs |
| `pnpm demo:log` | Generate a demo log |
| `pnpm demo:brief` | Generate the offline brief |

---

# 30 · Hard questions, answered

The short forms. Each links to the section that carries the detail.

**"How is this different from Google Maps?"**
Google Maps interpolates along the route you asked it for. Take an unplanned turn
inside a tunnel and it has nothing to interpolate along. **We need no route** —
the estimate comes from physics. §2.1.

**"How can offline maps be that small?"**
We do not store pictures of roads. We store **road centrelines and topology** in
a purpose-built binary codec: **8.03× smaller than raw JSON, 2.72× smaller than
gzip**, with full detail within 20 km and major roads out to 100 km. **3.5 MB per
100 km** against ~150 MB of raster tiles. And the same data draws the map *and*
feeds the matcher. §11.

**"How does it work outside your city?"**
There is no region. Coverage is addressed by worldwide slippy-map cells and
fetched silently around wherever you are, re-anchored every 20 km, leading you by
10 km. **Nobody chooses a region because there is no region.** §11.3, §11.6.

**"Who pays for the maps?"**
Nobody. OpenStreetMap via Overpass, cached on the device. **There is no PathPulse
server and no account.** §3.10.

**"Does it need the phone mounted a particular way?"**
No. Alignment is estimated while driving. A phone at **90° costs 7.1 % with
alignment and 38.2 % without**. §19.4.

**"How fast does it take over when GNSS drops?"**
**0 ms**, and the reason is structural: dead reckoning was already running.
`gnssHealthy` goes false and no other code path changes. §4.1.

**"Is it actually AI, or is that a label?"**
Four small models, on-device, weights inlined in TypeScript with no inference
runtime: speed (27,041 params, MAE 2.942 m/s, R² 0.792, +0.4 % drift bias), context (9,736 params,
macro-F1 0.4795 vs 0.0884 baseline), GNSS quality (988 params). They **aid** an
auditable filter rather than replacing it, because a network that cannot be
down-weighted has to be right. §13, §3.2.

**"Why not one big neural network?"**
Because when it is wrong there is no state to inspect, no constraint that failed,
and no uncertainty to display. For a system whose worst failure is *confident
wrongness*, that is disqualifying. §3.2.

**"What is your actual accuracy?"**
**6.9 % on simulated logs, 41.3 % on real vehicle sensors, and we publish both.**
The gap is along-track speed error, it is named in §28.2, and Tier S numbers
should be read as an upper bound. §22.

**"What have you not proved?"**
A drive with our own phone through a real tunnel against surveyed truth. Tier F
does not exist. `data/replay/README.md` says so, and so does this document. §22.

**"Why is a slower configuration in your results table?"**
Because `full_forwardbias` is **worse** — 6.9 % → 10.8 % — and deleting it would
make the table a brochure. Four rejected approaches are kept with their numbers.
§23.

**"Two-wheelers?"**
Lean is detected as lean rather than as the phone moving, NHC is relaxed while
leaning, and single-cylinder vibration is graded rather than integrated. §10.13.

**"NavIC?"**
Recognised in `gnss/constellations.ts`, and it matters practically: NavIC's
satellites sit high over India, which is often better visibility geometry in an
urban canyon. §10.12.

**"One app or two deliverables?"**
Two, and they are **the same estimator**. `@pathpulse/edge-engine` imports
`@pathpulse/nav-core` and calls the same `step()` the phone calls. That is only
possible because `nav-core` has **zero dependencies**, which is enforced by a
linter. §16, §7.1.

---

*PathPulse · Team Avinya · SIH26168 · ISRO*
*Every number in this document is regenerated by a command named beside it.*
