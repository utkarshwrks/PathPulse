import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NavEvent, NavigationState } from '@pathpulse/nav-core';
import Hud from './Hud';
import { MODE_COLORS } from '@/config/modes';

/**
 * The HUD, rendered.
 *
 * Golden Rule #7 says the numbers on screen ARE the demo. A HUD that reads the
 * wrong field still looks completely convincing — which is exactly why it needs
 * asserting rather than eyeballing.
 */

afterEach(cleanup);

function state(patch: Partial<NavigationState> = {}): NavigationState {
  return {
    t: 60_000,
    mode: 'GNSS',
    position: { lat: 23.16, lon: 79.93 },
    velocityMps: 13.9,
    headingDeg: 87,
    covariance: { alongM: 16, crossM: 6, headingDeg: 2 },
    confidence: 1,
    distanceTravelledM: 1506,
    timeSinceGnssMs: 5000,
    estimatedDriftM: 0,
    biases: { accel: [0, 0, 0], gyro: [0, 0, 0] },
    ...patch,
  };
}

function renderHud(overrides: Partial<React.ComponentProps<typeof Hud>> = {}) {
  return render(
    <Hud
      navState={state()}
      updateHz={11.5}
      imuHz={37}
      gnssHz={0.09}
      sourceName="Native (Capacitor)"
      mapSourceLabel="OpenStreetMap raster"
      events={[]}
      error={null}
      walkingMode={false}
      {...overrides}
    />,
  );
}

