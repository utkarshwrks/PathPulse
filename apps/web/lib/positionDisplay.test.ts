import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSITION_DISPLAY_THRESHOLDS as T,
  positionDisplay,
} from './positionDisplay';

describe('positionDisplay', () => {
  it('draws a plain point while the estimate is worth a point', () => {
    const d = positionDisplay(4, 4);
    expect(d.kind).toBe('POINT');
    expect(d.showMarker).toBe(true);
    expect(d.showBand).toBe(false);
    expect(d.notice).toBeNull();
  });

  it('★ the field reading — 88/5 m — is a band, not an arrow', () => {
    // The HUD said `uncert. 88/5 m` and the map drew a crisp arrow at a point.
    // That gap is the whole of what the rider means by misleading.
    const d = positionDisplay(88, 5);
    expect(d.kind).toBe('BAND');
    expect(d.showMarker).toBe(false);
    expect(d.bandLengthM).toBe(176);
    expect(d.notice).toBe('position uncertain — ±90 m along road');
  });

  it('shows both through the middle band', () => {
    const d = positionDisplay(40, 5);
    expect(d.kind).toBe('POINT_AND_BAND');
    expect(d.showMarker).toBe(true);
    expect(d.showBand).toBe(true);
    expect(d.bandLengthM).toBe(80);
    expect(d.notice).toBeNull();
  });

  it('★ keys on the semi-MAJOR axis, which is the one that grows', () => {
    // Road snapping bounds cross-track; along-track grows without limit. 88/5
    // is a 176 m smear along the road, not a blob 88 m across.
    expect(positionDisplay(88, 5).kind).toBe('BAND');
    // And it is symmetric: whichever axis is larger decides.
    expect(positionDisplay(5, 88).kind).toBe('BAND');
  });

  it('switches exactly at the thresholds, not around them', () => {
    expect(positionDisplay(T.pointMaxM, 1).kind).toBe('POINT');
    expect(positionDisplay(T.pointMaxM + 0.01, 1).kind).toBe('POINT_AND_BAND');
    expect(positionDisplay(T.bandOnlyM, 1).kind).toBe('POINT_AND_BAND');
    expect(positionDisplay(T.bandOnlyM + 0.01, 1).kind).toBe('BAND');
  });

  it('an unpopulated covariance is not read as a large error', () => {
    // Every session starts with NaN, and that is not evidence of anything.
    for (const bad of [NaN, undefined as unknown as number, -5]) {
      expect(positionDisplay(bad, bad).kind).toBe('POINT');
    }
  });

  it('rounds the notice, because it is an estimate of an estimate', () => {
    expect(positionDisplay(87.9, 5).notice).toBe('position uncertain — ±90 m along road');
    expect(positionDisplay(112, 5).notice).toBe('position uncertain — ±110 m along road');
  });

  it('the band always covers roughly 95% of where the vehicle might be', () => {
    for (const s of [26, 50, 88, 300]) {
      expect(positionDisplay(s, 4).bandLengthM).toBeCloseTo(2 * s, 6);
    }
  });

  it('never emits a band length that is not a finite length', () => {
    for (const [a, c] of [[NaN, NaN], [Infinity, 5], [0, 0]] as const) {
      const d = positionDisplay(a, c);
      expect(Number.isFinite(d.bandLengthM)).toBe(true);
      expect(d.bandLengthM).toBeGreaterThanOrEqual(0);
    }
  });
});
