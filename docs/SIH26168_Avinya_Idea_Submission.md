# PathPulse — SIH 2026 Idea Submission Deck

**Six slides, matching the official SIH 2026 Idea Submission template exactly.**

Every slide below gives you three things:

- **LAYOUT** — how to arrange the slide in PowerPoint
- **CONTENT** — the exact words to put on it (copy-paste)
- **SAY THIS** — what to have ready if a judge asks

> **Numbers rule for the whole deck.** Every figure here is measured and
> reproducible with `pnpm ablation` or visible on the phone. Nothing is
> estimated. Where a claim is a plan rather than a result, it is written as a
> plan. If a judge asks "is that measured or projected?", you must have an
> answer, and for every number in this deck the answer is "measured, and here
> is the command that regenerates it."

> **Before you submit:** fill in **Team ID** on slide 1. The Theme is
> *Miscellaneous*, matching the deck already registered on the portal.

---

## SLIDE 1 — TITLE PAGE

**LAYOUT.** Plain white. Title "SMART INDIA HACKATHON 2026" across the top in
large serif. "TITLE PAGE" centred beneath it. Bulleted list on the left,
SIH 2026 logo on the right. This is the template's own layout — do not
redesign it.

**CONTENT.**

- **Problem Statement ID –** SIH26168
- **Problem Statement Title-** AI-ML based Intelligent Dead Reckoning system for seamless navigation
- **Theme-** Miscellaneous
- **PS Category-** Software
- **Team ID-** _(fill from the portal)_
- **Team Name (Registered on portal) -** Avinya

---

## SLIDE 2 — IDEA / PROPOSED SOLUTION

**LAYOUT.** Product name **PATHPULSE** centred at the top, tagline beneath it.
Team name in an oval, top-left. Then two panels side by side — *The Challenge*
(red header) and *Our Solution* (blue header) — with a full-width strip along
the bottom for the headline result.

### Title

# PATHPULSE

*Navigation that does not stop when the satellites do.*

### Left panel — THE CHALLENGE

**GNSS fails exactly where navigation matters most.**

| | |
|---|---|
| **TUNNELS AND UNDERPASSES** | Signal gone completely. The blue dot freezes at the entrance and reappears at the exit — the driver is on their own for the whole length. |
| **URBAN CANYONS** | Tall buildings reflect the signal. The receiver still reports a position, and it can be tens of metres wrong, which is worse than reporting nothing. |
| **DENSE FOLIAGE & MULTI-LEVEL ROADS** | Weak, intermittent, ambiguous. The phone cannot tell the flyover from the road underneath it. |
| **JAMMING AND SPOOFING** | Cheap, increasingly common, and invisible to the user. |

**The gap:** phones already carry an accelerometer and a gyroscope that keep
working underground. Nothing on a consumer handset uses them to carry the
position through the gap.

### Right panel — OUR SOLUTION: PATHPULSE

**An Android app that keeps navigating with the satellites switched off — using
sensors every phone already has, entirely offline.**

**1 · SENSE** → 60 Hz accelerometer + gyroscope, GNSS when available
**2 · LEARN** → On-device AI infers speed from motion alone
**3 · CONSTRAIN** → Physics rejects impossible motion before it becomes error
**4 · NAVIGATE** → Continuous position, with honest uncertainty on screen

**What makes it different**

- **Shadow mode — 0 ms switchover.** Dead reckoning is not started when GNSS is lost; it has been running the whole time, corrected by every fix. When the signal goes there is nothing to spin up and no gap.
- **The AI knows its own limits.** The speed model is trained on vehicle data, so it declines to answer when the phone is being carried on foot — and a step model takes over instead. A model that says "not my domain" beats one that answers confidently and wrongly.
- **Honest uncertainty.** The screen shows a growing ellipse, not a fake blue dot. Along-track and cross-track error are tracked separately, because they grow for different reasons.
- **Fully offline.** Road graph bundled, map tiles cached, model on-device. No network anywhere in the navigation path.

### Bottom strip — THE HEADLINE RESULT

> **10.0 % mean drift** across 12 outage runs · **6.4 % median** · **0 ms** GNSS-loss switchover · **10 Hz** sustained on a mid-range Android phone
>
> *Measured, reproducible with one command, and every constraint can be switched off live on stage to show what it was worth.*

