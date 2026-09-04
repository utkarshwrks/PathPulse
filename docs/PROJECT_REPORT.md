# PathPulse — Complete Project Report

**AI-ML based Intelligent Dead Reckoning for Seamless Navigation**
Smart India Hackathon · Problem Statement **SIH26168** · Sponsor: **ISRO**
Team **Avinya**

---

## 1. What problem this solves

GNSS fails exactly where navigation matters most: tunnels, underpasses,
basement car parks, urban canyons, dense foliage. India has roughly 300 million
vehicles and no fallback for any of them.

Google Maps handles this by **interpolating along a route it planned**. It
works, and it fails in one specific way: take an unplanned turn in a tunnel and
it is confidently wrong, because without a route there is nothing to
interpolate along.

PathPulse estimates motion from **physics** instead, then constrains that
estimate with facts that are always true:

| Constraint | The physics |
|---|---|
| **NHC** | a vehicle cannot slide sideways or fly |
| **ZUPT** | a stopped vehicle has *exactly* zero velocity |
| **ZARU** | a stopped vehicle's gyro reading is *pure bias* |
| **Road snapping** | a vehicle is on a road, and that fact is perpendicular to it |
| **Accel high-pass** | real acceleration averages to zero over a minute; tilt error does not |

No route required. No network required. No special hardware.

### What the problem statement demands

> "The final deliverable must be a working mobile application **and** an Edge
> deployable software engine."

Not *or*. Both — and in this project they are the same estimator.

---

## 2. Architecture

```
                    nav-core   (pure TypeScript, zero I/O, zero dependencies)
                                          │
        ┌─────────────────┬───────────────┼───────────────┬──────────────────┐
        │                 │               │               │                  │
   Browser          Android APK      Replay tests    Ablation harness    Node edge engine
   (1 s reload)    (real sensors)     (headless)      (the numbers)     (200 Hz, UDP/serial)
```

### Golden Rule #1 — `nav-core` is pure

Nothing in `nav-core` may touch `window`, `document`, `fetch`, `navigator`,
`localStorage`, React, or any Node API. Enforced mechanically:

```bash
pnpm lint:core-purity     # ✔ nav-core is pure — 69 files, 0 violations
```

That rule is the reason the edge engine took days instead of weeks, and it
caught three genuine mistakes during this work — each time a local variable
named `window` shadowing the browser global, and each time the clearer name
(`stretch`, `imuWindow`, `observations`) was better anyway.

### The other rules that shaped the code

- **Golden Rule #6 — the dot never teleports.** Enforced by tests that measure
  the largest single-sample marker movement across every configuration. It
  caught four separate regressions during this work, including two that were
  introduced by *fixes for something else*.
- **Measure, don't assert.** Every claim in this document has a command that
  reproduces it.
- **Ship the negative results.** Four components are disabled by default with
  published numbers explaining why.

---

## 3. Headline results

All figures reproduce with `pnpm ablation` over four committed logs × three
outage windows.

### Drift — the ablation

| Configuration | Mean % | Median % | p90 % | Along m | Cross m |
|---|---|---|---|---|---|
| naive integration | 59.5 | 57.9 | 80.9 | 297.5 | 173.7 |
| + filters | 59.3 | 57.9 | 80.9 | 295.1 | 175.2 |
| + ZARU | 57.7 | 50.5 | 81.7 | 299.8 | 165.3 |
| + ZUPT | 57.5 | 52.3 | 76.5 | 300.4 | 156.5 |
| **+ NHC** | **33.5** | 34.7 | 52.6 | 146.5 | 71.3 |
| + speed clamp | 30.2 | 34.7 | 52.6 | 128.4 | 69.9 |
| **+ accel high-pass** | **14.6** | 16.6 | 25.9 | 71.7 | 49.7 |
| **full (shipped)** | **9.2** | **5.3** | 22.6 | 57.4 | 39.6 |
| ~~+ forward bias~~ | 13.3 | 14.5 | 21.6 | 71.2 | 41.8 |
| ~~+ ESKF~~ | 10.1 | 8.5 | **19.4** | 62.2 | 46.2 |
| ~~+ HMM~~ | 10.5 | 7.0 | 25.1 | 59.8 | 39.5 |
| ~~+ particle filter~~ | 13.0 | 10.1 | 22.7 | 85.5 | **22.6** |

