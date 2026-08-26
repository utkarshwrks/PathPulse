import { describe, expect, it } from 'vitest';
import { deriveMode, DEGRADED_ACCURACY_M } from './navMode';

describe('deriveMode', () => {
  it('is INITIALIZING with no fix', () => {
    expect(deriveMode(null)).toBe('INITIALIZING');
    expect(deriveMode(undefined)).toBe('INITIALIZING');
  });

  it('is GNSS for a good fix', () => {
    expect(deriveMode(4.2)).toBe('GNSS');
    expect(deriveMode(0)).toBe('GNSS');
  });

  it('is GNSS_DEGRADED above the accuracy threshold', () => {
    expect(deriveMode(DEGRADED_ACCURACY_M + 0.1)).toBe('GNSS_DEGRADED');
    expect(deriveMode(31)).toBe('GNSS_DEGRADED');
  });

  it('treats the threshold itself as still good', () => {
    // Boundary is exclusive: 25 m is acceptable, 25.1 m is not.
    expect(deriveMode(DEGRADED_ACCURACY_M)).toBe('GNSS');
  });

  it('does not emit a mode from garbage accuracy', () => {
    // A NaN leaking through must not colour the marker green.
    expect(deriveMode(NaN)).toBe('INITIALIZING');
    expect(deriveMode(Number.POSITIVE_INFINITY)).toBe('INITIALIZING');
  });
});
