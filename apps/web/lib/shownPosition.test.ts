import { describe, expect, it } from 'vitest';
import type { NavigationState, SensorSample } from '@pathpulse/nav-core';
import { resolveShownPosition, shouldJumpCamera } from './shownPosition';

type Fix = NonNullable<SensorSample['gnss']>;

const JABALPUR: Fix = { lat: 23.1815, lon: 79.9864, accuracyM: 42 };
const DELHI_DEFAULT = { lat: 28.6315, lon: 77.2167 };

function state(over: Partial<NavigationState> = {}): NavigationState {
  return {
    t: 1000,
    mode: 'GNSS',
    position: { lat: 23.1815, lon: 79.9864 },
    velocityMps: 5,
    headingDeg: 90,
    covariance: { alongM: 6, crossM: 6, headingDeg: 2 },
    confidence: 1,
    distanceTravelledM: 10,
    timeSinceGnssMs: 0,
    estimatedDriftM: 0,
    biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    ...over,
  };
}

describe('resolveShownPosition — the "Live does not find me" regression', () => {
  it('★ shows a raw fix while the engine is still ACQUIRING', () => {
    // THE BUG. The engine needs two consecutive fixes at 20 m or better to
    // leave INITIALIZING. This fix is 42 m, so on a slow receiver that may
    // never happen — and the map sat on its default centre with no marker,
    // looking like the app could not find the user at all.
    const shown = resolveShownPosition(state({ mode: 'INITIALIZING' }), JABALPUR);
    expect(shown).not.toBeNull();
    expect(shown!.lat).toBeCloseTo(23.1815, 4);
    expect(shown!.lon).toBeCloseTo(79.9864, 4);
    expect(shown!.fromEngine).toBe(false);
    expect(shown!.accuracyM).toBe(42);
  });

  it('shows a raw fix even with no engine state at all', () => {
    const shown = resolveShownPosition(null, JABALPUR);
    expect(shown?.lat).toBeCloseTo(23.1815, 4);
    expect(shown?.fromEngine).toBe(false);
  });

  it('prefers the engine once it is actually navigating', () => {
    const shown = resolveShownPosition(
      state({ mode: 'GNSS', position: { lat: 23.2, lon: 80.0 } }),
      JABALPUR,
    );
    expect(shown!.fromEngine).toBe(true);
    expect(shown!.lat).toBeCloseTo(23.2, 4);
    expect(shown!.accuracyM).toBe(6);
  });

  it('keeps showing the engine during an outage, not the stale fix', () => {
    // Dead reckoning is the whole point: the marker must follow the estimate,
    // never snap back to the last place GNSS was seen.
    const shown = resolveShownPosition(
      state({ mode: 'DEAD_RECKONING', position: { lat: 23.25, lon: 80.05 } }),
      JABALPUR,
    );
    expect(shown!.fromEngine).toBe(true);
    expect(shown!.lat).toBeCloseTo(23.25, 4);
  });

  it('returns null when nothing is known — no engine, no fix', () => {
    expect(resolveShownPosition(null, undefined)).toBeNull();
    expect(resolveShownPosition(state({ mode: 'INITIALIZING' }), undefined)).toBeNull();
  });

  it('rejects Null Island from the engine', () => {
    // With no ENU origin the engine reports (0, 0). Drawing that puts the
    // vehicle in the Gulf of Guinea.
    expect(
      resolveShownPosition(state({ position: { lat: 0, lon: 0 } }), undefined),
    ).toBeNull();
  });

  it('rejects Null Island from a fix, and falls through to it from the engine', () => {
    expect(
      resolveShownPosition(state({ mode: 'INITIALIZING' }), {
        lat: 0,
        lon: 0,
        accuracyM: 5,
      }),
    ).toBeNull();
  });

  it('rejects non-finite coordinates from either source', () => {
    expect(
      resolveShownPosition(state({ position: { lat: NaN, lon: 79.9 } }), undefined),
    ).toBeNull();
    expect(
      resolveShownPosition(state({ mode: 'INITIALIZING' }), {
        lat: Infinity,
        lon: 79.9,
        accuracyM: 5,
      }),
    ).toBeNull();
  });

  it('falls back to the fix when the engine position is unusable', () => {
    // A NaN in the engine must not blank the map when a real fix exists.
    const shown = resolveShownPosition(
      state({ mode: 'GNSS', position: { lat: NaN, lon: NaN } }),
      JABALPUR,
    );
    expect(shown!.fromEngine).toBe(false);
    expect(shown!.lat).toBeCloseTo(23.1815, 4);
  });

  it('copes with a fix carrying a non-finite accuracy', () => {
    const shown = resolveShownPosition(state({ mode: 'INITIALIZING' }), {
      lat: 23.18,
      lon: 79.98,
      accuracyM: NaN,
    });
    expect(shown!.accuracyM).toBe(0);
  });
});

describe('shouldJumpCamera', () => {
  it('jumps from the default centre to the first real fix', () => {
    // Delhi to Jabalpur is ~800 km. Easing that spends seconds flying over
    // India and reads as a hang.
    expect(shouldJumpCamera(DELHI_DEFAULT, JABALPUR)).toBe(true);
  });

  it('eases while actually following a vehicle', () => {
    expect(
      shouldJumpCamera({ lat: 23.1815, lon: 79.9864 }, { lat: 23.1817, lon: 79.9866 }),
    ).toBe(false);
  });

  it('eases across a whole city block but jumps across a city', () => {
    expect(shouldJumpCamera({ lat: 23.18, lon: 79.98 }, { lat: 23.2, lon: 80.0 })).toBe(false);
    expect(shouldJumpCamera({ lat: 23.18, lon: 79.98 }, { lat: 26.0, lon: 79.98 })).toBe(true);
  });
});