**9.2 % mean — inside the problem statement's <10 % target.** The two largest
single wins are NHC (57.5 → 33.5) and the acceleration high-pass (30.2 → 14.6).

Struck-through rows ship **disabled**. Each is explained in §5.

### Is the marker on a road? — `pnpm eval:offroad`

Drift measures distance *to* the truth. It is blind to which **side** of the
truth the error is on: 30 m along a road is invisible, 30 m across it is a
vehicle in somebody's field. Nothing measured that, so nothing caught it — and
a real field report said exactly that on a build measuring 10 % drift.

| | mean | median | p90 | max | >10 m | >25 m |
|---|---|---|---|---|---|---|
| **shipped** | **0.8 m** | **0.0 m** | **0.0 m** | 71.1 m | **2.8 %** | **0.8 %** |
| snapping off | 15.7 m | 5.6 m | 49.9 m | 106.5 m | 35.2 % | 21.9 % |
| *before the fix* | *12.5 m* | *3.6 m* | *46.6 m* | *106.5 m* | *26.9 %* | *12.5 %* |

### A crooked phone — `pnpm eval:alignment`

The same logs with the raw IMU rotated by a known angle, which is what propping
a handset at an angle does.

| Mount offset | alignment OFF | alignment ON | estimate error |
|---|---|---|---|
| 0° | 9.0 % | 9.2 % | 3.1° |
| 30° | 12.7 % | **9.2 %** | 4.0° |
| 60° | 25.4 % | **9.4 %** | 4.1° |
| 90° | 37.1 % | **9.1 %** | 4.1° |

The claim is not "better" — it is **independent**. Drift stops depending on how
the phone was mounted.

### The edge engine — `pnpm --filter @pathpulse/edge-engine bench`

One estimator, three sensor grades. Only the noise model changes; not one line
of navigation mathematics differs.

| Grade | Rate | Gyro bias | Drift % | Cross m | Heading err | Latency | Sustained |
|---|---|---|---|---|---|---|---|
| Phone MEMS | 50 Hz | 206.265 °/hr | 26.4 | 258.5 | 3.08° | 0.012 ms | 82,756 Hz |
| Tactical | 100 Hz | 2.063 °/hr | 20.3 | 199.4 | 0.05° | 0.011 ms | 89,315 Hz |
| Fibre-optic | 200 Hz | 0.001 °/hr | 15.0 | 140.6 | 0.08° | 0.012 ms | 83,683 Hz |

In Docker, against a 200 Hz target: **49,001 Hz sustained, 0.0896 ms p99** —
the guide's budget is 5 ms, so about fifty times inside it.

---

## 4. What was built, phase by phase

### Part A — Phases 0–10 (pre-existing)

Repo skeleton and the purity rule · map and live GNSS marker · sensor
abstraction and simulator · Android APK via Capacitor · **state machine, dead
reckoning, recovery blender** · HUD and debug panel · **NHC, ZUPT, ZARU, road
snapping, speed clamp** · **eval harness and ablation table** · **IO-VNBD speed
model (Model 1) and the ISRO screening position plot** · confidence ellipse,
turn detection, offline basemap, spoofing detection, NavIC breakdown, GPX
export · demo mode, crash-proofing, in-app pitch deck.

### Phase 11 — Error-State Kalman Filter

15 states (position, velocity, attitude error, accel bias, gyro bias), Solà's
formulation with the **local** angular-error convention throughout. Seven
measurement updates: GNSS position, GNSS velocity, NHC, ZUPT, ZARU, road
cross-track, altitude, plus a forward-speed pseudo-measurement. Joseph-form
covariance, exact symmetrisation, reset Jacobian. **Zero dependencies** — 150
lines of dense linear algebra rather than a package between the phone and the
estimator.

