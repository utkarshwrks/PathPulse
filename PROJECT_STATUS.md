# PROJECT STATUS

**CURRENT PHASE:** Phase 1 — Map + Live GNSS Marker ✅ COMPLETE
**LAST UPDATED:** 2026-08-26
**NEXT PHASE:** Phase 2 — nav-core + Sensor Abstraction + Simulation

---

## COMPLETED

### Phase 0 — Environment Setup & Repo Skeleton
- pnpm monorepo (`apps/*`, `packages/*`), shared strict `tsconfig.base.json`
- `packages/nav-core` — pure TS: `types.ts` (`NavMode`, `SensorSample`,
  `NavigationState`) and `geo/` (WGS84 ECEF/ENU via Bowring, haversine,
  bearing, angle normalisation)
- `packages/sensor-sources` — `SensorSource` interface
- `packages/eval` — placeholder (Phase 7)
- `apps/web` — Next.js 14 App Router, `output: 'export'`, Tailwind
- `scripts/check-core-purity.mjs` — enforces Golden Rule #1

### Phase 1 — Map + Live GNSS Marker

**`packages/nav-core/src/trail/`** — pure, unit-tested trail logic
- `appendTrailPoint()` — jitter filter (0.5 m) + 500-point ring buffer.
  A mode change always forces the point to be kept, so the trail can never
  recolour at the wrong place.
- `buildTrailSegments()` — splits into per-mode runs. **Segments share their
  boundary vertex**, otherwise the rendered line gaps at every mode change.
- `trailDistanceM()` — summed leg lengths
- 15 tests covering jitter, capping, immutability, NaN rejection, the full
  GNSS → DR → RECOVERING → GNSS sequence, and `[lon, lat]` ordering

**`apps/web/config/`**
- `map.ts` — `resolveMapStyle()` returns MapTiler dark when
  `NEXT_PUBLIC_MAPTILER_KEY` is set, else OpenStreetMap raster. Single seam for
  the Phase 9 offline PMTiles swap.
- `modes.ts` — `MODE_COLORS` / `MODE_LABELS`, the single source of truth.
  `tailwind.config.ts` imports it rather than keeping a second copy.

**`apps/web/hooks/`**
- `useGeolocation.ts` — `watchPosition`, `enableHighAccuracy`, `maximumAge: 0`,
  `timeout: 5000`. Distinguishes denied / unavailable / timeout; a timeout keeps
  the watch alive (expected indoors) while a denial tears it down.
- `useMockTrack.ts` — dev-only `?mock=1` synthetic track (**see Known Issues**)

**`apps/web/components/`**
- `MapView.tsx` — MapLibre, dynamically imported with `ssr: false` (it touches
  `window` at import time and the app is statically exported). Degrades to a
  message instead of crashing if the map fails.
- `VehicleMarker.tsx` — heading-rotated arrow, colour by mode, CSS-transitioned.
  Keeps the last heading when the platform reports `null` (stationary) rather
  than snapping to north. Accuracy halo — Phase 9 replaces it with a real
  covariance ellipse.
- `TrailLayer.tsx` — one line layer, colour from a data-driven `match`
  expression, so layer count stays constant however often the mode flips.
- `StatusBar.tsx`, `PermissionGate.tsx`, `MapContext.tsx`

## HOW TO RUN

```bash
pnpm install
pnpm dev                              # http://localhost:3000
# no GPS on this machine? drive a synthetic track:
open http://localhost:3000/?mock=1
```

Optional vector dark basemap — `apps/web/.env.local`:
```
NEXT_PUBLIC_MAPTILER_KEY=your_key_here
```

## HOW TO TEST ON A PHONE

Same Wi-Fi, then `pnpm dev:lan` and open `http://<lan-ip>:3000/?mock=1`.
That exercises map, marker and trail without needing a fix.

**Real GPS will not work over plain-HTTP LAN.** Browsers gate
`navigator.geolocation` behind a secure context (HTTPS or `localhost`), so an
`http://192.168.x.x` origin gets no API at all — the app correctly shows its
unsupported screen. Workarounds and their trade-offs are in the README; the
real fix is the Phase 3 APK, which uses native permissions.

`pnpm dev:https` does not help: mkcert needs an interactive sudo prompt, and the
certificate it generates covers only `localhost`/`127.0.0.1`, not the LAN IP.

## HOW TO TEST

```bash
pnpm test                # 70/70 pass
pnpm typecheck           # clean across 4 packages
pnpm lint:core-purity    # 0 violations across 8 files
pnpm build               # emits apps/web/out
```

