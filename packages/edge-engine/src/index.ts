/**
 * @pathpulse/edge-engine — Phase 16, the edge-deployable software engine.
 *
 * ★ ONE NAVIGATION CORE, TWO DEPLOYMENT TARGETS ★
 *
 *     nav-core (pure TypeScript)
 *        ├─→ Capacitor APK      phone MEMS,   ~10 Hz
 *        └─→ Node edge engine   external IMU, ~200 Hz
 *
 * The problem statement requires both, and calls them a single deliverable:
 * "a working mobile application AND an Edge deployable software engine".
 *
 * This package contains no navigation mathematics of its own. That is the
 * point: it is adapters, a driven loop and a report. Every line of estimation
 * lives in nav-core and is byte-for-byte the code the handset runs, which is
 * what Golden Rule #1 was protecting all along.
 */
export * from './grades.js';
export * from './runner.js';
export * from './sources/types.js';
export * from './sources/FogSimulatorSource.js';
export * from './sources/ReplayFileSource.js';