**Result: 10.1 % mean vs the chain's 9.2 %, but p90 19.4 % vs 22.6 %.** Worse
in the middle of the distribution, better at the end of it. Ships off; both
halves asserted so neither can be quietly dropped.

Two bugs found by measuring, not reading:
1. **84.6 % drift** — ZARU was fed the raw *device-frame* gyro while prediction
   used the vehicle-frame rate. A measurement in the wrong frame: unobservable
   bias states absorbed the difference, attitude tumbled at 0.25 rad/s, and
   every returning fix was then gated as an outlier *forever*.
2. **The lateral channel.** Measured lateral acceleration put 8 m/s² into the
   body-y bias; feeding zero was worse, because with no lateral acceleration
   the velocity vector cannot turn and NHC reads the accumulating lateral
   velocity as *yaw error* (26° lost in five seconds). The answer is the
   centripetal term `v × ω`, which agrees with NHC by construction.

**Why ESKF and not the UKF the PS suggests:** the non-linearity lives entirely
in the *nominal* state, which is integrated exactly and never linearised. What
the filter estimates is the *error*, which stays within centimetres and
milliradians of zero. A UKF would spend 31 propagations per step correcting a
linearisation error that is not there.

### Phase 12 — Automatic in-vehicle alignment

Pitch and roll were already free from gravity. The missing degree of freedom is
**which way in the horizontal plane the bonnet points** — gravity cannot tell
you, because every yaw about the vertical looks identical at rest.

While driving straight, all acceleration is longitudinal, so the horizontal
samples form a cigar whose long axis *is* the forward axis. PCA finds it in
closed form from a 2×2 covariance. PCA returns a **line**, so the sign is
resolved against the derivative of speed — while speeding up, acceleration
points forward. Without that, one hard brake outvotes ten gentle accelerations
and the answer is 180° out, driving the estimate down the road in reverse.

Two bugs, both caught by the new harness:
1. `forwardAccelDc` — a 40 s mean subtracted as a tilt estimate — was tracked
   in the **vehicle** frame, so when the alignment settled mid-drive the mean
   described the old rotation. With a 30° mount and a 4°-accurate alignment
   that scored **17.3 % — worse than not aligning at all** (12.6 %). Re-seeding
   was worse still (56 %). Fixed by tracking it in the plane frame.
2. Quality blended toward each window's own quality, so a motorway cruise
   pulled confidence *down* in an alignment six windows had agreed on.

The mount is watched continuously: sustained gravity-direction change discards
the alignment, shows `REALIGNING`, and halves the confidence bar.

### Phase 13 — the three remaining AI models

**Model 2 — motion-state classifier.** 1D-CNN, 9,736 params, 50.7 KB, one
second of IMU, eight classes. Labels from the car's own CAN bus.

| class | precision | recall | F1 |
|---|---|---|---|
| **TURNING_LEFT** | 0.85 | 0.86 | **0.86** |
| **TURNING_RIGHT** | 0.90 | 0.92 | **0.91** |
| STRAIGHT | 0.61 | 0.79 | 0.69 |
| BRAKING | 0.37 | 0.35 | 0.36 |
| POTHOLE_EVENT | 0.19 | 0.75 | 0.30 |

macro-F1 **0.480** against a 0.088 majority baseline. Three uses, each changing
a decision: a confident stop fires a ZUPT the thresholds miss (held to a
*higher* bar — 0.85 vs 0.6 — because measured IDLING precision is 0.70); a
pothole sample is **held, not zeroed**; and the 40 s tilt mean freezes through
corners.

