import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourcePicker from './SourcePicker';

/**
 * Choosing where the data comes from.
 *
 * ★ WHAT THIS REPLACED, AND WHY ★
 * A dropdown plus a Play button somewhere else in the same panel. Switching to
 * live sensors took four taps and the fourth was easy to miss, so "I chose
 * Live and nothing happened" was the commonest way to conclude the app was
 * broken. The panel also had no real close — its ✕ collapsed it to a pill that
 * sat on top of the Demo button for ever.
 */

afterEach(cleanup);

function renderPicker(over: Partial<React.ComponentProps<typeof SourcePicker>> = {}) {
  const onPick = vi.fn();
  const onPlay = vi.fn();
  const onPause = vi.fn();
  const onReset = vi.fn();
  const onRouteChange = vi.fn();
  render(
    <SourcePicker
      kind="simulation"
      routeKey="city"
      isRunning={false}
      progress={0.3}
      sourceName="Simulation (city)"
      onPick={onPick}
      onRouteChange={onRouteChange}
      onPlay={onPlay}
      onPause={onPause}
      onReset={onReset}
      {...over}
    />,
  );
  return { onPick, onPlay, onPause, onReset, onRouteChange };
}

describe('SourcePicker', () => {
  it('offers all three sources with a line explaining each', () => {
    renderPicker();
    expect(screen.getByText('This phone')).toBeDefined();
    expect(screen.getByText('Simulated drive')).toBeDefined();
    expect(screen.getByText('Recorded run')).toBeDefined();
    expect(screen.getByText(/Your real GPS and motion sensors/i)).toBeDefined();
  });

  it('★ picking live is one tap, not four', () => {
    // The whole point. Selecting a source is an explicit "run this".
    const { onPick } = renderPicker();
    fireEvent.click(screen.getByText('This phone'));
    expect(onPick).toHaveBeenCalledWith('live');
  });

  it('picking the recorded backup is one tap too', () => {
    const { onPick } = renderPicker();
    fireEvent.click(screen.getByText('Recorded run'));
    expect(onPick).toHaveBeenCalledWith('replay');
  });

  it('marks which source is active, and whether it is running', () => {
    cleanup();
    renderPicker({ kind: 'live', isRunning: true });
    expect(screen.getByText('running')).toBeDefined();
    cleanup();
    renderPicker({ kind: 'live', isRunning: false });
    expect(screen.getByText('selected')).toBeDefined();
  });

  it('still offers Start, Pause and Restart', () => {
    const { onPlay, onReset } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    expect(onPlay).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(onReset).toHaveBeenCalled();

    cleanup();
    const { onPause } = renderPicker({ isRunning: true });
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(onPause).toHaveBeenCalled();
  });

  it('shows the route chooser only for the simulation', () => {
    renderPicker();
    expect(screen.getByText(/route/i)).toBeDefined();
    cleanup();
    renderPicker({ kind: 'live' });
    expect(screen.queryByText(/^route$/i)).toBeNull();
  });

  it('★ tells you to announce the replay as a replay', () => {
    renderPicker({ kind: 'replay' });
    expect(screen.getByText(/Announce this as a replay/i)).toBeDefined();
  });

  it('does not show a progress bar for live sensors, which have no end', () => {
    renderPicker({ kind: 'live' });
    expect(screen.queryByText(/Announce/i)).toBeNull();
  });
});
