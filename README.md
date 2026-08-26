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

**Phase 1 complete** — full-screen MapLibre basemap, live GNSS marker that
rotates with heading, and a travelled trail coloured per navigation mode.
See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) for the live picture and what is
next.

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
| `pnpm test` | All workspace tests (70) |
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

### Testing on a phone (before the Phase 3 APK)

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

### Development without GPS

`http://localhost:3000/?mock=1` drives a synthetic track so the map, marker and
trail can be exercised on a laptop with no GPS fix. It cycles through GNSS →
degraded → dead reckoning → recovering so the trail's mode colouring is visible.
This is a Phase 1 stopgap — Phase 2 replaces it with the real `SimulationSource`,
which models IMU noise, bias and vibration behind the `SensorSource` interface.

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