> **★ The dataset finding.** Most of IO-VNBD's phones were **not rigidly
> mounted**. The files *are* synchronised — GPS vs CAN speed correlates above
> 0.9 nearly everywhere — but the phone's gyroscope tracks the car's yaw rate
> in only **two of twenty-six** sequences (0.949, 0.935; everything else below
> 0.34). Survivable for a speed model; fatal for one whose classes are
> TURNING_LEFT and TURNING_RIGHT. Sequences are screened and the failures
> dropped, loudly.

Two mistakes worth keeping: fed raw device axes with a uniformly-random-yaw
augmentation, **three classes scored an F1 of exactly 0.000** and the best epoch
was epoch zero — accelerating and braking are one axis with opposite signs, so
a model told the heading is random has been told the sign carries no
information. And IO-VNBD's time column is **milliseconds**, which made every
acceleration 1000× too small — the symptom was a class balance with 5
ACCELERATING windows in eighty thousand.

Also found: the gyroscope columns are **not** in the accelerometer's axis
order. The header says Yaw/Pitch/Roll; measured against CAN yaw it is column 16
that carries the vertical rate (+0.935), not the one called "Yaw" (+0.071).

**Model 3 — AI drift residual. It does not work, and the number is published.**
Route-disjoint, both directions, against a baseline of predicting zero:

| split | along MAE | cross MAE |
|---|---|---|
| train city → test highway | 70.0 → **206.9 m** (−195 %) | 24.2 → 73.2 m |
| train highway → test city | 45.5 → **426.1 m** (−837 %) | 33.1 → 247.6 m |

City and highway barely overlap in speed, distance or covariance, so a network
fitted on one *extrapolates* on the other — confidently and linearly. What the
failure **did** prove: `clampResidual` bounds every correction to the
estimator's own covariance, and re-measured through it the same broken model
scores −28 % and −49 % instead of −195 % and −837 %.

**Model 4 — GNSS quality classifier.** 988 params, 6.1 KB, eleven features →
GOOD / MULTIPATH / SPOOFED / LOST. Log-disjoint macro-F1 **0.995 and 0.988**
against a 0.250 chance baseline — **and that number means almost nothing**,
because the labels are corruptions generated by a function in this same
repository. The classifier learned that function, not an urban canyon. The
training script prints that *above* the score.

A unit test caught real train/serve skew: fed an obviously dead receiver, the
first model answered **SPOOFED**, because every training log was one class
throughout so the baselines adapted to the corruption. Every pass now
transitions out of GOOD at a randomised onset.

It is **advisory** — it lowers the confidence bar and can never gate a fix.

### Phase 14 — Newson-Krumm HMM map matching

Nearest-road matching has one structural blind spot: **it cannot express that a
road is close but unreachable.** A service road 20 m away, the opposite
carriageway, the road under a flyover — all 20 m away, all requiring a drive to
the next junction and back. The HMM's transition term *is* that quantity.

`RoadTopology` recovers connectivity **exactly**: Overpass returns geometry
from shared OSM nodes, so ways meeting at a junction carry the *identical*
coordinate. Hashing to a centimetre grid finds every junction with no tolerance
to tune — and without welding a flyover to the road beneath it, which any
distance-based join would do on every overpass in the country.

**Measured: 10.5 % vs 9.2 %, and the parameter sweep is flat** (10.4–11.2 %
across 3/5/10/20/40 m) — which is itself the finding: a knob controlling the
model's entire source of advantage that changes nothing says these routes
contain no geometry its transition term can discriminate. Ships off; the
capability is demonstrated by tests that build a parallel service road, a
divided carriageway and a flyover.

Two integration bugs: fed every sample it is **not an HMM** (at 50 Hz
consecutive positions are 3 cm apart and the transition term is uniform); and a
held match must hold the **road**, not the **point** — returning the previous
match verbatim returns a position 10 m *behind* the vehicle and the snap pulls
the marker backwards (9.9 % → 16.0 %).

### Phase 15 — the sensor loop that survives the screen going off

