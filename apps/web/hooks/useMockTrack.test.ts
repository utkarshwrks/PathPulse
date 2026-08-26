import { describe, expect, it } from 'vitest';
import { mockModeForTick } from './useMockTrack';

/**
 * The mock exists only to exercise rendering. What matters is that it walks
 * the full mode sequence, so the trail's segment colouring is actually
 * covered during development.
 */
describe('mockModeForTick', () => {
  it('walks the whole demo sequence', () => {
    const seen: string[] = [];
    for (let t = 0; t < 100; t++) {
      const m = mockModeForTick(t);
      if (seen[seen.length - 1] !== m) seen.push(m);
    }
    expect(seen).toEqual([
      'GNSS',
      'GNSS_DEGRADED',
      'DEAD_RECKONING',
      'RECOVERING',
      'GNSS',
    ]);
  });

  it('starts in GNSS and ends back in GNSS', () => {
    expect(mockModeForTick(0)).toBe('GNSS');
    expect(mockModeForTick(10_000)).toBe('GNSS');
  });

  it('spends the longest stretch in dead reckoning', () => {
    const counts = new Map<string, number>();
    for (let t = 0; t < 68; t++) {
      const m = mockModeForTick(t);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const longest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(longest).toBe('DEAD_RECKONING');
  });
});
