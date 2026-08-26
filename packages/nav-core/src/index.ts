/**
 * @pathpulse/nav-core — pure navigation math.
 *
 * ★ PURITY RULE ★
 * Nothing in this package may touch window, document, fetch, navigator,
 * localStorage, React, or any Node runtime API. Pure functions only.
 * Sensors live in @pathpulse/sensor-sources. UI lives in @pathpulse/web.
 * Enforced by `pnpm lint:core-purity`.
 *
 * Phase 0: types + geodesy. The engine itself arrives in Phase 4.
 */
export * from './types.js';
export * from './geo/index.js';
export * from './trail/index.js';
