import { describe, expect, it } from 'vitest';
import type { NavMode } from '@pathpulse/nav-core';
import { MODE_COLORS, MODE_LABELS } from './modes';

const ALL_MODES: NavMode[] = [
  'INITIALIZING',
  'GNSS',
  'GNSS_DEGRADED',
  'DEAD_RECKONING',
  'RECOVERING',
  'ERROR',
];

describe('mode colours and labels', () => {
  it('covers every NavMode', () => {
    // A missing entry renders as `undefined` and the marker turns invisible.
    for (const mode of ALL_MODES) {
      expect(MODE_COLORS[mode], `colour for ${mode}`).toBeDefined();
      expect(MODE_LABELS[mode], `label for ${mode}`).toBeDefined();
    }
    expect(Object.keys(MODE_COLORS)).toHaveLength(ALL_MODES.length);
  });

  it('uses valid 6-digit hex, which MapLibre paint expressions require', () => {
    for (const mode of ALL_MODES) {
      expect(MODE_COLORS[mode]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('gives every mode a visually distinct colour', () => {
    // Two modes sharing a colour makes the trail unreadable — the whole point
    // of colouring it is telling estimated stretches from fixed ones.
    const colours = ALL_MODES.map((m) => MODE_COLORS[m].toLowerCase());
    expect(new Set(colours).size).toBe(ALL_MODES.length);
  });

  it('keeps the demo-critical colours where a judge expects them', () => {
    expect(MODE_COLORS.GNSS).toBe('#22c55e'); // green
    expect(MODE_COLORS.DEAD_RECKONING).toBe('#f97316'); // orange
    expect(MODE_COLORS.RECOVERING).toBe('#3b82f6'); // blue
  });

  it('has non-empty labels', () => {
    for (const mode of ALL_MODES) {
      expect(MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
  });
});