**SAY THIS.** *"The dot never teleports and it never lies. Watch the badge flip
to DEAD RECKONING — the marker does not pause, because the estimate was already
running. And watch the ellipse grow, because we would rather show you our
uncertainty than hide it."*

---

## SLIDE 3 — TECHNICAL APPROACH

**LAYOUT.** Title across the top with a one-line subtitle. Then a five-box
pipeline, left to right, with arrows. Below it a strip of five differentiators.
Below that, the technology stack as a row of logos.

### Subtitle

*A layered estimator: measure what you can, infer what you cannot, and refuse what physics forbids.*

### The pipeline

**1 · SENSE**
- Accelerometer + gyroscope @ 60 Hz
- GNSS fixes when available (0.1–1 Hz)
- Multi-constellation: GPS, **NavIC**, GLONASS, Galileo, BeiDou

**2 · CONDITION**
- Median filter — rejects pothole spikes
- Low-pass filter — removes engine and road vibration
- Attitude estimation — finds true vertical, removes gravity
- Automatic pitch/roll alignment — the phone need not be mounted flat

**3 · INFER (the AI layer)**
- **1D-CNN speed model**, trained on **IO-VNBD**, INT8-quantised ONNX, **135 KB**, runs on-device
- **Motion-context classifier** — stationary / pedestrian / vehicle, from variance + step cadence + GNSS speed
- **Pedestrian step model** — cadence × stride, with stride length learned from GNSS while GNSS is up

**4 · CONSTRAIN (physics rejects error before it accumulates)**
- **NHC** — a vehicle cannot slide sideways
- **ZUPT** — a stopped vehicle has exactly zero speed; every red light is free calibration
- **ZARU** — a stopped gyro reading is pure bias; every stop removes heading drift
- **Speed clamp** — plausibility ceiling plus decay of an estimate integration can no longer justify
- **Road snapping** — cross-track only, never along-track, so it can never invent progress

**5 · FUSE & PRESENT**
- Shadow-mode dead reckoning, corrected by every trusted fix
- Smooth recovery blending — the marker slews back, it never teleports
- Confidence ellipse: along-track and cross-track tracked separately
- GNSS anomaly detection (jamming / spoofing) — **advisory only, never gates a fix**

### Five differentiators (the strip below the pipeline)

| | |
|---|---|
| **0 ms SWITCHOVER** | Shadow mode. The estimate is already live when GNSS dies. |
| **DOMAIN-AWARE AI** | The model declines outside its training set instead of saturating. |
| **EVERY CLAIM ABLATED** | Nine configurations, one command, published table. |
| **CALIBRATED UNCERTAINTY** | Along-track vs cross-track, derived from gyro bias — not guessed. |
| **FULLY OFFLINE** | Model, road graph and tiles all on-device. Airplane mode is a valid demo. |

### Technology stack

TypeScript · Next.js 14 · Capacitor 6 (Android) · ONNX Runtime Web · MapLibre GL · OpenStreetMap · PyTorch (training) · Vitest

**Architecture note for the slide footer:** the estimator lives in `nav-core`, a
**pure TypeScript package with zero browser and zero Node dependencies**,
enforced by an automated purity check. That is what lets one codebase serve the
phone, the headless evaluation harness, and the planned edge deployment
without a rewrite.

**SAY THIS.** *"The AI is not decoration bolted on for the brief. It supplies
speed — the one quantity an accelerometer genuinely cannot recover on its own,
because a parked car and a car cruising at a steady 50 read identically. That is
exactly the gap a learned model fills."*

---

## SLIDE 4 — FEASIBILITY AND VIABILITY

**LAYOUT.** Three numbered panels across the top — *Working Prototype*,
*Measure What Matters*, *Risk → Control*. One honesty strip along the bottom.

### Panel 1 — IT IS ALREADY BUILT AND RUNNING

**Not a concept. A working Android APK, tested on a real phone, on real roads.**

- Android APK builds and installs; tested live on device
- **10.5–11.2 Hz** sustained on a mid-range handset — the problem statement asks for 10 Hz
- 60 Hz IMU, live GNSS, real OpenStreetMap road graph
- **1,162 automated tests** passing; **84.7 %** line coverage on source
- Runs fully offline — verified in airplane mode