| Package | Tests | Covers |
| --- | --- | --- |
| `nav-core` | 33 | geodesy (18), trail buffer + segments (15) |
| `apps/web` | 37 | geolocation hook (14), map config (11), mode colours (6), mode derivation (5), mock script (3) |

`apps/web` runs Vitest under jsdom with `@testing-library/react`, so the
geolocation hook is tested against a mocked `navigator.geolocation` — including
denial, timeout and unsupported-browser paths that are awkward to reproduce by
hand and fatal if they crash during a demo.

Verified in a real browser on 2026-08-26 against the **production static
export** (the same bundle Capacitor will wrap):
- 77 OSM tiles fetched, attribution rendered
- marker present, colour `rgb(249,115,22)` = `DEAD_RECKONING` orange,
  `transform: rotate(140deg)` matching a reported heading of 140°
- trail visibly segmented green → amber → orange → blue across mode changes
- map follows the marker; manual pan disengages follow and shows Recenter

## ARCHITECTURE NOTES

- **Golden Rule #1 holds.** All browser APIs (`navigator.geolocation`,
  MapLibre, DOM) live in `apps/web`. `nav-core` gained only pure trail math.
- **Trail logic lives in nav-core on purpose.** Segment splitting is pure data
  transformation, so it is unit tested rather than eyeballed on a map. The
  boundary-vertex rule in particular is the kind of thing that silently breaks.
- **`dynamic(..., { ssr: false })` is mandatory for MapView** — MapLibre touches
  `window` at import time and `output: 'export'` prerenders in Node.
- **MapLibre is pinned to 5.24.0.** See Known Issues — this is a risk choice,
  not a bug fix.
- **Mode colour has one home** (`config/modes.ts`). A green marker over an
  orange trail reads as a broken demo regardless of whether the math is right.
- **`deriveMode` lives in `lib/navMode.ts`, not inside the page component**, so
  the accuracy thresholds are unit tested rather than buried in JSX. Phase 4
  supersedes it with the real hysteresis machine in nav-core.
- **The geolocation hook guards on `navigator.geolocation` truthiness, not
  `'geolocation' in navigator`.** The property can exist holding `undefined` in
  insecure contexts and some embedded webviews; the `in` check passes there and
  the next line throws. Found by the unsupported-browser test.

## KNOWN ISSUES

- **`useMockTrack` / `?mock=1` is a stopgap.** It fabricates positions and
  scripts mode changes on a timer. It is *not* a physics simulation and must not
  be used for any accuracy claim. Phase 2's `SimulationSource` replaces it with
  proper IMU noise, bias, vibration and stop modelling behind `SensorSource`.
  Delete `useMockTrack.ts` once Phase 2 lands.
- **MapLibre pinned to 5.24.0 while 6.6.0 is `latest`.** During Phase 1 the map
  never rendered and v6 was initially blamed. That diagnosis was wrong: the real
  cause was that the automation browser tab is permanently
  `visibilityState: "hidden"`, so `requestAnimationFrame` never fires and
  MapLibre's rAF-deferred style load never completes. Both v5 and v6 were
  verified working once rAF was shimmed. v5 is retained because it is verified
  end-to-end in this Next 14 stack and nothing here needs v6; v6's separate
  ESM worker chunk under Next/webpack bundling remains **untested**, not broken.
  Revisit deliberately, not by accident.
- **Satellite count is unavailable on web.** The browser Geolocation API exposes
  accuracy but not satellite count or constellation. The status bar says so
  rather than showing a fake number. Real values need the native `GnssStatus`
  API in Phase 15.
- Browser geolocation gives speed/heading only when the platform supplies them;
  both read `—` when stationary or unsupported.
- Do not run `pnpm build` while `pnpm dev` is live — the build clobbers `.next`
  and the dev server then serves an unstyled page.
- System Python is 3.9.15; Phase 8 wants 3.10+ (guide points that at Colab).

## NEXT PHASE

**Phase 2 — nav-core + Sensor Abstraction + Simulation** (3 hr)
- `SensorSource` implementations: `SimulationSource` (realistic IMU — gravity,
  Gaussian noise, constant bias, 15–25 Hz vibration, red-light stops),
  `WebSource`, `ReplaySource`, `RecordingWrapper`
- `simulateGnssOutage(startMs, durationMs)`
- Two GeoJSON routes in `data/routes/`: 2 km city (4 turns, 3 stops),
  3 km highway
- Source selector UI with play/pause/reset and 1×–5× speed
- **Delete `useMockTrack.ts`** — superseded
