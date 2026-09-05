# PathPulse — everything, explained simply

**Smart India Hackathon 2026 · Problem Statement SIH26168 · Indian Space Research Organisation · Team Avinya**

> This document assumes you know nothing technical. Every term is explained the
> first time it appears. Read it top to bottom and you will be able to explain
> the whole project to anyone, including a judge.

---

## Contents

1. [The problem, in one page](#1-the-problem-in-one-page)
2. [What we built](#2-what-we-built)
3. [How it works — the whole idea](#3-how-it-works--the-whole-idea)
4. [The five rules that stop it drifting](#4-the-five-rules-that-stop-it-drifting)
5. [The AI part](#5-the-ai-part)
6. [Coming back from an outage](#6-coming-back-from-an-outage)
7. [What you see on the screen](#7-what-you-see-on-the-screen)
8. [Running the demo](#8-running-the-demo)
9. [Our numbers, and what they honestly mean](#9-our-numbers-and-what-they-honestly-mean)
10. [Proving it is real, not a video](#10-proving-it-is-real-not-a-video)
11. [What is built and what is not](#11-what-is-built-and-what-is-not)
12. [Questions judges ask, with answers](#12-questions-judges-ask-with-answers)
13. [Glossary](#13-glossary)
14. [One-page cheat sheet](#14-one-page-cheat-sheet)

---

## 1. The problem, in one page

### How your phone normally knows where it is

There are satellites about 20,000 km above the Earth. Each one continuously
broadcasts a radio message that says, in effect, *"I am satellite number 7, I
am at this exact position, and I sent this message at exactly this moment."*

Your phone listens. If it can hear four or more satellites, it can work out how
long each message took to arrive, and from that it calculates where it must be
standing. This is what people call **GPS**. GPS is actually the American
system; there are others — Russia's GLONASS, Europe's Galileo, China's BeiDou,
and India's own **NavIC**, built by ISRO. The general word covering all of them
is **GNSS**.

### The catch

Those radio signals are very weak by the time they reach the ground — roughly
as faint as a 20-watt light bulb seen from 20,000 km away. They cannot pass
through concrete, rock or earth.

So the moment you drive into any of these, your phone goes deaf:

| Where | What happens |
| --- | --- |
| A road tunnel | No sky, no signal |
| Basement or multi-storey car park | No sky, no signal |
| Between tall buildings ("urban canyon") | Signals bounce off glass and concrete, arrive late, and the phone calculates a position that is wrong by tens of metres |
| Under a flyover or dense trees | Signal weakens and comes and goes |

### What that looks like to a driver

The blue dot on the map freezes where you entered. Or it jumps around
erratically. Navigation stops telling you which exit to take — at precisely the
moment you are in an unfamiliar tunnel and cannot pull over to check.

### Why the obvious workarounds do not help

- **Mobile towers / Wi-Fi positioning.** This is how apps guess your location
  without GPS. It is accurate to somewhere between 500 metres and 2 kilometres.
  That is enough to know which city you are in. It is useless for knowing which
  exit of a tunnel you are approaching.
- **Just wait for the signal.** A long tunnel can take several minutes. In a
  basement car park you may never get a signal at all.

**This is the problem ISRO asked teams to solve.**

---

## 2. What we built

**PathPulse is an Android app that keeps navigating when the satellites go
away.**

The one-sentence version:

> When the satellite signal disappears, the app works out how far and in which
> direction the vehicle has moved using the phone's own motion sensors, and
> keeps the dot moving until the signal comes back.

Three things worth knowing straight away:

1. **It needs no internet.** No mobile data, no Wi-Fi, no cloud server. It
   works in aeroplane mode. Everything is calculated inside the phone.
2. **It needs no special hardware.** An ordinary Android phone. Nothing to
   install in the car.
3. **It is not a guess.** It is physics, calculated from measurements, and we
   can show the error numerically at every moment.

---

## 3. How it works — the whole idea

### The two sensors every phone already has

Your phone contains two tiny sensors, each smaller than a grain of rice:

**The accelerometer** measures push. When the car speeds up, you are pressed
back into the seat — the accelerometer feels the same push and reports how
strong it is.

**The gyroscope** measures turning. When the car turns left, the gyroscope
reports how fast it is rotating and in which direction.

These are the same sensors that rotate your screen when you tilt the phone and
count your steps in a fitness app. They do not need any signal from outside.
They just feel what is happening.

### Dead reckoning

There is a navigation technique older than electricity, used by sailors for
centuries. It is called **dead reckoning**, and it works like this:

> If I know where I started, and I know how fast I have been going, and I know
> which direction I have been pointing, then I can calculate where I am now —
> without seeing land at all.

A ship's navigator would note the speed from a trailing log line, the heading
from a compass, and the time from a clock, and mark the chart accordingly.

PathPulse does exactly this, sixty times a second:

- **Where we started** — the last good satellite fix before the signal died
- **How fast** — from the accelerometer (push, added up over time, gives speed)
- **Which direction** — from the gyroscope (turning, added up over time, gives
  heading)

New position = old position + (speed × time) in the direction we are pointing.

### The catch with dead reckoning: drift

Small errors add up. This is not a flaw in our code — it is the nature of the
technique, and it has been true since the age of sail.

Imagine a sensor that is wrong by a tiny amount — say it thinks you are
accelerating very slightly when you are not. That tiny error gets added to your
speed. Then the wrong speed gets added to your position. Then again. And again.

The error grows roughly with **time squared**. After 10 seconds it might be a
metre. After 60 seconds it could be tens of metres. Left completely unchecked,
a phone sitting perfectly still on a table will confidently report that it has
travelled several kilometres.

**Everything interesting in this project is about fighting that drift.**

### The trick that makes the switch instant

Most people would build this the obvious way: use GPS; when GPS dies, start
dead reckoning.

We do not do that. **Dead reckoning runs all the time, from the moment the app
opens** — quietly, in the background, alongside GPS. We call this *shadow
mode*.

Why it matters: when the signal dies, there is nothing to start up, no sensors
to warm up, no delay. The calculation was already running. The switchover takes
effectively **zero time**.

The problem statement specifically asks for a "seamless handler" measured in
milliseconds. Ours is zero milliseconds, because there is nothing to hand over.

---

## 4. The five rules that stop it drifting

Raw dead reckoning drifts badly — our own measurements show about **61% error**
with no help. We bring that down to about **10%** by applying rules about what
a vehicle can physically do. Each rule is simple to state.

### Rule 1 — A car cannot slide sideways

Non-Holonomic Constraint, or **NHC**.

A car's wheels point forwards. A car moves in the direction it is pointing. It
does not, in normal driving, travel sideways like a crab.

So whenever our calculation says the vehicle is drifting sideways, we know that
part is error, not movement, and we remove it.

**This is the single biggest improvement we make** — it takes error from about
59% down to about 29%. More than half the drift, removed by one piece of common
sense about how cars work.

### Rule 2 — A stopped vehicle has exactly zero speed

Zero-velocity Update, or **ZUPT**.

When the vehicle is genuinely stationary — at a red light, in a jam — the
accelerometer still reports tiny amounts of noise. Added up, that noise becomes
imaginary movement.

So we detect stillness, and when we are confident the vehicle is stopped, we
set the speed to exactly zero rather than letting the noise accumulate.

This also gives us something valuable for free: while stopped, whatever the
sensor is reporting *must* be error, because we know the true answer is zero.
So we measure that error and subtract it from then on. **The vehicle
recalibrates the sensors every time it stops at a light.**

### Rule 3 — A stopped vehicle is not turning

Zero-Angular-Rate Update, or **ZARU**.

The same idea, for the gyroscope. When the vehicle is stopped it is not
rotating, so any turning the gyroscope reports is pure error — and we can
measure and remove it.

This matters more than it sounds. Heading error is the worst kind: if you think
you are pointing 10° wrong, then every metre you travel takes you further
sideways from the truth.

### Rule 4 — A car cannot go 500 km/h

The speed clamp.

A plausibility ceiling. If the maths ever produces an absurd speed, it is
wrong, so we cap it. We also apply the speed limit of the road we are on when
we know which road that is.

There is a second part: if we have had no satellite help for a long time, our
speed estimate is increasingly untrustworthy, so we gradually bleed it towards
zero rather than confidently asserting a number we no longer believe. **A
system that says "I am becoming unsure" is more useful than one that is
confidently wrong.**

### Rule 5 — Cars are on roads

Road snapping.

We ship the actual road map inside the app — real road data from
OpenStreetMap. For Jabalpur that is **9,462 roads**, about 2.2 MB, stored in
the app itself with no internet needed.

If our calculated position drifts 30 metres into a building, and there is a
road 30 metres away that we were already driving along, then we are almost
certainly on that road.

One important restraint: **we only correct sideways, never forwards.** The map
can tell us *which road* we are on. It cannot tell us *how far along it* we
have travelled — that would be assuming the answer we are trying to compute.
Getting this wrong would make the system look far more accurate than it is.

### The combined effect, measured

| What we apply | Error |
| --- | --- |
| Nothing (raw dead reckoning) | 61.2% |
| + noise filters | 60.8% |
| + ZARU (rule 3) | 59.2% |
| + ZUPT (rule 2) | 59.2% |
| **+ NHC (rule 1)** | **29.3%** ← the big one |
| + speed clamp (rule 4) | 27.0% |
| + acceleration filtering | 13.6% |
| **+ everything, including road snapping and AI** | **10.0%** |

Each row differs from the one above by exactly one change. This table is
generated by running the software, not typed by hand.

---

## 5. The AI part

### The one thing physics alone cannot solve

Here is a genuinely hard problem. Put a phone in a car with the windows
blacked out. The car is travelling at a perfectly steady 50 km/h on a smooth
road.

Now ask the accelerometer how fast the car is going.

**It cannot tell you.** An accelerometer measures *changes* in speed. At a
constant speed there is no change, so it reads the same as a parked car. This
is not a limitation of cheap sensors — it is physics. A perfectly smooth ride
at constant speed is indistinguishable from standing still, from the inside.

### What we did about it

We trained a small artificial intelligence model to estimate speed from the
*pattern* of vibration.

The insight: a moving car is never truly smooth. Engine vibration, road
texture, tyre noise — these produce a constant fine tremor, and that tremor
looks measurably different at 20 km/h than at 80 km/h. A human cannot read
that difference from a graph. A trained model can.

**How it was trained:** we used **IO-VNBD**, a public research dataset of real
vehicle drives with sensor recordings and known true speeds. The model was
shown many hours of these recordings and learned the relationship between
vibration pattern and actual speed.

**Facts worth quoting:**

- Model type: a 1D Convolutional Neural Network — a design suited to finding
  patterns in a stream of readings over time
- Size: about **135 KB**. Smaller than a photograph.
- Runs **entirely on the phone**. No cloud, no internet, no API call. Your
  sensor data never leaves the device.
- Speed: about **1.4 milliseconds** per prediction
- Accuracy on unseen test data: mean error about **3.7 m/s**, compared with
  4.8 m/s for a simpler statistical method and 8.7 m/s for assuming constant
  speed

The last line is the honest framing: **our model is better than the
alternatives, and it is not perfect.** We report all three numbers.

### Why "no cloud" matters

Three reasons, all worth saying out loud:

1. **It works in a tunnel.** A cloud-based AI needs internet. In the exact
   place this app is needed, there is none. A cloud solution would be useless
   precisely when required.
2. **Privacy.** Your movements never leave your phone.
3. **Speed.** 1.4 milliseconds locally, versus a round trip to a server that
   might take a second — during which the car has moved 15 metres.

---

## 6. Coming back from an outage

When the vehicle exits the tunnel and satellites reappear, there is a moment of
truth. Our estimate says one thing; the satellite says another. The difference
between them is our **drift** — and it is the number we report.

Now, how should the dot move to the correct position?

**The obvious answer is wrong.** Jumping straight there is mathematically
perfect and looks completely broken. A user — or a judge — sees the marker
teleport and concludes the software is buggy, no matter how good the maths was.

So instead the dot **slides** smoothly to the correct place over a couple of
seconds. Continuous motion the eye can follow.

Two refinements that took real work:

**We bound the speed of the correction, not its duration.** An early version
corrected every error over a fixed 2 seconds. For a 600-metre error, that moved
the marker at 300 metres per second — a teleport in all but name. Now there is
a maximum rate, so the correction always looks like movement.

**We are honest when it is too far gone.** If the estimate is more than 400
metres out, sliding is a lie: at a believable speed it would take minutes.
Beyond that threshold we reset the position in one step **and write it in the
log as a reset**. An explicit, labelled jump is defensible. A fake smooth
correction is not.

---

## 7. What you see on the screen

### The first time you open it

A loading screen with expanding rings — the shape of a position being broadcast
and lost. Then a welcome screen, and the offer of a 20-second tour that
highlights four things: the Demo button, the readings panel, the shaded shape
on the map, and the menu. You can skip it at any point, and it never appears
again after the first run.

### The map

- **The arrow** is you. It points where the vehicle is heading.
- **The trail** behind it is where you have been, coloured by how the position
  was known at that moment.
- **The shaded shape around the arrow** is our uncertainty — see below.

### The colours (this is the whole story in one glance)

| Colour | Mode | Meaning |
| --- | --- | --- |
| **Green** | GNSS | Good satellite fix. Confident. |
| **Yellow** | GNSS DEGRADED | Signal is weak or the fix is poor. Still using it, trusting it less. |
| **Orange** | DEAD RECKONING | No usable satellite signal. Position is calculated from motion sensors. |
| **Blue** | RECOVERING | Signal has returned; the dot is sliding back onto truth. |
| **Grey** | ACQUIRING | Still looking for the first fix. |

### The shaded shape — and why it is an ellipse, not a circle

This is one of the most quietly impressive parts, and it is worth understanding
before you demonstrate it.

Most apps show a circle of uncertainty: "we are somewhere within N metres."

Ours is an **ellipse** — a stretched oval — because our two errors are not
equal:

- **Along the road** (the long axis): this error grows every second without
  satellites, because our speed estimate is uncertain and speed error
  accumulates into distance error.
- **Across the road** (the short axis): this error stays small, because Rule 1
  says the car does not slide sideways and Rule 5 says it is on a road.

So during an outage the shape visibly **stretches forwards along the road**
while staying narrow across it.

**Say this during the demo:** *"It is an ellipse rather than a circle because
we know the error is not the same in every direction. We are far more certain
about which road we are on than about how far along it we have travelled."*

### The readings panel (top left)

| Reading | Plain meaning |
| --- | --- |
| Big number | Speed in km/h |
| Mode badge | The colour states from the table above |
| `drift` | How far we think we might be from the truth, in metres |
| `drift %` | That error as a percentage of distance travelled — the problem statement's own measure |
| `distance` | How far we have travelled this session |
| `no gnss` | Seconds since the last satellite fix |
| `uncert.` | The two ellipse axes: along-road / across-road, in metres |
| `confidence` | Our own trust in the estimate, falling the longer we go without satellites |
| `Hz` | Updates per second. The problem statement requires at least 10. Turns amber if it drops below. |

If the app is in a degraded or dead-reckoning mode it also prints **why**, in
words — for example *"fixes arriving but only 37 m accurate — needs 25 m or
better. Common indoors."* This matters: without it the screen shows
"DEAD RECKONING" and "no gnss 1.3 s" together, which looks like a
contradiction.

### The menu (☰, top right)

Everything else lives here, one item at a time:

- **Run the demo** — the scripted 80-second story
- **Where the data comes from** — this phone / simulated drive / recorded run
- **Live sensors & proof** — raw readings, the event log, the switches
- **Offline maps** — download the area for aeroplane mode
- **Measured results** — the full comparison table
- **The pitch** — five slides
- **Device & build** — what this phone can do, and which build is running
- **Replay the tour**

---

## 8. Running the demo

### The 30-second version

1. Open the app
2. Tap **▶ Demo** at the bottom
3. Talk over it for 80 seconds

That is genuinely all. It sets everything up and runs the whole story on its
own, so you never hunt for a button while someone is watching.

### What happens, and what to say

| Time | On screen | Say this |
| --- | --- | --- |
| 0:00–0:15 | Green, vehicle moving normally | *"Normal driving with a satellite fix. Dead reckoning is already running underneath — that is what makes the switch instant."* |
| **0:15** | Flips to orange | *"The signal has gone. Notice there was no pause — the calculation was already running."* |
| 0:15–1:15 | Orange trail, ellipse stretching forwards | *"No satellites now. This is pure physics from the phone's own sensors. Watch the shaded shape stretch along the road — that is the system telling you how wrong it might be."* |
| **1:15** | Blue, dot slides back | *"Signal is back. Watch it slide rather than jump — a teleporting dot looks like a bug even when the maths is right."* |
| 1:20 | Grey, final numbers | *"And there is our error, measured against the real position: X metres over Y metres travelled."* |

### Say this before anyone asks

The banner on screen states it, and you should say it too:

> *"This is our simulator, and the signal loss at fifteen seconds is triggered
> by our script — it is not a real tunnel. The physics and the estimate are
> completely real; the timing is ours."*

Volunteering this **increases** your credibility. A judge who works it out for
themselves stops believing everything else on the screen.

### The strongest thing you can do

After the demo, during an outage, open **Live sensors & proof → CONSTRAINTS**
and switch off **NHC**. The estimate will visibly wander off the road. Switch
it back on and it recovers.

> **A faked demo never breaks on request.** Anything you can break in front of
> someone is real. This is more convincing than any number.

### If everything goes wrong

Menu → **Where the data comes from** → **Recorded run**. That plays a saved
drive with the signal loss already in it — it needs no simulation, no GPS, and
no network. Announce it as a replay.

---

## 9. Our numbers, and what they honestly mean

### The headline

> **10.0% mean drift, 6.4% median, 22.6% at the 90th percentile, over 12 runs.**

In plain terms: over a 60-second outage, if the vehicle travelled 800 metres,
we typically end up about 50–80 metres from the truth.

### What each word means

- **Mean (10.0%)** — the average across all runs.
- **Median (6.4%)** — the middle run. Half were better than this. It is lower
  than the mean, which tells you a few bad runs pull the average up.
- **90th percentile (22.6%)** — nine runs out of ten were better than this.
  It describes the bad days.

### The three things we say out loud

**1. The target is under 10%. Our mean is 10.0%.** That is *on* the line, not
under it. We say so rather than rounding in our favour.

**2. The 90th percentile is 22.6%, and it does not meet the target.** If you
quote only the mean, the first person to look carefully will find the tail. We
put it on the slide ourselves.

**3. Every test so far uses simulated data.** We have no recording of a real
drive yet. Our numbers measure the software against a physics model, not
against a road. **This is the single most important caveat and you must not
let anyone discover it rather than being told.**

### One result we shipped switched off

We built a component called forward-bias correction. When we measured it, it
made things **worse** — 12.8% instead of 10.0%.

So we disabled it, kept the code, and report it in our results table anyway.

**Say this if you get the chance.** A team that reports its own failed
experiment is a team whose successful numbers you can believe.

### Why the table is trustworthy

- The "truth" we score against is each recording's own satellite data, which we
  **hide from the software** during the test window. It cannot cheat, because
  it never sees the answer.
- Each row changes exactly one thing, so every improvement is attributable.
- The table is generated by running the software. Nobody types the numbers.
- The same run always produces the same result — no randomness.

---

## 10. Proving it is real, not a video

Assume every judge's first thought is *"this is a recording."* Nothing in a
polished interface can disprove that, because a scripted animation can display
any numbers it likes.

These five can:

**1. Break it on purpose.** The constraint switches, mid-outage. A recording
cannot degrade on request.

**2. Raw sensor values.** Live readings updating every frame. Put the phone
flat on the table — the accelerometer still twitches by 0.01–0.05. Real sensor
data is always slightly dirty; faked data is suspiciously smooth. Then hand the
phone over and let them rotate it, and watch the gyroscope respond.

**3. The event log.** Every mode change, timestamped to the millisecond, with
its *reason* — for example `MODE_CHANGE GNSS → GNSS_DEGRADED (accuracy 31.0m)`.
**An animation cannot explain itself.** It exports as a file.

**4. The exported trip file.** Export as GPX or GeoJSON and open it later in
any mapping tool. It contains two separate tracks — our estimate and the raw
satellite reference — and the gap between them is the drift, drawn to scale by
software we did not write. Our tracks are labelled by mode, so the inferred
stretches are visibly marked as inferred.

**5. Aeroplane mode.** Download the map area, switch every radio off, and run
the demo. Nothing about this needs a network.

---

## 11. What is built and what is not

The problem statement lists many requirements. Here is our honest position on
each. **Do not upgrade any of these when speaking.**

| Requirement | Status | Our honest sentence |
| --- | --- | --- |
| Instant switchover when signal is lost | **Done** | Dead reckoning runs continuously in shadow mode, so the switch costs zero time |
| Drift under 10% of distance | **Partial** | 10.0% mean, 6.4% median — on the line, not under it. 90th percentile is 22.6%. Simulated data only |
| 10 updates per second on a phone | **Done** | Measured from real frames and shown on screen |
| Map matching and physical constraints | **Partial** | NHC, ZUPT, ZARU and road snapping against a real road map. A more advanced matching method is future work |
| Combining satellite and sensor data | **Partial** | Working fusion with smooth recovery. A more sophisticated filter is future work |
| AI model trained on IO-VNBD | **Done** | 1D-CNN, runs on the phone, no cloud |
| The position plot ISRO asked for | **Done** | Generated from the model's own predictions against known truth |
| On-device inference, no cloud | **Done** | The app makes no network call to navigate |
| Real-time navigation interface | **Done** | Map, readings, uncertainty ellipse, event log, live switches |
| Mobile application | **Done** | Android app, tested on a real phone |
| Offline map | **Partial** | Road data ships inside the app; map tiles are downloaded on request. A fully packaged offline basemap is not built |
| Works at any phone angle | **Partial** | Handled by measuring gravity, so the phone can sit at any tilt. Automatic correction for which way it faces is future work |
| Pothole and vibration rejection | **Partial** | Filters are in place. A learned classifier is future work |
| 200 Hz engine with external sensors | **Future work** | Not built. Our core calculation code has no phone-specific dependencies, so it needs porting rather than rewriting |

**Four "Done", nine "Partial", one "Future work"** — and every partial says what
is missing.

> **Why say "partial" instead of "done"?** Because it is ISRO's own problem
> statement and they will ask. A "Partial" with an honest sentence is a far
> stronger position than a "Done" a judge can disprove with one question.

---

## 12. Questions judges ask, with answers

**"Is this just GPS with extra steps?"**
No — the entire point is what happens when GPS is unavailable. Switch the phone
to aeroplane mode and it keeps navigating. GPS is one input, and the system
works without it.

**"How is this different from Google Maps in a tunnel?"**
Google Maps typically freezes the dot or interpolates along the route it
*expects* you to take. We compute actual movement from actual sensors, so it
works even if you take an unexpected turn inside the tunnel.

**"What is your accuracy?"**
About 10% of distance travelled, on average, during a complete signal loss.
Median 6.4%, 90th percentile 22.6%. And every test so far uses simulated data —
we have no real drive log yet.

**"Have you tested in a real tunnel?"**
Not yet. We have tested on a real phone with real sensors, and our accuracy
figures come from simulated drives. That is our next step and we are clear
about it.

**"What if the phone is not mounted flat?"**
Handled. We work out which way is down by measuring gravity, then calculate
turning about that true vertical. The phone can lie flat, sit upright in a
cradle, or rest at an angle. This was a real bug we found and fixed in phone
testing.

**"Does it drain the battery?"**
It reads sensors continuously, so more than an idle phone. We have not measured
the exact figure over 30 minutes, and we would rather say that than invent a
number.

**"Why should I believe your numbers?"**
Three reasons. The truth data is hidden from the software during testing.
Every row of our results table changes exactly one thing. And we report a
component that made things worse and shipped it disabled.

**"What is NavIC's role?"**
NavIC is ISRO's own satellite system and works as one of the constellations the
phone can use. We show a per-constellation breakdown in the app, with NavIC
listed first. Being straight about a limitation: the standard Android web layer
does not expose per-satellite data, so on a phone today it correctly reports
"unavailable" rather than inventing numbers. Getting real per-constellation
data needs deeper Android integration, which is planned future work.

**"How much did this cost?"**
Nothing. Open-source tools, free map data, a public research dataset, and
phones we already owned.

**"Could it work on a two-wheeler?"**
The physics differs — a two-wheeler leans into turns, which a car does not.
The core approach carries over but would need retuning and testing. We have not
done that, so we are not claiming it.

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **GNSS** | The general term for satellite positioning. GPS is the American one; NavIC is India's |
| **NavIC** | India's own satellite navigation system, built by ISRO |
| **Fix** | One position reading from the satellites |
| **Accuracy** | How wrong a fix might be, in metres. 5 m is good; 35 m is poor |
| **IMU** | Inertial Measurement Unit — the accelerometer and gyroscope together |
| **Accelerometer** | Sensor that measures push / change in speed |
| **Gyroscope** | Sensor that measures turning |
| **Dead reckoning** | Calculating position from speed, direction and time, without outside reference |
| **Drift** | How far our calculation has strayed from the truth |
| **Shadow mode** | Running dead reckoning continuously in the background, even when GPS works |
| **NHC** | The rule that a car cannot slide sideways |
| **ZUPT** | The rule that a stopped vehicle has zero speed |
| **ZARU** | The rule that a stopped vehicle is not turning |
| **Road snapping** | Correcting the position onto the nearest sensible road |
| **Along-track error** | Error in how far along the road you are. Grows fastest |
| **Cross-track error** | Error in how far sideways you are. Stays small |
| **Ablation table** | A comparison where each row removes exactly one component, to show what each contributes |
| **IO-VNBD** | The public dataset of real vehicle drives used to train our AI model |
| **ONNX** | A standard file format for AI models, which lets ours run on a phone |
| **Ground truth** | The real answer, used to score our estimate |
| **Percentile** | "90th percentile = 22.6%" means nine runs in ten were better than 22.6% |

---

## 14. One-page cheat sheet

*Print this bit if nothing else.*

### The pitch in 30 seconds

> "In a tunnel or a basement your phone loses the satellites and the blue dot
> freezes. PathPulse keeps navigating using the phone's own motion sensors —
> no internet, no extra hardware. We measure about 10% error over a 60-second
> blackout, and the app shows you its own uncertainty live so you can see how
> much to trust it."

### Demo order

1. **▶ Demo** — talk over the 80 seconds
2. Point out the **ellipse stretching** during the orange phase
3. Point out the **smooth slide back**, not a jump
4. **Live sensors & proof → CONSTRAINTS** — switch NHC off mid-outage, then on
5. **EVENTS** — show the timestamped log with reasons
6. **Aeroplane mode** — it keeps working

### Numbers to know by heart

- **10.0%** mean drift · **6.4%** median · **22.6%** 90th percentile · 12 runs
- **61% → 10%** — raw dead reckoning versus our full system
- **NHC alone**: 59% → 29%, the single biggest improvement
- **135 KB** AI model, on-device, **1.4 ms** per prediction
- **9,462 roads** of Jabalpur stored inside the app
- **10 Hz** update rate, the problem statement's requirement, measured live

### Three things to say before you are asked

1. "The outage in the demo is triggered by our script — it is not a real tunnel."
2. "All our test data is simulated. We do not have a real drive log yet."
3. "Our mean is on the 10% line, not under it, and our 90th percentile is 22.6%."

### Never say

- ❌ "It is 100% accurate" — it is not, and the app itself shows the error
- ❌ "It works everywhere" — it degrades over long outages, by design
- ❌ "It is done" for anything marked Partial in section 11
- ❌ Any number that is not in this document

---

*Team Avinya · SIH26168 · Indian Space Research Organisation*
*Every figure here is produced by running the software, not typed by hand.*
PathPulse — the rare stuff

  1 · No route needed
  Google interpolates along a route it planned. Take an unplanned turn in a tunnel and it's confidently wrong. We
  estimate from physics. Nobody else can demo an unplanned turn underground.

  2 · 0 ms handover — because there is no handover
  Dead reckoning runs continuously in every mode, corrected by each fix. GPS drops → nothing to start. Everyone 
  else "switches on DR when GPS is lost."

  3 · We publish what failed
  Five components ship disabled with their numbers: forward bias, ESKF, HMM, particle filter, Model 3. Ask any 
  team "what didn't work?" — we have five answers and a table.

  4 · 100 km of offline map = 3.5 MB
  We store roads, not pictures of roads. Same area as map tiles = 150 MB. ~43× smaller. This is the one nobody 
  has thought of.

  5 · The map is drawn from the roads themselves
  No tiles downloaded, ever. Turn the internet off — the roads stay on screen, because they're the same roads the
  estimator snaps to. A raster map will happily draw a street the engine has never heard of. Ours can't lie.

  6 · Measured on real vehicle sensors, not just simulation
  Simulated: 6.9 %. Real sensors: 41.3 %. We publish both and call the simulated one an upper bound. Most teams 
  have one number and no idea how flattering it is.

  7 · Every number is one command away
  pnpm ablation rebuilds the entire results table. Docs say "do not edit by hand." No figure in this project was 
  typed by a human.

  8 · One engine, five places
  Browser, Android APK, headless tests, ablation harness, 200 Hz edge box — byte-identical code, enforced by a
  lint that fails the build. The PS asks for an app AND an edge engine. Ours are the same estimator, not two 
  projects.

  9 · AI that runs in 104 KB
  Four models, pure TypeScript, no ONNX runtime. Using one would have cost 14 MB of WebAssembly to multiply
  26,081 numbers. Whole app is 7.4 MB.

  10 · The detector never blocks the fix
  Spoofing detection and the GNSS-quality model are advisory only — they lower confidence, they cannot reject a
  fix. A false positive must never become a navigation failure.

  11 · The phone can sit crooked
  Yaw is measured about the true vertical, not the phone's Z axis. 90° wrong mount → same result (9.1 % vs 9.0
  %). Everyone else assumes the phone is flat.

  12 · Two-wheelers, in closed form
  A leaning bike turns more than its gyro reports. sin(lean) = v·ω/g — no extra sensor. 25° lean = 8° lost per
  corner = 140 m from one roundabout. The PS names two-wheelers. Almost nobody handles them.

  ---

  If you only get 30 seconds

  ▎ "No route, no internet, no extra hardware. GPS loss costs zero milliseconds because we never stop estimating.
  ▎ 100 km of offline map is 3.5 MB because we store roads, not pictures. And we publish the five things that 
  ▎ didn't work."

  If a judge asks one hostile question

  "How do I know these numbers aren't cherry-picked?"

  ▎ "One command regenerates every one of them, the failures are in the same table, and we measured on real 
  ▎ vehicle sensors as well as our own simulator — the sim