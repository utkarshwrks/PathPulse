import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PitchScreen from './PitchScreen';
import { COMPLIANCE, PITCH_SLIDES } from '@/lib/pitch';
import type { BenchmarkData } from './Benchmarks';

/**
 * The pitch deck.
 *
 * The compliance slide is a line-by-line claim against the problem statement,
 * made to the people who wrote it. Most of what is tested here is that the
 * deck cannot overstate the build — the guide's own version of this table
 * marks every row Done, and several of those rows are not true of us.
 */

const DATA: BenchmarkData = {
  generatedFrom: ['sim_city_1337.jsonl'],
  windows: [{ startMs: 30_000, durationMs: 60_000 }],
  rows: [
    {
      config: 'naive', description: 'x', runs: 12, meanDriftPct: 61.2, medianDriftPct: 57.7,
      p90DriftPct: 81.0, maxDriftPct: 81.0, meanRmseM: 358, meanAlongM: 305, meanCrossM: 181,
      meanCep95M: 625, meanRecoveryS: 1, meanUpdateHz: 50, totalZupt: 0, roadSnapPct: 0,
      positionResets: 0,
    },
    {
      config: 'full', description: 'y', runs: 12, meanDriftPct: 10.0, medianDriftPct: 6.4,
      p90DriftPct: 22.6, maxDriftPct: 27.4, meanRmseM: 72, meanAlongM: 52, meanCrossM: 46,
      meanCep95M: 120, meanRecoveryS: 3, meanUpdateHz: 50, totalZupt: 3, roadSnapPct: 100,
      positionResets: 0,
    },
  ],
};

afterEach(cleanup);

function open(data: BenchmarkData | null = DATA) {
  const onClose = vi.fn();
  render(<PitchScreen onClose={onClose} data={data} />);
  return onClose;
}

function goTo(id: string) {
  const target = PITCH_SLIDES.findIndex((s) => s.id === id);
  for (let i = 0; i < target; i++) {
    fireEvent.keyDown(window, { key: 'ArrowRight' });
  }
}

describe('PitchScreen', () => {
  it('opens on the problem slide', () => {
    open();
    expect(screen.getByText(/blue dot freezes/i)).toBeDefined();
    expect(screen.getByText('1 / 5')).toBeDefined();
  });

  it('navigates with arrow keys and buttons', () => {
    open();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 5')).toBeDefined();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('1 / 5')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('2 / 5')).toBeDefined();
  });

  it('does not run off either end', () => {
    open();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('1 / 5')).toBeDefined();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('5 / 5')).toBeDefined();
  });

  it('closes on Escape', () => {
    const onClose = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('★ shows the real ablation numbers, including the p90', () => {
    open();
    goTo('results');
    expect(screen.getByText('10.0')).toBeDefined();
    expect(screen.getByText('22.6')).toBeDefined();
  });

  it('★ says the logs are simulated, on the results slide itself', () => {
    // The number and the caveat have to travel together. A judge reading
    // "10.0%" without "simulated" next to it has been misled by omission.
    open();
    goTo('results');
    expect(screen.getByText(/Every log is simulated/i)).toBeDefined();
  });

  it('★ refuses to invent numbers when the table is missing', () => {
    open(null);
    goTo('results');
    expect(screen.getByText(/will not invent numbers/i)).toBeDefined();
  });

  it('★ marks the drift requirement PARTIAL, not DONE', () => {
    // 10.0% mean is ON the <10% line, not under it, and the p90 is 22.6%.
    // The build guide's version of this table marks it Done. It is not.
    open();
    goTo('compliance');
    const drift = COMPLIANCE.find((r) => r.requirement.includes('Drift'))!;
    expect(drift.status).toBe('PARTIAL');
    expect(screen.getByText(/on the line, not under it/i)).toBeDefined();
  });

  it('shows a status badge and a defensible sentence for every requirement', () => {
    open();
    goTo('compliance');
    for (const row of COMPLIANCE) {
      expect(screen.getByText(row.requirement)).toBeDefined();
      expect(row.detail.length).toBeGreaterThan(25);
    }
  });

  it('summarises the tally so nothing is buried', () => {
    open();
    goTo('compliance');
    expect(screen.getByText(/\d+ done · \d+ partial · \d+ Part B/)).toBeDefined();
  });
});

describe('the compliance table itself', () => {
  it('★ never claims DONE without a sentence that survives a follow-up', () => {
    for (const row of COMPLIANCE) {
      expect(row.detail.trim().length).toBeGreaterThan(25);
      expect(row.detail.toLowerCase()).not.toBe('done');
    }
  });

  it('is honest about what is Part B rather than omitting it', () => {
    const partB = COMPLIANCE.filter((r) => r.status === 'PART_B');
    expect(partB.length).toBeGreaterThan(0);
    for (const row of partB) expect(row.detail).toMatch(/Part B/);
  });
});
