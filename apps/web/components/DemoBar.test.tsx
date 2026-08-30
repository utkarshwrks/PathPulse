import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DemoBar from './DemoBar';
import { demoPositionAt } from '@/lib/demoScript';

/**
 * The demo banner.
 *
 * Its second job is the one that matters: stating on screen that the outage is
 * triggered by the script rather than by a tunnel. A judge who works that out
 * for themselves stops believing the rest of the screen.
 */

afterEach(cleanup);

function renderBar(elapsedMs: number, running = true) {
  const onStart = vi.fn();
  const onReset = vi.fn();
  const onStop = vi.fn();
  render(
    <DemoBar
      running={running}
      elapsedMs={elapsedMs}
      position={demoPositionAt(elapsedMs)}
      onStart={onStart}
      onReset={onReset}
      onStop={onStop}
    />,
  );
  return { onStart, onReset, onStop };
}

describe('DemoBar', () => {
  it('is a single button before the demo starts', () => {
    const { onStart } = renderBar(0, false);
    fireEvent.click(screen.getByRole('button', { name: /demo/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it('★ says the outage is scripted, unprompted', () => {
    // Golden Rule #8. The physics and the estimate are real; the timing is
    // ours, and saying so first is what makes the rest credible.
    renderBar(20_000);
    expect(screen.getByText(/triggered\s+by this script, not by a tunnel/i)).toBeDefined();
    expect(screen.getByText(/Scripted run on the simulator/i)).toBeDefined();
  });

  it('names the phase and what to point at', () => {
    renderBar(20_000);
    expect(screen.getByText(/Outage — dead reckoning/)).toBeDefined();
    expect(screen.getByText(/ellipse stretch forward/i)).toBeDefined();
  });

  it('shows the clock against the total', () => {
    renderBar(15_000);
    expect(screen.getByText('0:15 / 1:20')).toBeDefined();
  });

  it('walks through every phase without breaking', () => {
    for (const t of [0, 15_000, 75_000, 80_000]) {
      cleanup();
      renderBar(t);
      expect(screen.getByText(/Scripted run/i)).toBeDefined();
    }
  });

  it('offers restart and exit while running', () => {
    const { onReset, onStop } = renderBar(30_000);
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(onReset).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /exit demo/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