**Two backups for demo day.** A scripted simulator and a recorded replay log,
both on-device, so the demo survives a phone with no signal, no satellites, or
no time.

### Panel 2 — MEASURE WHAT MATTERS

**Nine configurations, twelve runs each, one command: `pnpm ablation`.**

| Configuration | Mean drift |
|---|---|
| Naive double integration | **61.3 %** |
| + filters | 60.9 % |
| + ZARU | 59.3 % |
| + ZUPT | 59.2 % |
| + NHC | 29.3 % |
| + speed clamp | 27.0 % |
| + accel high-pass | 13.6 % |
| **+ road snap + AI speed (full)** | **10.0 %** |

**10.0 % mean · 6.4 % median · 22.7 % p90 · 6.2 s recovery**

*We publish the p90, not just the mean. Quote a mean and someone will find the
tail — so we found it first and put it on the slide.*

### Panel 3 — RISK → CONTROL

| RISK | OUR CONTROL |
|---|---|
| **Sensor bias integrates into runaway error** | ZUPT + ZARU harvest every stop as free calibration; acceleration high-pass removes residual tilt continuously |
| **A wrong answer delivered confidently** | Speed decays when integration can no longer justify it; confidence bar falls with it; ellipse grows on screen |
| **Map matching snaps onto the wrong road** | Cross-track only, never along-track — snapping can never invent progress; applied to the drawn position, never fed back into the estimate |
| **The AI model is a file, and files corrupt** | Wrapped in a catch; on failure it is disabled, the reason is logged and shown, and the app degrades to physics. It never crashes |
| **Model asked about motion it never saw** | Motion-context classifier holds it back and says so on screen |
| **GNSS jamming or spoofing** | Detected and reported — **advisory only.** A false positive must never become a navigation failure |

### Bottom strip — WHAT WE HAVE NOT DONE YET

**Stated plainly, because a judge will ask.**

- **All current logs are simulated.** They measure the estimator against a physics model, not against a road. The benchmark file says so at the top, in bold. Real drive logs are the next milestone.
- **Fusion is classical, not learned.** AI supplies speed today; learned GNSS+INS fusion is the next build.
- **The ~200 Hz edge engine is designed, not built.** `nav-core` is already runtime-free specifically so it can be lifted onto edge hardware unchanged.

**SAY THIS.** *"We would rather tell you the three things we have not finished
than have you find them. Everything else on this slide, you can reproduce on
your own machine in about thirty seconds."*

---

## SLIDE 5 — IMPACT AND BENEFITS

**LAYOUT.** Three columns with arrows between them — *Today* (red), *With
PathPulse* (blue), *Future* (green).

### Column 1 — TODAY: THE CHALLENGE

- **THE DOT FREEZES.** Enter a tunnel and navigation simply stops.
- **CONFIDENTLY WRONG.** In urban canyons the receiver reports a position tens of metres off and shows no doubt at all.
- **MISSED TURNS.** Interchanges and flyovers are exactly where signal is worst and where a wrong turn costs the most.
- **NO FALLBACK.** Emergency response, logistics and surveying all lose positioning at the same moment, for the same reason.
- **INFRASTRUCTURE-DEPENDENT.** Existing fixes need roadside beacons or expensive vehicle-grade IMUs.

### Column 2 — WITH PATHPULSE: KEY BENEFITS

- **SEAMLESS CONTINUITY.** 0 ms switchover. The user never sees the handover; the estimate was already running.
- **HONEST UNCERTAINTY.** A growing ellipse instead of a false blue dot. The user knows when to trust it — which is what makes it trustworthy.
- **ZERO EXTRA HARDWARE.** Runs on a phone people already own. Nothing to install on the road, nothing to fit to the vehicle.
- **WORKS OFFLINE, ANYWHERE.** No network in the navigation path. Model, map and road graph all on-device.
- **NavIC-READY.** Multi-constellation with Indian regional satellites recognised and reported by name.
- **EVERY CLAIM CHECKABLE.** Live constraint toggles, an event log that explains every mode change, and GPX/GeoJSON export of both our estimate and the raw GNSS track — so anyone can measure the gap themselves.

### Column 3 — FUTURE: WHERE THIS GOES