Android throttles a backgrounded WebView: with the screen off, DeviceMotion
falls from 10 Hz to ~1 Hz and stops. A real drive through a tunnel is not done
with the phone awake and unlocked.

**The architecture is deliberately not the guide's.** It recommends embedding a
JavaScript engine natively. That is unnecessary, because `nav-core` is
**deterministic and driven by `sample.t`, not wall clock** — asserted in
`invariants.test.ts`. Ten buffered samples in one burst produce *exactly* the
estimate ten samples at 10 Hz would. The WebView does not need to **run** at
10 Hz; it needs to **consume** 10 Hz.

```
SensorLoopService  foreground service · PARTIAL wake lock · own thread
                   accel + gyro 100 Hz · barometer 5 Hz · magnetometer 10 Hz
                   LocationManager + GnssStatus (C/N0 mean AND spread)
                   ring buffer 2000 samples, oldest dropped AND counted
                        │ batch every 100 ms
   PathPulseSensorsPlugin → ForegroundSource → NavigationEngine
```

**One monotonic clock.** `SensorEvent.timestamp` and
`Location.getElapsedRealtimeNanos()` are both elapsed-realtime;
`currentTimeMillis` jumps on network time correction, and mixing them gives a
negative `dt`.

**It makes NavIC honest.** `GnssStatus` reports the constellation of every
tracked satellite, so `ForegroundSource` is the only source in the project that
can set `constellationsSimulated: false`.

**On the language:** the guide titles this "native Kotlin"; it is Java. The
substance is the loop and the service; adding a Kotlin toolchain to a working
Gradle build is risk without benefit.

**A bug found by watching a number:** the APK went 12.8 → 25.1 MB in one build,
because `publish:apk` → `public/` → `out/` → assets meant each APK contained the
previous one. Back to 12.7 MB.

### Phase 16 — the edge engine, completed

It had a CLI, simulator, replay source, three grades and a benchmark. It could
not take a stream off a wire or hand its estimate to anything.

- **`UdpImuSource`** — JSON datagrams. UDP *not* TCP: a retransmitted IMU sample
  arrives late, the engine treats an out-of-order timestamp as a clock jump and
  discards it, so retransmission costs latency and buys nothing.
- **`SerialImuSource`** — UART, JSON or bare `t,ax,ay,az,gx,gy,gz`. `serialport`
  is **optional** because it compiles a native addon.
- **Output sinks** — file, stdout, UDP broadcast, or any combination, written as
  they go (an interrupted run used to write nothing).
- **Dockerfile** — verified by *running*, not just building.
- **README "Edge deployment"** — a compulsory deliverable had no documentation.

### Phase 17 — the map-aided particle filter ★

**Not in the problem statement, which is the point.** Every other estimator here
is unimodal. That is right while the answer has one peak, and wrong five minutes
into an outage: the vehicle went left or right three minutes ago and the truth
is **one of them**, not a covariance stretched across both.

500 particles, each a complete hypothesis, splitting at junctions and dying when
evidence contradicts them. Typed arrays, stratified resampling, deterministic
RNG. **Turn relocalisation** searches the graph for the sequence of turns just
driven; a unique match collapses the cloud onto it — *recognition*, not
smoothing, which is why a long outage can end **more** accurate than it began.

| | shipped chain | + particle filter |
|---|---|---|
| **City** (junctions everywhere) | 15.1 % | **13.3 %** |
| **Highway** (few, grade-separated) | **3.2 %** | 12.8 % |
| Overall | **9.2 %** | 13.0 % |

Exactly what the mechanism predicts. Ships off; **the split is the finding**,
and the average of the two is the least informative number available.

Three bugs, each of which made it *not a particle filter*:
1. **Snapping each particle's heading to its new road at a junction.** Looks
   right, destroys everything — the heading is the *gyro's*, and it is the only
   evidence that can punish a wrong branch. A vehicle turning right through a
   fork ended up on the **left** one.
2. **Plain resampling ate a hypothesis by luck.** 50/50 drifted to 75/25 then to
   one mode having learned nothing. Now **stratified by hypothesis**.
