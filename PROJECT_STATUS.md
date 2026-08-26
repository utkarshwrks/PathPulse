# PROJECT STATUS

**CURRENT PHASE:** Phase 0 — Environment Setup & Repo Skeleton ✅ COMPLETE
**LAST UPDATED:** 2026-08-26
**NEXT PHASE:** Phase 1 — Map + Live GNSS Marker

---

## COMPLETED

### Phase 0 — Environment Setup & Repo Skeleton

**Monorepo**
- pnpm workspace (`pnpm-workspace.yaml`) over `apps/*` and `packages/*`
- Shared `tsconfig.base.json`: ES2022, `strict`, `noUncheckedIndexedAccess`
- `.gitignore` covering node_modules, `.next/`, `out/`, `android/`, APKs,
  Python artefacts, model binaries and large map data

**`packages/nav-core`** — the pure package
- `src/types.ts` — `NavMode`, `SensorSample`, `NavigationState`, `LatLon`,
  `EnuPoint`, `Vec3`, `Quaternion`
- `src/geo/constants.ts` — WGS84 ellipsoid parameters
- `src/geo/angles.ts` — `normalizeAngle` (-180, 180], `normalizeAngle360`,
  `normalizeRadians`, `angleDifference`
- `src/geo/enu.ts` — `latLonToEcef`, `ecefToLatLon` (Bowring),
  `latLonToEnu`, `enuToLatLon`
- `src/geo/distance.ts` — `haversineDistance`, `bearingDeg`
- Vitest configured, node environment, **18 tests passing**

**`packages/sensor-sources`** — `SensorSource` interface + capabilities type.
Implementations arrive in Phase 2.

**`packages/eval`** — placeholder. Built in Phase 7.

**`apps/web`** — Next.js 14 App Router
- `output: 'export'` set on day one, `images.unoptimized: true`
- Tailwind configured, mode colours (`gnss`/`degraded`/`dr`/`recovering`)
  defined once so badge, marker and trail can never disagree
- All client-side. No server components, no API routes.
- Landing page renders live `nav-core` output as a wiring self-check

**Tooling**
- `scripts/check-core-purity.mjs` — mechanically enforces Golden Rule #1

## HOW TO RUN

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

## HOW TO TEST

```bash
pnpm test                # 18/18 nav-core tests pass
pnpm typecheck           # clean across all 4 packages
pnpm lint:core-purity    # "nav-core is pure — scanned 7 file(s), 0 violations"
pnpm build               # emits apps/web/out/{index.html,404.html,_next}
```

Verified on 2026-08-26:
- `pnpm dev` serves HTTP 200 and renders India Gate → Red Fort as **4943.8 m**
  (real-world ≈ 4.94 km) with an ENU round-trip error under 0.001 mm
- `pnpm build` produces the static `out/` folder Capacitor will wrap in Phase 3

## ARCHITECTURE NOTES

- **Golden Rule #1:** `nav-core` is pure TypeScript. No `window`, `document`,
  `fetch`, `navigator`, React or Node APIs. It is what lets one codebase serve
  the browser, the APK, the replay/ablation harness, and the Part B 200 Hz edge
  engine. Enforced by `pnpm lint:core-purity`.
- **ENU over degrees:** dead reckoning integrates m/s, so the math runs in a
  local East-North-Up plane in metres and converts back only for display.
- **`.js` import specifiers in `nav-core`** are intentional — real ESM requires
  them and Node will need them verbatim for the edge engine. `next.config.js`
  carries a `resolve.extensionAlias` mapping `.js → .ts` so webpack resolves
  them. Do not "fix" this by stripping the extensions.
- **`transpilePackages`** lets Next compile the workspace packages from source,
  so there is no build step and no stale `dist/` to debug.
- **Static export from day one** means an accidental server component fails the
  build today rather than on demo day.
- **Covariance is along/cross, not a radius.** Road snapping bounds cross-track
  error while along-track error keeps growing. That asymmetry is why the UI will
  draw an ellipse, not a circle.

## KNOWN ISSUES

- `pnpm start` uses `npx serve out`; `serve` is not a declared dependency and is
  fetched on demand. Fine for local checks, worth pinning if it becomes routine.
- System Python is 3.9.15. Phase 8 (PyTorch, ONNX export) wants 3.10+. The guide
  points that phase at Colab, so this only matters if we train locally.
- Nothing is wired to real sensors yet — Phase 1 adds geolocation, Phase 2 adds
  the simulation source.

## NEXT PHASE

**Phase 1 — Map + Live GNSS Marker** (2 hr)
- MapLibre GL JS full-screen dark map, tile URL behind `apps/web/config/map.ts`
  so Phase 9 can swap in offline PMTiles
- `VehicleMarker` — heading-rotated arrow, colour by mode, CSS transitions
- `TrailLayer` — GeoJSON LineString, last 500 points, **segment colour by mode**
  so the estimated stretch is visually obvious
- `hooks/useGeolocation.ts` — `watchPosition`, high accuracy, graceful denial
- Status readout: satellite count and accuracy
