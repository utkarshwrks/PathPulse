# PathPulse — Open Work

> **STATUS, 2026-09-05.** Nine of the thirteen workstreams below are DONE and
> shipped in v0.21 — W1, W2, W3, W4, W5, W6, W7, W8, W9 and W10. Each is marked
> in place. The four that remain (W0, W11, W12, W13) all require a real drive
> log, which needs a vehicle and a phone; they cannot be done from a desk and
> are not started. Baselines after the work: **6.9 % drift, 0.5 m off-road,
> 1,568 tests green** — unchanged from before it, which is the point.

**Developer brief for everything not yet done.**
Written 2026-09-05, after two real field tests (a walk and an 8.7 km drive) in
Jabalpur. Current shipped build: **v0.20 (versionCode 20)**.

Every item below states the symptom in the tester's own words, what was actually
measured, the root cause where it is known, and the acceptance criteria. Items
are ordered by value. Nothing here is speculative — each one was observed on a
phone.

---

## Ground rules for this work

These are not style preferences; breaking them has cost this project real bugs.

1. **`packages/nav-core` stays pure.** No `window`, `document`, `fetch`,
   `navigator`, `localStorage`, React or Node APIs. Verify with
   `pnpm lint:core-purity`.
2. **Measure, don't assert.** Any change touching the estimator must be scored
   with `pnpm ablation` and `pnpm eval:offroad` before and after, and the
   numbers recorded in the code comment. Current baseline to beat:
   **6.9 % mean drift, 0.5 m mean off-road.**
3. **The dot never teleports.** `invariants.test.ts` enforces it.
4. **Ship negative results.** If a fix measures worse, keep it behind a flag
   with the number, do not delete it.
5. **Tests must pass:** `pnpm test` (1,464), `pnpm typecheck`,
   `pnpm lint:core-purity`.

---

## 1 · Global rolling offline coverage — ✅ DONE (W1–W5, v0.21)

> *"Not only for Jabalpur, but for every person who is using this app. Just make
> that system that works in offline perfectly so that map doesn't vanish."*
> *"Even 100 km of map doesn't take any weight on the device... after it passes
> 20 to 40 km then again 100 km radius, so now user can use it. And map should
> be precise."*
> *"They don't directly show that we are downloading 50 MB. We have to do
> something that user don't know, but back and back loads all the things."*

### The requirement, stated plainly

1. **Anywhere on Earth.** No bundled regions, no hardcoded cities. A user who
   opens the app in a village they have never visited gets the same behaviour
   as one in Jabalpur.
2. **The map must never vanish.** Offline, mid-drive, after a restart, with the
   screen locked — roads stay on screen.
3. **A 100 km radius must be weightless.** Single-digit MB, not tens.
4. **Rolling.** After travelling ~20–40 km, the 100 km radius is re-centred
   ahead of the vehicle, and coverage left behind is released.
5. **Precise.** Streets and small roads, not just highways — where the user
   actually is.
6. **Silent.** No dialog offering to download 50 MB. It happens in the
   background, on its own.

### Status

**The rendering half shipped in v0.20** — `components/OfflineBasemapLayer.tsx`
draws the basemap from the road graph, beneath the tile layer, so no map tiles
are needed and the map degrades tile-by-tile instead of going blank.

**What is missing is acquisition**: today the graph comes only from three
bundled areas (`data/maps/index.json`) or a manual download. That is exactly
the "only for Jabalpur" problem. Everything below replaces that.

### The design: level of detail is what makes 100 km cheap

Measured on `road_graph_jabalpur.json` — 9,462 ways, 75,482 nodes, 143 km² of
dense city. **The class distribution is the whole insight:**

| class | nodes | share |
|---|---|---|
| residential | 55,254 | **73.2 %** |
| service | 7,844 | 10.4 % |
| tertiary | 5,538 | 7.3 % |
| unclassified | 3,174 | 4.2 % |
| primary + trunk + secondary + links | 3,618 | **4.8 %** |

Detail is not spread evenly — it is almost entirely local streets. And local
streets 80 km away are worthless: the vehicle will not be on one for an hour,
and by then coverage will have rolled. So:

- **Inner ring (0–20 km): full detail.** Every class, including `service` and
  `residential`. This is where snapping, matching and the drawn map must be
  exact.
- **Outer ring (20–100 km): major roads only** — motorway, trunk, primary,
  secondary and their links. Enough to draw a recognisable map and to snap on a
  highway, which is all a vehicle 50 km away can be doing.