3. **No position evidence at all.** A cloud that collectively took a wrong turn
   agrees with *itself* perfectly: unimodal, 2 m spread, **1 km from the
   vehicle, 134 % drift**. Self-consistency is not evidence.

### Phase 18 — two-wheelers, and the field protocol

**The thing that breaks on a motorcycle is not NHC — it is the attitude
reference.** In a steady turn a bike leans until the resultant of gravity and
centripetal acceleration runs straight down its *own* axis. That is what leaning
is, and it is why a rider feels pressed into the seat rather than sideways.

So a phone on a leaning bike reads a specific force that **never moves in its
own frame**. The engine takes the leaned axis for "down", and the yaw rate it
recovers is `ω_true × cos(lean)`. **The bike turns more than the engine
believes** — a 25° lean loses 8° on a 90° corner, and 8° over a kilometre of
tunnel is **140 m of cross-track error from one roundabout**.

The fix needs no extra sensor:

```
tan(lean) = v·ω_true/g          ω_measured = ω_true·cos(lean)
⟹  sin(lean) = v·ω_measured/g          ω_true = ω_measured/cos(lean)
```

**Telling a bike from a car — the obvious method fails.** The specific force
tilts by the *same* angle in both: a car cornering at 4.5 m/s² has a resultant
25° off vertical, exactly as a bike leaning 25° does. Same trajectory, same
forces. What differs is whether the **sensor follows it**: a car stays level so
the force swings sideways in the phone's frame; a bike rolls until the force
runs down its own axis, so it does not move at all — only gets heavier.
Car ≈ 1, bike ≈ 0.

**A claim my own test disproved.** The comment in `lean.ts` said the
compensation was safe to leave on for a car — with no lean, `cos 0 = 1`. Wrong:
the function cannot *tell* whether the vehicle leaned, it *infers* it, and a car
cornering briskly presents identical inputs. At 15 m/s and 0.35 rad/s it invents
a 32° lean and inflates the turn by **18 %**. Hence the gate, and hence the
detector's default of CAR.

**`docs/field-protocol.md`** — five routes, three runs, two mount positions, and
both kinds of ground truth, written to be executed rather than read.

---

## 5. What ships disabled, and why

The project's discipline is that a component earns its place by measurement.
Four do not, and all four are kept, toggleable, with published numbers.

| Component | Measured | Why it stays |
|---|---|---|
| **Forward bias** | 12.7 % → 19.1 % | Superseded by the high-pass; the negative result is demonstrable |
| **ESKF** | mean 10.1 vs 9.2, **p90 19.4 vs 22.6** | Better tail, worse middle — a real trade |
| **HMM matching** | 10.5 vs 9.2, flat sweep | Capability is structural; these routes cannot show it |
| **Particle filter** | **city 13.3 vs 15.1**, highway 12.8 vs 3.2 | Helps exactly where junction ambiguity exists |
| **Drift residual (M3)** | 3–8× worse | Does not generalise across route types |

> **This is the strongest thing about the project, not the weakest.** A judge
> asking "what did you build that didn't work?" gets four numbers and an
> explanation, which is a far better answer than a table where everything won.

---

## 6. Honesty ledger — what is still simulated

| Claim | Basis |
|---|---|
| Drift, off-road, alignment figures | **Simulated logs.** Stated on every page. |
| FOG / tactical IMU rows | **Datasheet noise models.** We do not own the hardware. |
| Model 1 & 2 accuracy | **Real** held-out IO-VNBD journeys |
| Model 2 on our logs | 12.8 % accuracy — **the models do not transfer to synthetic IMU** |
| Model 4 macro-F1 0.99 | **Modelled corruptions.** Means almost nothing. |
| NavIC constellation counts | **Measured** via GnssStatus (native only); simulated elsewhere and labelled |
| Screen-off 10 Hz | **Compiles and is unit-tested. Not yet verified on a road.** |