describe('Hud — the numbers a judge reads', () => {
  it('shows the mode badge with its mode colour', () => {
    renderHud({ navState: state({ mode: 'DEAD_RECKONING' }) });
    const badge = screen.getByText('DEAD RECKONING');
    expect(badge.style.color).toBeTruthy();
    // The badge, the marker and the trail all read MODE_COLORS, so they can
    // never disagree about what orange means.
    expect(MODE_COLORS.DEAD_RECKONING).toBe('#f97316');
  });

  it.each([
    ['GNSS', 'GNSS'],
    ['GNSS_DEGRADED', 'GNSS DEGRADED'],
    ['DEAD_RECKONING', 'DEAD RECKONING'],
    ['RECOVERING', 'RECOVERING'],
    ['INITIALIZING', 'ACQUIRING'],
  ] as const)('labels %s as %s', (mode, label) => {
    renderHud({ navState: state({ mode }) });
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('shows speed in km/h, converted from m/s', () => {
    // 13.9 m/s is 50 km/h. Showing m/s would be defensible; showing the
    // unconverted number as if it were km/h would not.
    renderHud({ navState: state({ velocityMps: 13.9 }) });
    expect(screen.getByText('50')).toBeTruthy();
    expect(screen.getByText('km/h')).toBeTruthy();
  });

  it('shows heading, distance and time since GNSS', () => {
    renderHud();
    expect(screen.getByText('87')).toBeTruthy();
    expect(screen.getByText('1506 m')).toBeTruthy();
    expect(screen.getByText('5.0 s')).toBeTruthy();
  });

  it('shows along/cross uncertainty as two numbers, not one radius', () => {
    // The asymmetry is the whole story: road snapping bounds cross-track while
    // along-track keeps growing. A single radius would hide that.
    renderHud();
    expect(screen.getByText('16/6 m')).toBeTruthy();
  });

  it('labels drift as an estimate only while dead reckoning', () => {
    renderHud({ navState: state({ mode: 'DEAD_RECKONING', estimatedDriftM: 26.9 }) });
    expect(screen.getByText('drift est')).toBeTruthy();
    cleanup();
    renderHud({ navState: state({ mode: 'GNSS' }) });
    expect(screen.getByText('drift')).toBeTruthy();
  });

  it('computes drift as a percentage of distance travelled', () => {
    renderHud({
      navState: state({ mode: 'DEAD_RECKONING', estimatedDriftM: 30, distanceTravelledM: 1000 }),
    });
    expect(screen.getByText('3.0 %')).toBeTruthy();
  });

  it('does not divide by zero before the vehicle has moved', () => {
    renderHud({ navState: state({ distanceTravelledM: 0, estimatedDriftM: 5 }) });
    expect(screen.getByText('0.0 %')).toBeTruthy();
  });

  it('shows confidence as a percentage', () => {
    renderHud({ navState: state({ confidence: 0.31 }) });
    expect(screen.getByText('31%')).toBeTruthy();
  });

  it('flags a sub-10 Hz update rate in amber', () => {
    // The problem statement requires at least 10 Hz. Falling under it must be
    // visible, not silent.
    const { container } = renderHud({ updateHz: 8.3 });
    const hz = within(container).getByText('8.3 Hz');
    expect(hz.className).toMatch(/amber/);
  });

  it('does not flag a healthy update rate', () => {
    const { container } = renderHud({ updateHz: 11.5 });
    expect(within(container).getByText('11.5 Hz').className).not.toMatch(/amber/);
  });

  it('★ shows what the engine detected, in preference to the manual switch', () => {
    // The detected context decides three behaviours; Walking Mode only moves a
    // clamp. When both have something to say, the detected one is the useful
    // one — and it is the one that explains why the AI badge vanished.
    renderHud({ walkingMode: true, motionContext: 'PEDESTRIAN' });
    expect(screen.getByText('on foot')).toBeTruthy();
    expect(screen.queryByText('walking')).toBeNull();
  });

  it('says so when GNSS can see no movement at all', () => {
    renderHud({ motionContext: 'STATIONARY' });
    expect(screen.getByText('still')).toBeTruthy();
  });

  it('★ labels a speed that came from counting footsteps', () => {
    // A judge asking whether the AI is doing anything deserves an answer on
    // screen, and so does one asking what replaced it when it stood down.
    renderHud({ speedSource: 'STEPS', motionContext: 'PEDESTRIAN' });
    expect(screen.getByTestId('speed-source').textContent).toBe('[STEPS]');
  });

  it('stays out of the way in a vehicle', () => {
    renderHud({ motionContext: 'VEHICLE' });
    expect(screen.queryByText('on foot')).toBeNull();
    expect(screen.queryByText('still')).toBeNull();
  });

  it('shows the WALKING badge only in walking mode', () => {
    renderHud({ walkingMode: false });
    expect(screen.queryByText('walking')).toBeNull();
    cleanup();
    renderHud({ walkingMode: true });
    expect(screen.getByText('walking')).toBeTruthy();
  });

  it('shows the last measured recovery drift when there has been one', () => {
    const events: NavEvent[] = [
      { t: 1, type: 'DRIFT_MEASURED', message: '35.6m over 796m (4.47%)', data: { driftM: 35.6 } },
    ];
    renderHud({ events });
    expect(screen.getByText('35.6m over 796m (4.47%)')).toBeTruthy();
  });

  it('shows the most recent recovery when there have been several', () => {
    const events: NavEvent[] = [
      { t: 1, type: 'DRIFT_MEASURED', message: 'first', data: { driftM: 1 } },
      { t: 2, type: 'DRIFT_MEASURED', message: 'latest', data: { driftM: 2 } },
    ];
    renderHud({ events });
    expect(screen.getByText('latest')).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
  });

  it('shows measured sensor rates and the source name', () => {
    // The footer is one element with <br/> separators, so its text is split
    // across children and only the whole block matches.
    const { container } = renderHud();
    const text = container.textContent ?? '';
    expect(text).toContain('imu 37.0 Hz · gnss 0.09 Hz');
    expect(text).toContain('Native (Capacitor)');
    expect(text).toContain('OpenStreetMap raster');
  });

  it('waits politely before the first fix instead of showing zeros', () => {
    // Showing 0 km/h and 0 m drift before there is any estimate would be
    // stating a measurement we do not have.
    renderHud({ navState: null });
    expect(screen.getByText(/waiting for first fix/i)).toBeTruthy();
    expect(screen.queryByText('km/h')).toBeNull();
  });

  it('surfaces an error without hiding the rest of the HUD', () => {
    renderHud({ error: 'Location permission denied' });
    expect(screen.getByText('Location permission denied')).toBeTruthy();
    expect(screen.getByText('km/h')).toBeTruthy();
  });
});

describe('Hud — last turn', () => {
  it('shows the last turn with its angle and session time', () => {
    renderHud({
      navState: state({
        lastTurn: { t: 252_000, kind: 'RIGHT_90', deltaDeg: 87.4, label: 'RIGHT 87°' },
      }),
    });
    expect(screen.getByText(/last turn/i)).toBeDefined();
    expect(screen.getByText(/RIGHT 87° @ 04:12/)).toBeDefined();
  });

  it('shows a left turn as left', () => {
    renderHud({
      navState: state({
        lastTurn: { t: 0, kind: 'LEFT_90', deltaDeg: -91, label: 'LEFT 91°' },
      }),
    });
    expect(screen.getByText(/LEFT 91° @ 00:00/)).toBeDefined();
  });

  it('says nothing about turns before one has happened', () => {
    renderHud();
    expect(screen.queryByText(/last turn/i)).toBeNull();
  });
});

describe('Hud — GNSS anomaly badge', () => {
  it('shows the anomaly with the number behind it', () => {
    renderHud({
      navState: state({
        gnssAnomaly: {
          t: 12_000,
          kind: 'IMPLAUSIBLE_JUMP',
          message: 'fix moved 4900m in 1.0s — 4900 m/s',
        },
      }),
    });
    expect(screen.getByText(/GNSS anomaly detected/i)).toBeDefined();
    expect(screen.getByText(/4900m in 1\.0s/)).toBeDefined();
  });

  it('★ says the estimate is unchanged, so the badge cannot be read as a failure', () => {
    // The detector is advisory. A judge seeing a red badge must be able to see
    // immediately that navigation is still trusted — otherwise the feature
    // reads as the app admitting it is lost.
    renderHud({
      navState: state({
        gnssAnomaly: { t: 1, kind: 'STATIC_HOLD', message: 'held still' },
      }),
    });
    expect(screen.getByText(/Advisory only/i)).toBeDefined();
  });

  it('shows nothing when GNSS looks fine', () => {
    renderHud();
    expect(screen.queryByText(/GNSS anomaly/i)).toBeNull();
  });
});

describe('Hud — why it is dead reckoning', () => {
  it('★ explains a mode that would otherwise read as a contradiction', () => {
    // Observed on a real phone indoors: "DEAD RECKONING" and "no gnss 1.3 s"
    // on screen together. Both true; together they read as the app inventing
    // movement while a fix sat one second old.
    renderHud({
      navState: state({ mode: 'DEAD_RECKONING' }),
      modeReason: 'fixes arriving but only 35 m accurate — needs 25 m or better. Common indoors.',
    });
    expect(screen.getByText(/only 35 m accurate/)).toBeDefined();
  });

  it('says nothing when the mode needs no explanation', () => {
    renderHud({ navState: state({ mode: 'GNSS' }), modeReason: null });
    expect(screen.queryByText(/accurate/)).toBeNull();
  });
});
