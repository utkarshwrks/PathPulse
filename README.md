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

**Phase 0 complete** — monorepo, pure `nav-core` package, WGS84 geodesy with
tests, static-export web app. See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) for
the live picture and what is next.

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
| `pnpm test` | All workspace tests |
| `pnpm typecheck` | `tsc --noEmit` across every package |
| `pnpm lint:core-purity` | **Enforces Golden Rule #1** (see below) |

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