Measured, compact-encoded and gzipped:

| | KB per km² | 100 km radius |
|---|---|---|
| Full detail everywhere | 1.33 | 40.8 MB |
| Major roads only | 0.06 | 1.9 MB |
| **LOD (20 km full + ring major)** | — | **3.5 MB** |
| Raster tiles z11–14, same area | — | ~150 MB |

**3.5 MB for a 100 km radius**, and that is at *dense-city density everywhere*,
which never happens — real mixed terrain is a fraction of it. Against tiles that
is **~43× smaller**; against a flat full-detail graph, ~12× smaller.

This is the answer to "100 km must not weigh on the device".

### 1.1 — Compact codec

New module, e.g. `apps/web/lib/roadGraphCodec.ts` (pure arithmetic, so it may
live in `nav-core` if preferred).

- Quantise coordinates to `1e-5` deg (~1.1 m — well inside GNSS error and far
  inside the 50 m snap radius).
- Delta-encode each way against the previous point.
- Intern `highway` classes to small ints; drop `id`/`name` where unused.
- **Keep `oneway`.** `rejectOnewayReverse` in `roadsnap.ts` depends on it and it
  is worth 2.2 points of drift.
- Measured gain over raw JSON: **4.1× raw, 2.9× gzipped.**
- Round-trip test: decoded coordinates within 1.5 m; `oneway`, `maxspeed`,
  `highway` preserved exactly.

### 1.2 — Global tile grid, not a list of bboxes

`lib/roadGraphStore.ts` stores one graph per bbox with `bboxContains`. That does
not scale to rolling worldwide coverage: overlapping rectangles store the same
road repeatedly and "do I have this area?" is a linear scan.

- **Slippy-map grid, worldwide.** Reuse the tile arithmetic already in
  `lib/tileCache.ts` (`lonLatToTileXY`) so cells are addressed the same way
  everywhere on Earth — no per-region special cases. Suggested: zoom 11 cells
  (~20 km at the equator) for the outer ring, zoom 13 (~5 km) for the inner.
- Store per cell: `{key, lod, bytes, fetchedAt, lastUsedAt}`.
- API: `hasCell(key, lod)`, `putCell(key, lod, bytes)`,
  `cellsCovering(lat, lon, radiusM)`, `evictBeyond(lat, lon, radiusM)`.
- The engine consumes a `RoadGraph` merged from covering cells; merging must
  dedupe ways that straddle a cell boundary (Overpass returns the whole way).
- **Existing hard limit:** `MAX_AREA_SQ_KM = 25` in `lib/roadGraphFetch.ts`
  caps one Overpass request. Cell size must respect it, so wide coverage is
  inherently many requests — see 1.4.

### 1.3 — Rolling window with eviction

This is requirement 4, and it is what keeps storage flat forever.

- Track the anchor the current coverage was built around.
- When the vehicle has moved **> 20 km** from the anchor (tunable 20–40 km),
  re-anchor **ahead along the heading**, not on the current position — the
  vehicle is going somewhere, and coverage should lead it.
- Fetch newly-covered cells; **evict cells now outside 100 km** (or beyond a
  storage cap, whichever binds first), oldest-used first.
- Storage ceiling, hard: default ~50 MB with the LOD scheme leaving huge
  headroom. Never grow unbounded — the tester's device must not fill up.
- Promote/demote LOD as rings move: a cell entering the inner ring is re-fetched
  at full detail; one leaving it can be dropped to major-only.

### 1.4 — Silent prefetch worker

New hook, e.g. `hooks/useGraphPrefetch.ts`.

- **Serialise every Overpass request.** One at a time, with a delay, backing off
  on 429/504 and resuming later. Overpass is a free shared service; a burst of
  parallel requests gets the app rate-limited or banned. This is not politeness,
  it is whether the feature works at all.
- **Order by usefulness**: current cell → cells ahead along heading → the rest
  of the inner ring → outer ring.
- **Unmetered connections by default**, via `navigator.connection` where
  available, with an explicit *"also use mobile data"* toggle.
- Must be cancellable, must never block the UI or the estimator, and must
  survive the screen locking (the Phase 15 service keeps the app alive).
- Consider a self-hosted or mirrored Overpass endpoint if usage grows; note
  in the UI that data is © OpenStreetMap contributors.

### 1.5 — Precision: draw more than you snap to

