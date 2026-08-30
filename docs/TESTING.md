# PathPulse — test guide

Everything to check, in order, on a phone. **About 15 minutes.**
Tick as you go. Anything that fails, note the step number.

Build under test: `~/Desktop/PathPulse_Phase10.apk`

---

## 0 · Install (1 min)

1. Share the APK to the phone (Drive / WhatsApp to yourself / USB).
2. Open it → allow "install unknown apps" if asked → Install → Open.
3. Grant **Location** when prompted. Motion needs no prompt on Android.

☐ App opens without a crash.

---

## 1 · First run (2 min)

☐ A **welcome screen** appears: PathPulse, the problem, the 10.0% figure with
its caveat, and two buttons.
☐ Tap **Show me around** → the tour starts at step 1 of 10.
☐ **Next** advances; **Back** works; the dots track position.
☐ Highlight ring lands on the thing each step is describing.
☐ **Skip tour** works from *any* step.
☐ Force-close and reopen → **welcome does not reappear**.
☐ Tap **?** (top right) → the tour replays from step 1.

---

## 2 · The scripted demo (3 min) ★ the main event

☐ Open the source panel (bottom left) and set it to **Live browser sensors**.
☐ Now tap **▶ Demo**.
  *This is the path that was broken until recently — starting the demo from
  Live. It must switch to the simulation and start moving immediately.*

Then watch the banner:

| time | expect |
| --- | --- |
| 0:00–0:15 | green **GNSS — normal driving**, marker moving, trail green |
| 0:15 | flips to orange **Outage — dead reckoning** |
| 0:15–1:15 | trail turns orange, ellipse **stretches forward along the road** |
| 1:15 | blue **Recovery**, marker *slides* back — never jumps |
| 1:20 | grey **Done**, drift readable in the HUD |

☐ The banner says the outage is **scripted, not a tunnel**.
☐ **Restart** runs it again from 0:00.
☐ **Exit demo** returns the manual source controls.

---

## 3 · The HUD (1 min)

☐ Mode badge colour matches the trail colour.
☐ Speed, drift, drift %, distance, "no gnss" all update.
☐ **uncert.** shows two numbers (`along/cross`) — they should differ during
the outage, and the ellipse on the map should match that shape.
☐ Update rate shows ~10 Hz and is **not** amber.
☐ After a turn, a **last turn — RIGHT 87° @ 0:42** line appears.

---

## 4 · Prove it is not a recording (3 min) ★ strongest section

Open **Debug** (top right).

☐ **SENSORS** — raw accel/gyro twitching every frame. Put the phone flat: it
still twitches by 0.01–0.05. Rotate it: gyro jumps.
☐ **SENSORS → constellations** — reads `UNAVAILABLE` on Live (correct: the
WebView exposes none), and `SIMULATED` with NavIC listed during the demo.
☐ **CONSTRAINTS** — start a demo, and **mid-outage switch NHC off**. The
estimate should visibly wander. Switch it back: it recovers.
  *A faked demo never breaks on request. This is the most convincing thing here.*
☐ **EVENTS** — every mode change with a reason and a timestamp.
☐ **STATS** — outage count, durations, measured drift.

---

## 5 · Offline (2 min) ★ the aeroplane-mode moment

☐ Top right → **Offline**.
☐ It states: radio, map source, tile cache **active**, tiles stored.
☐ Tap **Download this area** → tile count and size are quoted *first*, then a
progress bar runs.
☐ Now enable **aeroplane mode** on the phone.
☐ The button turns green and reads **OFFLINE ✈**.
☐ Pan the map — **tiles still draw**.
☐ Run the demo again — it navigates normally with every radio off.

> If it says "tile cache unavailable", you are on the LAN http workflow rather
> than the APK. That is the secure-context limit, not a bug.

---

## 6 · The backup (1 min)

☐ Source panel → **Replay — demo.jsonl (backup)**.
☐ It loads and names itself (`Demo replay (N samples)`).
☐ **Play** → the full outage-and-recovery sequence runs with nothing to trigger.
☐ Progress bar **moves**.
☐ **Restart** works, more than once.
  *All four of those were broken until the last pass — worth checking properly.*

---

## 7 · Export (1 min)

☐ Debug → **EVENTS** → **GPX**. A file downloads.
☐ Also **GeoJSON**.
☐ Open the GeoJSON at <https://geojson.io> (needs network): you should see
**two tracks** — the estimate split by mode, and the GNSS reference — and the
gap between them is the drift.
☐ The estimate's tracks are named `PathPulse estimate — DEAD RECKONING (2)`.

---

## 8 · The pitch (1 min)

☐ Top right → **Pitch**. Five slides, arrow keys or the buttons.
☐ Slide 3 shows the **real ablation table** including the p90, and says
"every log is simulated".
☐ Slide 5 marks the drift row **PARTIAL**, not DONE.

---

## 9 · Things that must not crash (2 min)

☐ Deny location permission → a clean message, app still runs.
☐ Switch source repeatedly, fast → no crash, no stuck state.
☐ Rotate the phone → layout survives.
☐ Background the app for 30 s, return → no crash.
☐ Aeroplane mode on **before** opening the app → still opens, map may be blank.

---

## 10 · The two measurements only you can make

These need a phone and a stopwatch — no test can do them.

☐ **Battery.** Note %, run the simulation continuously for 30 minutes with the
screen on, note % again. Record the drop in `PROJECT_STATUS.md`.
☐ **Backup recording.** Screen-record one clean full run (§2) and keep the file
somewhere that does not need a network to reach.

---

## Reporting a failure

Note the **step number**, what you saw, and grab Debug → EVENTS → **Export
JSON** if the engine was involved. That log timestamps every transition and is
usually enough to find the cause without reproducing it.

---

## Desk checks (no phone)

```bash
pnpm -r test              # 1112 tests
pnpm -r typecheck
pnpm lint:core-purity     # nav-core must stay pure
pnpm ablation             # regenerates the table; full row must read 10.0%
pnpm eval -- --log sim_city_1337.jsonl --config full
```

☐ All green, and the ablation's `full` row still reads **10.0% mean / 22.6% p90**.
