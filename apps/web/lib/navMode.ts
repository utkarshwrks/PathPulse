import type { NavMode } from '@pathpulse/nav-core';

/**
 * Accuracy thresholds for the Phase 1 display mode.
 * Phase 4's real state machine uses these same numbers with hysteresis, so
 * they live here as named constants rather than magic numbers in a component.
 */
export const DEGRADED_ACCURACY_M = 25;

/**
 * Phase 1 display mode, derived purely from reported fix accuracy.
 *
 * Deliberately thin and deliberately stateless: this is a stand-in so the
 * marker and trail have an honest mode to render today. The real transitions
 * (hysteresis, dead reckoning, recovery) are Phase 4 and belong in nav-core.
 */
export function deriveMode(accuracyM: number | null | undefined): NavMode {
  if (accuracyM === null || accuracyM === undefined) return 'INITIALIZING';
  if (!Number.isFinite(accuracyM)) return 'INITIALIZING';
  if (accuracyM > DEGRADED_ACCURACY_M) return 'GNSS_DEGRADED';
  return 'GNSS';
}