Requirement 5 asks for a precise map. The build script deliberately excludes
footways — *a car is not on the pavement* — and that must not change for
**snapping**. But it need not constrain **drawing**.

- Fetch `track`, `path`, `footway` for the **inner ring only**, tagged as
  render-only.
- `OfflineBasemapLayer` draws them, thin and dimmer.
- `RoadIndex` / `findRoadMatch` must **never** receive them, or a vehicle will
  snap to a footpath. Keep the two sets separate in the type, not by convention
  — e.g. a `renderOnly: true` flag that `RoadIndex` filters on construction, so
  it is impossible to pass the wrong set by accident.
- Adds roughly 10–20 % to inner-ring size; the LOD budget absorbs it.

### Acceptance criteria

- [ ] **Anywhere:** open the app at any lat/lon with data on; coverage builds
      with no user action and no bundled data for that region.
- [ ] **Offline:** turn data off entirely, force-quit, reopen, press Live —
      roads draw and snapping engages anywhere inside coverage.
- [ ] **Weightless:** 100 km radius stays **under 10 MB** on-device (target
      3.5 MB at city density); report actual measured size.
- [ ] **Rolling:** drive 40 km; coverage re-centres ahead, storage does **not**
      grow monotonically, cells behind are evicted.
- [ ] **Precise:** inner 20 km shows residential and service roads; a footpath
      is drawn but never matched by `findRoadMatch`.
- [ ] **Silent:** no modal, no download prompt, no visible stall.
- [ ] Prefetch never issues parallel Overpass requests; backs off on error.
- [ ] Codec round-trips within 1.5 m with tags preserved.
- [ ] `pnpm ablation` unchanged — this is acquisition, not estimation.

## 2 · Tiles vanish offline and never come back — ✅ DONE (W8, v0.21)

> *"I switch off the internet, map goes proper right, and when I turn on the
> internet it does not load the proper current place. It load the place that
> came after."*
> *"I switch off the night and again open the screen, the map does not load."*

### Root cause (to confirm)

Two separate faults, probably:

1. **MapLibre gives up on failed tiles.** A tile requested while offline fails
   and is not retried when connectivity returns — the tile stays blank until
   something forces a re-request. There is no retry-on-reconnect anywhere in
   `apps/web`.
2. **The camera is following the vehicle, but the tiles being fetched are for
   wherever the map was when the failure happened.** Hence *"it load the place
   that came after"* — stale requests complete for an area already left behind.

### Solution

- Listen for `online` (and MapLibre `error` events with a tile source) and
  force a refresh of failed tiles — the standard approach is to bump a
  cache-busting parameter, or re-set the style source, or call
  `map.style.sourceCaches[id].reload()`. Prefer the least destructive that
  works; re-setting the whole style will flash the map and lose layer state.
- On reconnect, prioritise tiles for the **current viewport**, not queued ones.
- `public/sw.js` is cache-first with a host allowlist; check it is not serving
  or caching a failed/empty response. A 0-byte or error response must **never**
  be written to the cache — that would make a tile permanently blank.

**Note:** item 1's basemap already softens this a lot — roads now draw where
tiles are missing — so this is no longer a blank grey screen. It is still wrong
and should be fixed.

### Acceptance criteria

- [ ] Data off → move → data on: tiles for the **current** view fill in within
      a few seconds without restarting the app.
- [ ] Locking and unlocking the phone does not leave a blank map.
- [ ] A failed tile fetch is never written to the tile cache.

---

## 3 · The HUD panel cannot be moved or collapsed — ✅ DONE (W7, v0.21)

> *"That box that contain everything about drift and speed percentage is not
> movable — if a pointer is below that I can't see the point, and even the map
> is not zoomable there... it should be movable from here to there and can be
> minimised."*

### Solution

`apps/web/components/Hud.tsx` (300 lines), rendered from `app/page.tsx`.

- **Collapse/expand.** Collapsed state shows one line: mode badge, speed,
  drift %. Persist the choice in `localStorage` (wrap in try/catch — the
  codebase already treats storage as fallible).
- **Draggable.** Pointer events, snap to the nearest corner on release, clamp
  inside the viewport including safe-area insets. Must work with touch.
- **Do not block the map.** While dragging, and in general, the panel must not
  swallow map gestures — the tester specifically could not pinch-zoom under it.
  Check `pointer-events` and that the panel is not covering the whole width.

### Acceptance criteria