`python ml/check_sim_transfer.py` exists solely to keep the first row honest:
on simulated IMU the speed model scores 8–20 m/s MAE against 2.93 m/s on real
data, and the motion classifier 12.8 % against 57.4 %. **That is a statement
about the logs, not about the models** — and it is why the ablation has no AI
row.

---

## 7. Reproducing everything

```bash
pnpm install
pnpm test                 # 1,464 tests
pnpm typecheck
pnpm lint:core-purity     # Golden Rule #1

pnpm ablation             # the headline drift table
pnpm eval:offroad         # is the marker on a road?
pnpm eval:alignment       # what a crooked mount costs
pnpm eval:drift-dataset   # training rows for Model 3
pnpm eval:gnss-dataset    # training rows for Model 4

pnpm android:doctor       # JDK + SDK, no Android Studio needed
pnpm build:android        # APK, ~12.7 MB

pnpm edge --grade FOG --rate 200 --seconds 60
docker build -f packages/edge-engine/Dockerfile -t pathpulse-edge .

./ml/run_all.sh                    # Model 1, end to end
python ml/train_motion.py          # Model 2
python ml/train_residual.py        # Model 3
python ml/train_gnss_quality.py    # Model 4
python ml/check_sim_transfer.py    # do the models transfer?
```

---

## 8. PS compliance

| Requirement | Where | Status |
|---|---|---|
| In-vehicle alignment & calibration | Phase 4, **12** | ✅ automatic, 3–4° |
| AI speed & vibration filter | Phase 8, **13** | ✅ Models 1 & 2 |
| Advanced map matching & kinematic constraints | 6D, **14** | ✅ NHC + snap + HMM |
| GNSS+INS fusion (AI based) | 4, **11**, **13** | ✅ ESKF + Models 3, 4 |
| Seamless GNSS deficit handler (ms) | Phase 4 | ✅ shadow mode, 0 ms |
| Real-time navigation interface | 1, 5, 9 | ✅ |
| Drift < 10 % of distance | 6, 7 | ✅ **9.2 % measured** |
| 10 Hz update (smartphone) | 4, 10, **15** | ✅ native loop |
| 200 Hz (edge, FOG IMU) | **16** | ✅ 49,001 Hz sustained |
| IO-VNBD trained models | 8, **13** | ✅ four models |
| IO-VNBD position plot | 8 | ✅ screening artefact |
| Mobile application | 3 | ✅ APK |
| **Edge deployable software engine** | **16** | ✅ Docker, UDP, serial |
| On-device inference, no cloud | 8, 13 | ✅ pure-TS network runner |
| Offline map database | 6, 9, **offline** | ✅ downloadable anywhere |
| Pothole / vibration rejection | 4, **13** | ✅ Model 2 |
| Phone misalignment handling | **12** | ✅ |
| **Two-wheeler support** | **18B** | ✅ lean detection + compensation |
| NavIC | 9E, **15** | ✅ measured via GnssStatus |

---

## 9. What remains — and it needs a vehicle

1. **Drive `docs/field-protocol.md`.** Every number above is simulated. The gap
   between a software outage and a real tunnel is the most interesting figure
   this project could produce.
2. **Verify screen-off operation.** Install, lock, drive 10 minutes, read the
   *native* rate on the SENSORS tab. It compiles and is unit-tested; only a road
   can confirm it.
3. **Re-run `check_sim_transfer.py` on real logs.** If the models come good, the
   ablation gains an AI row and every model claim drops its caveat.
4. **Retrain Models 2, 3 and 4 on real recordings.** Model 3 failed to
   generalise across *simulated* route types; only real data can say whether
   that was the model or the simulator.

**Two setup steps silently void a drive:** download the road graph for the area
(Offline → *Download roads + map*), and disable battery optimisation for the
app. Both are in the protocol's checklist.

---

*Every figure in this document is reproducible by the command next to it.
Nothing here is a projection.*
