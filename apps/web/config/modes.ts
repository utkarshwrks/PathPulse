import type { NavMode } from '@pathpulse/nav-core';

/**
 * Single source of truth for mode colours.
 *
 * The badge, the vehicle marker and the trail all read from here, so they can
 * never disagree about what "orange" means. tailwind.config.ts imports this
 * too. If a judge sees an orange trail behind a green marker, the demo reads
 * as broken regardless of whether the math is right.
 */
export const MODE_COLORS: Record<NavMode, string> = {
  INITIALIZING: '#64748b',
  GNSS: '#22c55e',
  GNSS_DEGRADED: '#eab308',
  DEAD_RECKONING: '#f97316',
  RECOVERING: '#3b82f6',
  ERROR: '#ef4444',
};

export const MODE_LABELS: Record<NavMode, string> = {
  INITIALIZING: 'ACQUIRING',
  GNSS: 'GNSS',
  GNSS_DEGRADED: 'GNSS DEGRADED',
  DEAD_RECKONING: 'DEAD RECKONING',
  RECOVERING: 'RECOVERING',
  ERROR: 'ERROR',
};