- [ ] Panel can be dragged to any corner and stays there across app restarts.
- [ ] Collapsed mode shows mode + speed + drift only.
- [ ] The map can be panned and pinch-zoomed in the area the panel used to
      block, when collapsed or moved.
- [ ] Works one-handed on a phone, not just with a mouse.

---

## 4 · Off-road position is dragged onto a road — ✅ DONE (W9, v0.21)

> *"If I am on a mountain then it should also run there... the point should show
> correct wherever I am, but if I am apart from the road it shows me on the
> road."*

### Root cause

`packages/nav-core/src/constraints/roadsnap.ts`:

```
searchRadiusM      50
wideSearchRadiusM  250     <- this one
```

The wide radius exists for a good reason — it was the fix for *"it goes off the
road, into the plots"*, where the estimate drifted past 50 m from any road,
matching silently disengaged, and the marker wandered open ground. It is worth
real accuracy on-road.

But it cannot distinguish **"a bad estimate of a vehicle that is on a road"**
from **"a good estimate of a vehicle that is genuinely not on one"** — a
car park, a field, a mountain track, private land. Both look like a position
200 m from the nearest road.

### Suggested approach — do not just lower the radius

Lowering it will regress the off-road metric (currently 0.5 m mean). Instead
find evidence that separates the two cases:

- **GNSS is healthy and disagrees with the road.** If a trusted fix says we are
  150 m from any road, we are: the fix is a measurement and the road is an
  assumption. The wide radius should apply to *dead-reckoned* positions, not to
  positions confirmed by a good fix.
- **Sustained heading disagreement** with every candidate — already partly
  covered by `maxHeadingMismatchDeg: 60`.
- Consider an explicit *off-road* state that suspends snapping and says so in
  the HUD, rather than silently snapping or silently not.

### Acceptance criteria

- [ ] Standing 100 m off any road with good GNSS shows the marker where the
      phone is, not on the road.
- [ ] `pnpm eval:offroad` mean stays at or under **0.5 m** and >10 m at or
      under **1.6 %** (i.e. do not trade the on-road win away).
- [ ] `pnpm ablation` `full` mean stays at or under **6.9 %**.

---

## 5 · Distance keeps growing while stationary — ✅ DONE (W6, v0.21)

> *"I just stopped and it continuously go forward and forward. It does not stop
> anywhere."*

### Evidence

Screenshot, on foot: `[INTEGRATED] 1 km/h`, `no fix for 108s`, distance still
climbing 120 m → higher. Speed source had fallen from `[STEPS]` to
`[INTEGRATED]`.

### Root cause (partly known)

- `distanceFloorMps: 0.3` in `DEFAULT_ENGINE_CONFIG` is meant to stop exactly
  this, so either the estimate is above 0.3 m/s or the floor is not applied on
  this path. **Check first.**
- When the step detector loses cadence on foot, the engine falls back to
  `INTEGRATED` — double-integrating a hand-held accelerometer, which is the
  worst available estimator for a pedestrian and will happily invent motion.
  A pedestrian with no steps detected is most likely **stopped**, not
  accelerating; the fallback ordering in
  `deadreckoning/DeadReckoningEngine.ts` should reflect that.
- ZUPT requires `StationarityDetector` to fire; a hand-held phone being carried
  may never look stationary enough. Consider using Model 2's `STATIONARY`/
  `IDLING` verdict here (`useMlMotion` is already on by default).

### Acceptance criteria

- [ ] Phone held still, GNSS off, 2 minutes: distance grows by **< 5 m**.
- [ ] Add a regression test to `nav-core/test/pedestrian.test.ts` feeding
      stationary-but-noisy hand-held IMU and asserting the distance floor.
- [ ] `pnpm ablation` not regressed.

---

## 6 · Flaky test in `sensor-sources` — ✅ DONE (W10, v0.21)

`test/foregroundSource.test.ts > ★ carries C/N0 mean AND spread` fails roughly
**1 run in 3**. Reproduce with:

```bash
for i in 1 2 3; do pnpm --filter @pathpulse/sensor-sources test; done
```

The test calls `send([...])` then asserts `samples[0]` immediately; delivery
through the plugin listener is not awaited, so on a slow run `samples` is still
empty. Fix by awaiting delivery rather than adding a timeout.

This matters more than its size suggests: this project's central claim is that
its numbers are reproducible, and a test suite that fails intermittently
undermines that everywhere.