- **EVERY INDIAN COMMUTER.** Tunnels, metro underpasses and flyovers stop being dead zones on an ordinary phone.
- **EMERGENCY RESPONSE.** Ambulances and fire crews keep positioning inside basements, tunnels and dense urban cores.
- **LOGISTICS AND FLEET.** Continuous tracking through underground loading bays and covered terminals, with no vehicle retrofit.
- **DEFENCE AND STRATEGIC USE.** Navigation that survives deliberate GNSS denial, with jamming reported rather than silently absorbed.
- **EMBEDDED DEPLOYMENT.** The same estimator, unchanged, on edge hardware for UAVs, rovers and autonomous platforms.
- **ATMANIRBHAR POSITIONING.** An indigenous, NavIC-aware, infrastructure-free layer under India's navigation stack.

**SAY THIS.** *"The unlock is that it needs nothing new. No beacons, no
roadside units, no vehicle-grade IMU. It is one APK on a phone that is already
in the user's pocket — which is why it can reach a hundred million people
instead of a hundred vehicles."*

---

## SLIDE 6 — RESEARCH AND REFERENCES

**LAYOUT.** Two columns — *Key References* (left, with link icons) and *Our
Research Focus* (right). One summary box across the bottom.

### Left column — KEY REFERENCES

**IO-VNBD — Inertial Odometry Vehicle Navigation Benchmark Dataset**
The vehicle IMU + GNSS corpus our speed model is trained on.
https://github.com/onyekpeu/IO-VNBD

**ISRO / NavIC — Indian Regional Navigation Satellite System**
https://www.isro.gov.in/SatelliteNavigationServices.html

**Groves, *Principles of GNSS, Inertial and Multisensor Integrated Navigation Systems*** (2nd ed., Artech House)
The standard reference for INS mechanisation, ZUPT and non-holonomic constraints.

**Titterton & Weston, *Strapdown Inertial Navigation Technology*** (2nd ed., IET)
Strapdown mechanisation and error propagation.

**Newson & Krumm, "Hidden Markov Map Matching Through Noise and Sparseness"** (ACM SIGSPATIAL, 2009)
The HMM map-matching approach on our roadmap.

**OpenStreetMap**
Road geometry and speed-limit tags, used offline.
https://www.openstreetmap.org

### Right column — OUR RESEARCH FOCUS

**Domain-aware machine learning**
A speed model trained on vehicles is asked about a pedestrian and answers
confidently and wrongly. We research how a deployed model should *recognise and
declare* the edge of its training distribution — and what should take over when
it does.

**Constraint-based error suppression**
Which physical constraints actually earn their place, measured rather than
assumed. Our own ablation retired a component we had built and believed in:
forward-bias estimation measures **worse** than the high-pass that replaced it,
so it ships disabled and the negative result is published beside the positive
ones.

**Calibrated uncertainty**
Along-track and cross-track error grow for different reasons — accelerometer
bias and heading bias respectively — so we derive them separately from residual
gyro bias rather than reporting one blended number.

**Pedestrian dead reckoning**
Step cadence times stride length, with stride learned online from GNSS. Unlike
integration this does not degrade with outage length, because cadence is
measured fresh at every step.

**Reproducible evaluation**
A headless harness that replays logs deterministically, so every published
figure regenerates with one command on any machine — no phone, no network, no
hand-copied numbers.

### Bottom box

> **Built on established inertial-navigation theory, a public benchmark
> dataset, and open geospatial data — with every claim reproduced by an
> automated harness rather than asserted.**

---

## WHAT THE 24 AUGUST DECK IS MISSING, SLIDE BY SLIDE

The registered deck was built before nearly all the engineering. It describes
the idea correctly — nothing in it is *wrong* — but it describes a proposal,
and what exists now is a working system with a published measurement table.

**Two things are missing from all six slides at once:**

1. **There is not a single number anywhere in the deck.** Not one. Six slides,
   zero measured figures. A judge cannot tell a team that built something from
   a team that wrote about building something, and the only thing that
   separates them on paper is numbers.

2. **The letters "AI" and "ML" never appear except inside the problem
   statement title on slide 1.** The statement is *"AI-ML based Intelligent
   Dead Reckoning"*. Slide 3 calls the core a "Sensor Fusion Algorithm". A
   reader who compares the PS title with the deck concludes the AI is missing —
   and it is not missing, it is trained, quantised and on the phone.

