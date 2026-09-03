/**
 * Phase 11 — the error-state Kalman filter.
 *
 * `matrix.ts` is deliberately NOT re-exported flat: it owns names like `add`,
 * `mul` and `scale`, and nav-core's index re-exports every module into one
 * namespace. Reach it as `matrix.inverse(...)`, or import the file directly in
 * a test.
 */
export * as matrix from './matrix.js';
export * from './quaternion.js';
export * from './noise.js';
export * from './ErrorStateKalmanFilter.js';
