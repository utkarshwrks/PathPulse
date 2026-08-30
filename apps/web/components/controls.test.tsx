import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceInfo from './DeviceInfo';
import PermissionGate from './PermissionGate';

/**
 * The remaining interactive components, rendered and clicked.
 *
 * Between them these are every button a person touches during a demo other
 * than the debug panel: source selection, transport, the GNSS-loss button that
 * triggers the whole dead-reckoning story, and the screens shown when
 * something is wrong.
 */

afterEach(cleanup);

describe('PermissionGate — three blocked states that look identical but are not', () => {
  it('stays out of the way when nothing is blocked', () => {
    const { container } = render(
      <PermissionGate status="watching" error={null} onRetry={vi.fn()} onUseSimulation={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('distinguishes an insecure origin from a denial', () => {
    // ★ These look the same to a user — no dot — but have completely different
    // fixes. Telling someone to "allow location" when the real problem is an
    // http:// origin sends them chasing a setting that cannot help.
    const { container } = render(
      <PermissionGate status="insecure" error={null} onRetry={vi.fn()} onUseSimulation={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/secure|https/i);
    expect(text).not.toMatch(/denied/i);
  });

  it('explains a real denial', () => {
    const { container } = render(
      <PermissionGate status="denied" error="User denied Geolocation" onRetry={vi.fn()} onUseSimulation={vi.fn()} />,
    );
    expect(container.textContent).toMatch(/denied|permission/i);
  });

  it('explains an unsupported browser', () => {
    const { container } = render(
      <PermissionGate status="unsupported" error={null} onRetry={vi.fn()} onUseSimulation={vi.fn()} />,
    );
    expect(container.textContent).toMatch(/unsupported|not available|no geolocation/i);
  });

  it('offers a retry that fires', () => {
    const onRetry = vi.fn();
    render(
      <PermissionGate
        status="denied"
        error={null}
        onRetry={onRetry}
        onUseSimulation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('★ always offers a way out — this gate used to be a trap', () => {
    // It covers the whole screen and only offered Retry. Choose live sensors
    // on an http origin, or deny the prompt once, and there was no way back:
    // the source picker was underneath it and the menu button behind it. The
    // app was not broken, it was unreachable — which looks worse.
    for (const status of ['denied', 'insecure', 'unsupported'] as const) {
      cleanup();
      const onUseSimulation = vi.fn();
      render(
        <PermissionGate
          status={status}
          error={null}
          onRetry={vi.fn()}
          onUseSimulation={onUseSimulation}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /use the simulation/i }));
      expect(onUseSimulation, status).toHaveBeenCalled();
    }
  });

  it('shows the underlying error text when there is one', () => {
    const { container } = render(
      <PermissionGate status="denied" error="User denied Geolocation" onRetry={vi.fn()} onUseSimulation={vi.fn()} />,
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