### Acceptance criteria

- [ ] 20 consecutive runs pass.

---

## 7 · Smaller items

- **Recording speed** — the tester flagged `.jsonl` recording as slow. Not yet
  investigated. `packages/sensor-sources/src/recording/RecordingWrapper.ts`.
- **A real drive log.** Still the single highest-value missing artefact.
  `data/replay/` contains only `sim_*.jsonl`; **no `drive_*.jsonl` exists.**
  Every number in `docs/benchmarks.md` is simulated. Capturing one walk and one
  drive turns every fix above from an opinion into a measurement, and it is the
  prerequisite for retraining Models 2–4 (see `ml/check_sim_transfer.py`).
- **Build stamp** — the Device screen reads `<sha>+dirty` because the working
  tree has uncommitted fixes. Commit to get a clean identifier.

---

## Suggested order

1. **§1 global rolling coverage** — the whole offline promise depends on it,
   the rendering half is already shipped, and it is the difference between "an
   app that works in Jabalpur" and "an app". Build it in order: codec (1.1) →
   grid store (1.2) → prefetch worker (1.4) → rolling/eviction (1.3) →
   render-only classes (1.5). 1.1 and 1.2 are testable headless, with no
   network and no map, so they should carry most of the tests.
2. **§5 stationary drift** — small, self-contained, and it makes the app look
   broken to anyone testing casually.
3. **§3 HUD** — pure UI, no estimator risk, immediately visible to a judge.
4. **§2 tile reload** — much less severe now that §1's basemap exists.
5. **§4 off-road** — needs care and measurement; do not rush it.
6. **§6 flake**, then **§7**.

---

## What was fixed in v0.20, for context

Do not redo these:

| Fix | Result |
|---|---|
| Road-snap heading gate (>60° = not a candidate) | Unexpected turns release the road |
| Continuity bonus gated at 40° | Measured: 6.9 % vs 9.1 % at 50° |
| Reverse one-way rejected (carriageway discrimination) | Worth 2.2 points; penalty and fallback both measured no better |
| Basemap drawn from the road graph | Map survives offline, ~800× smaller than tiles |
| GNSS rate readout decays to zero | No more `1.00 Hz` beside `no fix for 76s` |
| Satellite-drop anomaly needs 5 s sustain | No more false alarm on a perfect fix |

**Drift 9.2 % → 6.9 %. Off-road 0.8 m → 0.5 m. 1,464 tests pass.**


---

# What was actually built, and what it measured

Recorded here so the next session does not re-derive any of it.

## Findings that changed the design

**Overpass caps response size, not area.** A major-roads-only query over
10,000 km² returns 3.1 MB in 2.0 s; a full-detail query over 25 km² returns
1.8 MB in 10.4 s. So the outer ring uses z9 cells and the whole 100 km disc is
**116 requests**, not the ~1,200 a uniform 25 km² grid would have needed.

**Overpass requires a User-Agent.** Node's `fetch` sends none and gets HTTP 406.
Browsers always send one, so the app is unaffected — but anything server-side
(the edge engine, a script) must set it.

**The compact codec measured better than predicted:** 8.03× smaller than raw
JSON, 2.72× gzipped, against a predicted 4.1×. The extra factor is JSON itself.

**Road classes are wildly unevenly weighted:** residential is 73.2 % of nodes,
majors 4.8 %. That single fact is what makes a 100 km radius cost ~3.5 MB
instead of ~41 MB.

## Root causes that were NOT what the brief said

**W10 (flaky test).** The brief said delivery was not awaited. It was not that:
`foregroundSource.test.ts` and `nativesource.test.ts` mock the same specifier
with different factories, and running them concurrently decides which one wins
by scheduling. Parallel: ~1 run in 3 fails. `--no-file-parallelism`: 0 in 20.
Fixed in `vitest.config.ts`, not in the test.

**W6 (invented distance).** The brief blamed the speed fallback ordering. That
was half of it. The deeper fault was in `motion/context.ts`: a walker who stops
still has a walking-pace Doppler reading for several seconds, and with the
cadence gone the classifier fell through to VEHICLE — then *wrote that into
`gnssBacked`*, which the outage hold preserved for the rest of the drive.
Measured: 74.9 m of travel invented while standing still, now under 5 m.

