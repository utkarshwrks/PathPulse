# Real-drive validation protocol

Every number this project publishes today comes from a **simulator**. That is
said on every page that carries one, and it is the single largest gap between
what has been built and what can be claimed.

This document is what closes it. It is written to be executed by somebody with
a phone and a vehicle, not read.

---

## Before you leave

- [ ] **Install the current APK** and open it once. `pnpm build:android`
- [ ] **Download the area.** Open Offline → *Download roads + map*. Confirm it
      reads `road graph: downloaded · N ways`. **Without this, road snapping
      does not engage and the drive is wasted** — the marker will drift into
      open ground and the log will not show why.
- [ ] **Grant location "Always"**, not "While using". Background location is
      what lets the foreground service keep a fix with the screen off.
- [ ] **Disable battery optimisation** for PathPulse. Android will otherwise
      kill the service mid-drive on some OEM builds, and the recording simply
      stops.
- [ ] Phone charged above 50 %, and a cable in the car.
- [ ] Note the phone model, Android version, and the mount used.

---

## The five routes

Three runs each. The repetition is not padding — a single run cannot separate a
route that is hard from a run that went wrong.

| # | Route | What it tests | Minimum |
|---|---|---|---|
| 1 | **City** | Junctions, stop-start, frequent turns | 15 min, ≥ 20 turns |
| 2 | **Highway** | Sustained speed, few junctions, long straights | 15 min, ≥ 80 km/h |
| 3 | **Tunnel / underpass** | A **real** outage, with truth at both ends | ≥ 2 passes |
| 4 | **Basement parking** | Spiral descent, total loss, no map | 2 levels down and back |
| 5 | **Urban canyon** | Multipath rather than loss — the harder case | 10 min between tall buildings |

**Run every route twice with the phone in a different place:** once in a rigid
dashboard mount, once loose in a cup holder or door pocket. That is not
optional. Phase 12's alignment engine and Phase 15's rigid-mount screen both
exist because a loose phone behaves like a different sensor, and half of
IO-VNBD turned out to be unusable for exactly that reason.

---

## Ground truth, and its two kinds

### PRIMARY — the software outage

Drive with **good GNSS throughout**, record everything, then delete GNSS from a
window of the recording afterwards. The estimator sees exactly what it would
see in a tunnel; the withheld fixes are the truth.

This is what `pnpm ablation` already does, and it is the honest workhorse:
reproducible, arbitrarily repeatable, and the truth was never available to the
estimator so it cannot have been fitted to.

**What it cannot tell you:** whether a real tunnel's IMU behaves like an open
road's. Vibration, temperature and multipath at the mouth are all different.

### SECONDARY — the real tunnel

GNSS exists at the entry and at the exit and nowhere between. Measure the error
at the exit, before the estimate is re-anchored.

**This is the honest one, and it is much harder to get.** You get one number per
pass, the truth is only at the ends, and the first fix after the exit is
frequently the worst of the whole drive — cold satellites and a concrete
overhang. Discard any exit fix reporting worse than 15 m accuracy and say how
many you discarded.

**Report both, and explain the difference.** They will not agree. If the real
tunnel is worse than the software outage — it will be — that gap is the most
interesting number in the whole project, because it is the size of the lie the
simulator has been telling.

---

## Executing a run

1. Start PathPulse, wait for **GNSS** on the badge and ≥ 8 satellites.
2. Confirm the SENSORS tab shows `road graph: downloaded` and a sample rate
   near 10 Hz.
3. **Lock the screen.** Confirm the *"PathPulse is navigating"* notification.
4. Drive the route.
5. At the end, unlock and check **SENSORS → native rate**. If it collapsed to
   ~1 Hz, the foreground service was killed and the run is void — note the OEM
   and the battery setting.
6. Export the trip (EVENTS → *Export JSON*) and name it
   `<route>_<mount>_<run>_<date>.jsonl`.

Put the files in `data/replay/`. They are what every future number is built on.

---

## What to do with the recordings

```bash
pnpm ablation                 # the headline, now on real drives
pnpm eval:offroad             # is the marker on a road?
pnpm eval:alignment           # what a crooked mount costs
python ml/check_sim_transfer.py   # do the models transfer NOW?
```

That last one matters most. Both trained models currently score near chance on
simulated IMU, and the report says so — the simulator's vibration is one 20 Hz
sine plus Gaussian noise, and the models key on a road-and-tyre spectrum that
is not in it. **On real recordings that check should come good.** If it does,
the ablation gains an AI row and every claim about the models stops needing a
caveat.

Then retrain on the real logs:

```bash
python ml/data/preprocess_motion.py && python ml/train_motion.py
pnpm eval:drift-dataset && python ml/train_residual.py
```

Phase 13's residual model failed to generalise across *simulated* route types.
Real data is the only thing that can say whether that was the model or the
simulator.

---

## Recording the results

Replace the ⚠️ SIMULATED banners with measured figures, and keep the ones that
are still simulated clearly marked. For each route report:

- mean, median and **p90** drift as a percentage of distance travelled
- **absolute** final error in metres — a percentage flatters a long outage
- how many runs were discarded, and why
- the phone, the mount, and the vehicle

**Do not delete the simulated numbers.** Show both. A table with a simulator
column and a road column, and an honest gap between them, is worth more than a
table that only ever had one.
