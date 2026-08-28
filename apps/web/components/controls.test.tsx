import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceInfo from './DeviceInfo';
import PermissionGate from './PermissionGate';
import SourcePanel from './SourcePanel';

/**
 * The remaining interactive components, rendered and clicked.
 *
 * Between them these are every button a person touches during a demo other
 * than the debug panel: source selection, transport, the GNSS-loss button that
 * triggers the whole dead-reckoning story, and the screens shown when
 * something is wrong.
 */

afterEach(cleanup);

function renderSourcePanel(overrides: Partial<React.ComponentProps<typeof SourcePanel>> = {}) {
  const handlers = {
    onKindChange: vi.fn(),
    onRouteChange: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onReset: vi.fn(),
    onSpeed: vi.fn(),
    onOutage: vi.fn(),
    onDownload: vi.fn(),
  };
  const utils = render(
    <SourcePanel
      kind="simulation"
      routeKey="city"
      isRunning={false}
      inOutage={false}
      progress={0}
      imuHz={50}
      gnssHz={1}
      recordedCount={0}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...utils, ...handlers };
}

describe('SourcePanel — the demo transport', () => {
  it('offers both sources and reports the change', () => {
    const { onKindChange } = renderSourcePanel();
    const select = screen.getByDisplayValue(/simulation/i);
    fireEvent.change(select, { target: { value: 'live' } });
    expect(onKindChange).toHaveBeenCalledWith('live');
  });

  it('offers both routes and reports the change', () => {
    const { onRouteChange } = renderSourcePanel();
    const route = screen.getByDisplayValue(/city/i);
    fireEvent.change(route, { target: { value: 'highway' } });
    expect(onRouteChange).toHaveBeenCalledWith('highway');
  });

  it('shows Play when stopped and fires it', () => {
    const { onPlay } = renderSourcePanel({ isRunning: false });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('shows Pause when running and fires it', () => {
    const { onPause } = renderSourcePanel({ isRunning: true });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('fires Reset', () => {
    const { onReset } = renderSourcePanel();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('fires the GNSS-loss button — the whole demo hangs off this', () => {
    // ★ The single button that produces the dead-reckoning story. ★
    const { onOutage } = renderSourcePanel({ isRunning: true });
    fireEvent.click(screen.getByRole('button', { name: 'GNSS loss' }));
    expect(onOutage).toHaveBeenCalledTimes(1);
  });

  it('says so while an outage is already running', () => {
    renderSourcePanel({ inOutage: true });
    expect(screen.getByRole('button', { name: 'In outage' })).toBeTruthy();
  });

  it('reports playback speed changes', () => {
    const { onSpeed, container } = renderSourcePanel();
    const slider = container.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: '3' } });
    expect(onSpeed).toHaveBeenCalledWith(3);
    expect(container.textContent).toContain('3.0×');
  });

  it('offers a download only once something has been recorded', () => {
    const { onDownload } = renderSourcePanel({ recordedCount: 0 });
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
    cleanup();

    const second = renderSourcePanel({ recordedCount: 3962 });
    fireEvent.click(screen.getByRole('button', { name: /download recording/i }));
    expect(second.onDownload).toHaveBeenCalledTimes(1);
    void onDownload;
  });

  it('shows Start/Stop rather than Play/Pause for the live source', () => {
    renderSourcePanel({ kind: 'live', isRunning: false });
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    cleanup();
    renderSourcePanel({ kind: 'live', isRunning: true });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('reports measured rates rather than the nominal ones', () => {
    const { container } = renderSourcePanel({ imuHz: 37.2, gnssHz: 0.09 });
    expect(container.textContent).toContain('37.2');
    expect(container.textContent).toContain('0.09');
  });

  it('renders the live source without a route picker', () => {
    renderSourcePanel({ kind: 'live' });
    expect(screen.queryByDisplayValue(/city/i)).toBeNull();
  });
});

describe('PermissionGate — three blocked states that look identical but are not', () => {
  it('stays out of the way when nothing is blocked', () => {
    const { container } = render(
      <PermissionGate status="watching" error={null} onRetry={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('distinguishes an insecure origin from a denial', () => {
    // ★ These look the same to a user — no dot — but have completely different
    // fixes. Telling someone to "allow location" when the real problem is an
    // http:// origin sends them chasing a setting that cannot help.
    const { container } = render(
      <PermissionGate status="insecure" error={null} onRetry={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/secure|https/i);
    expect(text).not.toMatch(/denied/i);
  });

  it('explains a real denial', () => {
    const { container } = render(
      <PermissionGate status="denied" error="User denied Geolocation" onRetry={vi.fn()} />,
    );
    expect(container.textContent).toMatch(/denied|permission/i);
  });

  it('explains an unsupported browser', () => {
    const { container } = render(
      <PermissionGate status="unsupported" error={null} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toMatch(/unsupported|not available|no geolocation/i);
  });

  it('offers a retry that fires', () => {
    const onRetry = vi.fn();
    render(<PermissionGate status="denied" error={null} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the underlying error text when there is one', () => {
    const { container } = render(
      <PermissionGate status="denied" error="User denied Geolocation" onRetry={vi.fn()} />,
    );
    expect(container.textContent).toContain('User denied Geolocation');
  });
});

describe('DeviceInfo — "it works on my phone" is not evidence', () => {
  it('shows the measured rates and the active source', () => {
    const { container } = render(
      <DeviceInfo imuHz={59.3} gnssHz={0.09} sourceName="Native (Capacitor)" onClose={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('59.3');
    expect(text).toContain('0.09');
    expect(text).toContain('Native (Capacitor)');
  });

  it('states the WebView sensor limitation rather than implying 200 Hz', () => {
    // The IMU here comes from DeviceMotion, not SENSOR_DELAY_FASTEST, and it is
    // throttled with the screen off. Saying so on screen is the difference
    // between a known limit and a lie.
    const { container } = render(
      <DeviceInfo imuHz={59.3} gnssHz={0.09} sourceName="Native (Capacitor)" onClose={vi.fn()} />,
    );
    expect(container.textContent).toMatch(/DeviceMotion|throttl|Phase 15/i);
  });

  it('closes', () => {
    const onClose = vi.fn();
    render(<DeviceInfo imuHz={50} gnssHz={1} sourceName="Sim" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