**W9 (off-road).** The brief suspected the 250 m wide search radius. Correct,
but it was already restricted to dead reckoning. The missing piece was evidence:
several trusted fixes landing far from any road mean the vehicle is genuinely
off the network. Hysteretic, 3 fixes out and 2 back, so one multipath fix cannot
flip it.

## Deliberate deviations from the brief

**No LOD demotion (W4).** The brief specifies demoting a cell from full to
major as it leaves the inner ring. Not implemented, on purpose: full is a strict
superset of major, so the exchange spends an Overpass request to obtain strictly
less data and opens a window where the area is covered by neither. Cells are
kept until they leave the 100 km disc or lose to the size cap.

**Footways are now fetched (W5).** The old test asserted the Overpass query
excluded them. That only protected graphs fetched through that one function. The
property — a vehicle can never match a footpath — now lives in `RoadIndex`,
which refuses to index anything flagged `renderOnly`, and therefore holds
however the graph was obtained.

## Still open, and why

**W0, W11, W12, W13 all need a real drive log.** `data/replay/` still contains
only `sim_*.jsonl`. Every number in `docs/benchmarks.md` is simulated. W11
(retrain the models), W12 (turn fidelity) and W13 (butter-smooth matching) are
explicitly blocked on W0 by the brief's own dependency note, and doing them
against simulated IMU would measure the simulator.

**Unverified on a device.** The following are implemented and unit-tested but
have not run on a phone: background prefetch against live Overpass, the HUD
drag one-handed, tile refresh on reconnect, and the off-road verdict on real
terrain.


---

# W-A — IO-VNBD replay logs (Tier R) — ✅ DONE

`scripts/iovnbd-to-replay.mjs` converts the already-downloaded IO-VNBD dataset
into `data/replay/iovnbd_*.jsonl`, so the estimator can be scored on **real
vehicle sensors without a field drive**. Run `pnpm data:iovnbd`, score with
`pnpm eval:tier-r`.

## The headline, and it changes what everything else means

    Tier S (simulated) ....... 6.9 % mean drift
    Tier R (real sensors) .. 111.7 % mean drift      16x worse, same code

Every simulated figure this project publishes is an upper bound on the
estimator, not an estimate of it. `ml/check_sim_transfer.py` had shown the same
for the models; this is that finding reaching the estimator.

## What the failure actually is

**Speed, not heading.** Along-track error runs three to four times cross-track
in every window. Heading is in excellent shape — integrating the recovered yaw
rate across real turns reproduces GPS heading change with slope 1.002 and 0.9°
mean error on S3c. What breaks is the speed estimate during an outage: measured
on one window it climbed 0.3 -> 28.9 m/s (104 km/h) while truth stayed at
5-10 m/s.

**And the spread is the other finding**: 0.9 % on a fast straight well-fixed
stretch, 367.6 % in sparse-GPS stop-go traffic. A single mean hides that.

## Traps hit while converting — all verified, none assumed

1. **Gyro axes are not the accelerometer's axes.** Header order correlates
   +0.016 / -0.256 with truth. The right mapping scores +0.904 / +1.000.
2. **Deriving the mapping from CAN yaw rate gives an INVERTED gyro.** CAN is
   ISO 8855 (positive counter-clockwise), GNSS heading is a compass bearing
   (positive clockwise). Magnitudes agreed, every sign was opposite. Derive
   against GPS heading change instead.
3. **`GPS SPEED (Kmh)` is metres per second.** Verified against CAN:
   median ratio 3.659 (S1), 3.633 (S3c). Not in the brief's list of five.
4. Time column is ms, 10 Hz — confirmed, median dt exactly 100 ms.
5. Most phones are not rigidly mounted — **including Vw02, which fails at 0.234
   despite being the longest sequence.** The brief assumed it would pass.
6. **S3b is corrupt**: a 20 rad/s (1,146 deg/s) angular rate, plus a clock that
   repeats. It passed the mount and GNSS screens, so a physical plausibility
   screen was added.

Of 26 sequences, **two survive**: S1 (86.2 min, corr 0.963) and S3c (62.0 min,
corr 0.954). Road graphs for both are committed.

## Known limits of Tier R

10 Hz not 50; GPS only every ~9.8 s; no barometer or per-satellite data; and the
two horizontal gyro axes are under-determined by the data (the vertical one is
measured). It is not a substitute for W0 — it is most of the argument, not all
of it.

## What this unblocks

W11', W12' and W13' are now runnable. The obvious first target is the speed
runaway, because it is where the entire Tier R error lives.