| Slide | What the deck says now | What is in the project but not on the slide |
|---|---|---|
| **1 · Title** | Correct — no change needed | — |
| **2 · Idea** | "Automatically detects signal loss, switches to dead reckoning" | **0 ms switchover** — DR is never "switched to", it has been running the whole time. The deck describes a slower design than the one that exists. Also missing: the AI layer, the confidence ellipse, and that it is **built and running** |
| **3 · Technical** | Five generic boxes: monitor → detect → switch → estimate → recover. Bottom row lists "Sensor Fusion Algorithm" as one box | The actual technical content: **NHC, ZUPT, ZARU, speed clamp, road snapping** — the constraints that take drift from 61.3 % to 10.0 %. The **1D-CNN on IO-VNBD, 135 KB INT8 ONNX, on-device**. Motion-context classifier. Pedestrian step model. Attitude estimation. The pure-TypeScript `nav-core` architecture |
| **4 · Feasibility** | "Technically achievable using existing sensors" | It is not achievable — it is **achieved**. APK running on a phone, **10.5–11.2 Hz measured**, **1,162 tests**, **84.7 % coverage**, and the full **nine-configuration ablation table**. Plus the three honest gaps |
| **5 · Impact** | Four generic benefit boxes | **NavIC**, GNSS-denial / defence relevance, emergency response, and verifiability — GPX export of both tracks, live constraint toggles, an event log that explains every mode change |
| **6 · References** | ESA Navipedia, Android developer docs, OpenStreetMap, MapLibre | Three of those four are **product documentation, not research**. Missing: **IO-VNBD** (the dataset the problem statement itself names), **ISRO/NavIC** (an ISRO problem statement with no ISRO reference), **Groves** and **Titterton** (the standard inertial-navigation texts), and the HMM map-matching paper |

**If you only change two slides, change 3 and 6.** Slide 3 is where a technical
judge decides whether you understand the problem, and right now it shows a flow
chart any team could have drawn from the problem statement alone. Slide 6 is
where they decide whether you read anything, and right now it cites the Android
developer portal to an ISRO panel.

---

## APPENDIX — not slides, for your own preparation

### The four numbers to memorise

| | |
|---|---|
| **10.0 %** | mean drift, full configuration, 12 runs |
| **0 ms** | GNSS-loss switchover (shadow mode) |
| **10 Hz** | sustained on a mid-range phone (PS requires ≥10 Hz) |
| **61.3 % → 10.0 %** | what the whole system is worth over naive integration |

### The three questions you will be asked

**"Is the AI real or is it decoration?"**
Real, and specific. A 1D-CNN trained on IO-VNBD, INT8-quantised to 135 KB,
running on-device. It supplies speed — the one quantity inertial sensors
genuinely cannot recover alone, because a parked car and a car at a steady 50
produce identical accelerometer readings. The HUD labels every reading with its
source, `[GNSS]`, `[ML]` or `[STEPS]`, so you can watch the model hand over in
real time.

**"How do we know these numbers are real?"**
`pnpm ablation` regenerates the whole table in about thirty seconds on any
machine. Every constraint can be switched off on stage and you can watch the
estimate degrade live. And the app exports GPX with two tracks — our estimate
and the raw GNSS — so anyone can open both and measure the gap in software we
did not write.

**"What are the limits?"**
Three, and we volunteer them: all current logs are simulated; the fusion is
classical rather than learned; and the edge engine is designed but not built.
The p90 is 22.7 %, above the 10 % target — which is why we publish the p90 and
not only the mean.

### Build order if you get to the finale

1. **Learned GNSS+INS fusion** — the PS names it twice and it is our largest gap
2. **Edge engine at ~200 Hz** — a named deliverable; `nav-core` is already runtime-free, so this is packaging rather than a rewrite
3. **One real drive log** — converts every number in this deck from "simulated" to "measured on a road". Highest credibility per hour of work, and it needs a car rather than code
4. Automatic yaw alignment, then HMM map matching

---

*Team Avinya · SIH26168 · Indian Space Research Organisation · Smart India Hackathon 2026*
