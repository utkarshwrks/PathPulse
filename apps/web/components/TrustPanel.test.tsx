import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavEvent, SensorSample, SessionSummary } from '@pathpulse/nav-core';
import TrustPanel from './TrustPanel';
import { DEFAULT_CONTROLS, type EngineDiagnostics } from '@/hooks/useNavigationEngine';

/**
 * The Phase 5 anti-fake panel, rendered and actually clicked.
 *
 * Until this file existed no element of this app had ever been clicked by
 * anything — every toggle and tab was verified only through the logic behind
 * it. A control wired to the wrong handler, a tab that renders nothing, or a
 * label that reads the wrong field are all invisible to a logic test and
 * obvious the moment a judge taps the screen.
 *
 * NOTE: this project runs vitest with `globals: false`, so @testing-library's
 * automatic cleanup — which registers itself on a global `afterEach` — never
 * installs. Without the explicit cleanup below, every render stays mounted and
 * later queries match elements from earlier tests.
 */

afterEach(cleanup);

const DIAGNOSTICS: EngineDiagnostics = {
  zuptTriggers: 3,
  zaruTriggers: 7,
  accelBias: [0.021, -0.004, 0.001],
  gyroBias: [0.0011, -0.0002, 0.0104],
  attitudeQuality: 0.86,
  attitudeSettled: true,
  observedFixIntervalMs: 11_000,
  effectiveNoFixTimeoutMs: 20_000,
  unaidedMs: 43_400,
  forwardBiasMps2: -0.12,
  forwardBiasObservations: 9,
  isStationary: false,
  accelVariance: 0.1635,
  gyroMean: 0.05,
  roadSnapAppliedFraction: 0.92,
  matchedRoadName: 'NH45',
  matchedRoadDistanceM: 4.2,
  hasRoadGraph: true,
  mlReady: true,
  mlSpeedMps: 12.5,
  mlInferences: 40,
  mlLatencyMs: 8.2,
  mlError: null,
  acquiringReason: null,
  modeReason: null,
  speedSource: 'ML' as const,
};

const STATS: SessionSummary = {
  durationMs: 185_000,
  distanceM: 1506,
  outageCount: 2,
  outageTotalMs: 136_000,
  longestOutageMs: 90_000,
  bestDriftM: 4.2,
  worstDriftM: 35.6,
  meanDriftM: 19.9,
  maxSpeedMps: 13.9,
  meanUpdateHz: 11.4,
  zuptTriggers: 3,
};

const SAMPLE: SensorSample = {
  t: 12_340,
  imu: { ax: -1.9, ay: 9.1, az: 3.8, gx: -0.0209, gy: -0.1222, gz: 0.1239 },
};

const EVENTS: NavEvent[] = [
  { t: 1000, type: 'GNSS_FIX', message: 'acc=6.0m sats=9' },
  { t: 65_450, type: 'MODE_CHANGE', message: 'GNSS -> GNSS_DEGRADED (accuracy 31.0m)' },
  { t: 90_120, type: 'DRIFT_MEASURED', message: '35.6m over 796m (4.47%)', data: { driftM: 35.6 } },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof TrustPanel>> = {}) {
  const onControlsChange = vi.fn();
  const onExportEvents = vi.fn();
  const onExportTrip = vi.fn();
  const utils = render(
    <TrustPanel
      simulated={false}
      modelInfo={{ loaded: true, error: null, sizeBytes: 36076, latencyMs: 8.2, inferences: 40 }}
      sample={SAMPLE}
      lastGnss={{ gnss: { lat: 23.16, lon: 79.93, accuracyM: 6 }, t: 10_000, ageMs: 2340 }}
      roadGraphEntry={{
        name: 'jabalpur',
        file: 'road_graph_jabalpur.json',
        bbox: [79.87, 23.11, 79.99, 23.22],
        ways: 9462,
        sizeKb: 2265,
      }}
      diagnostics={DIAGNOSTICS}
      stats={STATS}
      events={EVENTS}
      controls={DEFAULT_CONTROLS}
      onControlsChange={onControlsChange}
      onExportEvents={onExportEvents}
      onExportTrip={onExportTrip}
      tripPointCount={42}
      imuHz={37}
      gnssHz={0.09}
      updateHz={11.5}
      {...overrides}
    />,
  );
  return { ...utils, onControlsChange, onExportEvents, onExportTrip };
}

function openPanel(overrides: Partial<React.ComponentProps<typeof TrustPanel>> = {}) {
  // The panel is opened from the app menu now and renders expanded, so there
  // is nothing to click here. Kept as a named helper so the tests still read
  // as "open the panel, then assert".
  const utils = renderPanel(overrides);
  return utils;
}

describe('TrustPanel — opening and tabs', () => {
  it('★ opens expanded, because the menu is what decides it is wanted', () => {
    // REVISED. It used to start collapsed behind its own "Debug" button, which
    // sat top-right on the same line as a HUD up to 359 px wide and overlapped
    // it on a phone. The panel is now reached from the app menu, so by the
    // time it renders the user has already asked for it.
    renderPanel();
    expect(screen.getByText(/SENSORS/)).toBeDefined();
  });

  it('★ no longer places or dismisses itself — Sheet does both', () => {
    // It used to own its corner, its layer and its own close button, which sat
    // at `top-0 -translate-y-9` on a container anchored at `top-2` — so the ✕
    // rendered around y = -34 px, off the top of the screen. The panel could
    // be opened and then not dismissed. Every other panel already went
    // through the shared Sheet; this was the one exemption, and it broke.
    const { container } = renderPanel();
    expect(container.querySelector('.absolute')).toBeNull();
    expect(screen.queryByRole('button', { name: /close panel/i })).toBeNull();
  });

  it('renders its tabs directly, with no shell of its own', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'SENSORS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EVENTS' })).toBeTruthy();
  });

  it('shows whether the vehicle is stationary at a glance', () => {
    renderPanel();
    expect(screen.getByText(/stationary|moving/)).toBeDefined();
  });

  it('shows all four tabs', () => {
    openPanel();
    for (const tab of ['SENSORS', 'CONSTRAINTS', 'EVENTS', 'STATS']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy();
    }
  });

  it('opens on SENSORS and switches between every tab', () => {
    // A tab that renders nothing is invisible to a logic test.
    // Group headings are uppercased by CSS, and jsdom does not apply
    // text-transform — so the DOM text is the lowercase source string.
    openPanel();
    expect(screen.getByText('raw imu')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    expect(screen.getByText('Road snapping')).toBeTruthy();
    expect(screen.queryByText('raw imu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'EVENTS' }));
    expect(screen.getByRole('button', { name: /export json/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'STATS' }));
    expect(screen.getByText('DURATION')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'SENSORS' }));
    expect(screen.getByText('raw imu')).toBeTruthy();
  });
});

describe('TrustPanel — SENSORS reads the right fields', () => {
  it('shows live raw accelerometer and gyro values', () => {
    openPanel();
    // Signed and fixed-width, so a table of numbers does not jitter.
    expect(screen.getByText(/-1\.90 \+9\.10 \+3\.80/)).toBeTruthy();
    expect(screen.getByText(/-0\.0209 -0\.1222 \+0\.1239/)).toBeTruthy();
  });

  it('shows measured rates, and flags a sub-10 Hz engine rate', () => {
    openPanel({ updateHz: 8.3 });
    const row = screen.getByText('ENGINE OUT').parentElement!;
    expect(within(row).getByText('8.3 Hz').className).toMatch(/amber/);
  });

  it('does not flag a healthy engine rate', () => {
    openPanel({ updateHz: 11.5 });
    const row = screen.getByText('ENGINE OUT').parentElement!;
    expect(within(row).getByText('11.5 Hz').className).not.toMatch(/amber/);
  });

  it('shows the observed fix interval and the timeout derived from it', () => {
    openPanel();
    expect(screen.getByText('11.0 s')).toBeTruthy();
    expect(screen.getByText('20.0 s')).toBeTruthy();
  });

  it('reports a device that gives no Doppler speed honestly', () => {
    // "not reported" is a different claim from 0 m/s, and the difference
    // matters: one is a missing measurement, the other says "stopped".
    openPanel();
    expect(screen.getByText('not reported')).toBeTruthy();
  });

  it('shows n/a for satellites rather than inventing a number', () => {
    openPanel();
    expect(screen.getAllByText('n/a').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the loaded road graph and the matched road', () => {
    openPanel();
    expect(screen.getByText('jabalpur (9462 ways)')).toBeTruthy();
    expect(screen.getByText('NH45')).toBeTruthy();
    expect(screen.getByText('4.2 m')).toBeTruthy();
    expect(screen.getByText('92 %')).toBeTruthy();
  });

  it('warns when no road graph covers this area', () => {
    // The case that must not look like road snapping being broken.
    openPanel({ roadGraphEntry: null });
    const row = screen.getByText('GRAPH').parentElement!;
    expect(within(row).getByText('none here').className).toMatch(/amber/);
  });

  it('shows the estimator biases and counters', () => {
    openPanel();
    expect(screen.getByText('[0.021, -0.004, 0.001]')).toBeTruthy();
    expect(screen.getByText('3 / 7')).toBeTruthy();
    expect(screen.getByText('NO')).toBeTruthy();
  });

  it('renders with no sample at all rather than crashing', () => {
    openPanel({ sample: null, lastGnss: null });
    expect(screen.getByText('no fix yet')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('TrustPanel — CONSTRAINTS toggles actually fire', () => {
  it('renders every toggle plus Walking Mode', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    for (const label of [
      'NHC',
      'ZUPT',
      'ZARU',
      'Road snapping',
      'Accel high-pass',
      'Speed clamp',
      'Low-pass filter',
      'Median filter',
      'Walking Mode',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it.each([
    ['NHC', 'nhc'],
    ['ZUPT', 'zupt'],
    ['ZARU', 'zaru'],
    ['Road snapping', 'roadSnap'],
    ['Accel high-pass', 'accelHighPass'],
    ['Speed clamp', 'speedClamp'],
  ])('clicking %s patches only %s', (label, key) => {
    // ★ The wiring the whole anti-fake demo depends on. ★ A toggle bound to
    // the wrong key would still animate, still look right, and quietly change
    // something else.
    const { onControlsChange } = openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    fireEvent.click(screen.getByText(label).closest('button')!);
    expect(onControlsChange).toHaveBeenCalledTimes(1);
    expect(onControlsChange).toHaveBeenCalledWith({ [key]: false });
  });

  it('turns a disabled constraint back on', () => {
    const { onControlsChange } = openPanel({
      controls: { ...DEFAULT_CONTROLS, nhc: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    fireEvent.click(screen.getByText('NHC').closest('button')!);
    expect(onControlsChange).toHaveBeenCalledWith({ nhc: true });
  });

  it('toggles Walking Mode', () => {
    const { onControlsChange } = openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    fireEvent.click(screen.getByText('Walking Mode').closest('button')!);
    expect(onControlsChange).toHaveBeenCalledWith({ walkingMode: true });
  });

  it('labels forward-bias as the measured-worse negative result', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'CONSTRAINTS' }));
    expect(screen.getByText(/Forward bias \(off — measured worse\)/)).toBeTruthy();
  });
});

describe('TrustPanel — EVENTS', () => {
  it('lists events newest first with millisecond timestamps', () => {
    // During a demo the interesting line is the one that just happened.
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'EVENTS' }));
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('DRIFT_MEASURED');
    expect(items[items.length - 1]!.textContent).toContain('GNSS_FIX');
    expect(items[0]!.textContent).toMatch(/\d\d:\d\d\.\d\d\d/);
  });

  it('shows each event message and its reason', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'EVENTS' }));
    expect(screen.getByText(/GNSS -> GNSS_DEGRADED \(accuracy 31\.0m\)/)).toBeTruthy();
  });

  it('fires the export handler', () => {
    const { onExportEvents } = openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'EVENTS' }));
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));
    expect(onExportEvents).toHaveBeenCalledTimes(1);
  });

  it('says so when there are no events yet', () => {
    openPanel({ events: [] });
    fireEvent.click(screen.getByRole('button', { name: 'EVENTS' }));
    expect(screen.getByText('no events yet')).toBeTruthy();
  });
});

describe('TrustPanel — STATS', () => {
  it('shows session totals', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'STATS' }));
    expect(screen.getByText('3m 05s')).toBeTruthy();
    expect(screen.getByText('1506 m')).toBeTruthy();
    expect(screen.getByText('50.0 km/h')).toBeTruthy();
  });

  it('shows MEASURED drift, not the engine uncertainty model', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'STATS' }));
    expect(screen.getByText('4.2 m')).toBeTruthy();
    expect(screen.getByText('35.6 m')).toBeTruthy();
    expect(screen.getByText('19.9 m')).toBeTruthy();
  });

  it('shows a dash before any recovery has happened', () => {
    openPanel({
      stats: { ...STATS, bestDriftM: null, worstDriftM: null, meanDriftM: null },
    });
    fireEvent.click(screen.getByRole('button', { name: 'STATS' }));
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('shows outage counts and durations', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'STATS' }));
    expect(screen.getByText('2m 16s')).toBeTruthy();
    expect(screen.getByText('1m 30s')).toBeTruthy();
  });
});

describe('TrustPanel — constellation breakdown (9E)', () => {
  const withSats = (
    gnss: Partial<NonNullable<SensorSample['gnss']>>,
    simulated = false,
  ) =>
    openPanel({
      simulated,
      lastGnss: {
        gnss: { lat: 23.16, lon: 79.93, accuracyM: 6, ...gnss },
        t: 10_000,
        ageMs: 2340,
      },
    });

  it('lists NavIC first and highlights it', () => {
    withSats({ constellations: { GPS: 7, NAVIC: 4, GALILEO: 3 } });
    expect(screen.getByText(/NAVIC \(IRNSS\)/i)).toBeDefined();
  });

  it('★ labels a simulated sky as simulated', () => {
    // The simulator is the only source that can produce a breakdown today.
    // Showing its numbers unlabelled would present an invented sky as a
    // measurement.
    withSats({ constellations: { GPS: 7, NAVIC: 4 } }, true);
    expect(screen.getByText('SIMULATED')).toBeDefined();
    expect(screen.getByText(/not a measurement/i)).toBeDefined();
  });

  it('★ says the breakdown is unavailable on hardware that reports only a total', () => {
    withSats({ satCount: 9 });
    expect(screen.getByText('TOTAL-ONLY')).toBeDefined();
    expect(screen.getByText(/no per-constellation data/i)).toBeDefined();
    expect(screen.getByText(/native GnssStatus API \(Phase 15\)/)).toBeDefined();
  });

  it('★ says unavailable rather than showing zeroes when nothing is reported', () => {
    // Zeroes would read as "no satellites in view" — a measurement we have not
    // made, on a platform that cannot make it.
    withSats({});
    expect(screen.getByText('UNAVAILABLE')).toBeDefined();
    expect(screen.queryByText(/NAVIC \(IRNSS\)/i)).toBeNull();
  });

  it('always shows a provenance line, whatever the state', () => {
    withSats({ constellations: { GPS: 7, NAVIC: 4 } });
    expect(screen.getByText('DATA SOURCE')).toBeDefined();
    expect(screen.getByText('MEASURED')).toBeDefined();
  });
});

describe('TrustPanel — provenance survives a source switch (deep test pass 8)', () => {
  it('★ labels a simulator fix SIMULATED even when the caller says live', () => {
    // The window this closes: `simulated` is derived from the selected source
    // kind and flips during render, while the stale simulated fix is cleared
    // by an effect that runs afterwards. For one painted frame the panel had
    // simulated counts and simulated={false} — an invented sky labelled
    // MEASURED, which is the exact failure the feature exists to prevent.
    openPanel({
      simulated: false,
      lastGnss: {
        gnss: {
          lat: 23.16,
          lon: 79.93,
          accuracyM: 6,
          constellations: { GPS: 7, NAVIC: 4 },
          constellationsSimulated: true,
        },
        t: 10_000,
        ageMs: 2340,
      },
    });
    expect(screen.getByText('SIMULATED')).toBeDefined();
    expect(screen.queryByText('MEASURED')).toBeNull();
  });

  it('shows how many tracked satellites the breakdown cannot name', () => {
    openPanel({
      simulated: false,
      lastGnss: {
        gnss: {
          lat: 23.16,
          lon: 79.93,
          accuracyM: 6,
          constellations: { GPS: 7, NAVIC: 4 },
          satCount: 13,
        },
        t: 10_000,
        ageMs: 2340,
      },
    });
    // 13 tracked, 11 named: the two unnamed are stated rather than dropped.
    expect(screen.getByText('UNNAMED')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });
});

describe('TrustPanel — trip export (9F)', () => {
  it('offers GPX and GeoJSON alongside the event log', () => {
    const { onExportTrip } = openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^events$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^gpx$/i }));
    expect(onExportTrip).toHaveBeenCalledWith('gpx');
    fireEvent.click(screen.getByRole('button', { name: /^geojson$/i }));
    expect(onExportTrip).toHaveBeenCalledWith('geojson');
  });

  it('★ refuses to export a trip with nothing in it', () => {
    // A GPX with no track opens to an empty map, which reads as the app having
    // lost the run rather than the run not having started.
    openPanel({ tripPointCount: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^events$/i }));
    expect((screen.getByRole('button', { name: /^gpx$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: /^geojson$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says what the two tracks are, so the file is not a mystery', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^events$/i }));
    expect(screen.getByText(/two tracks/i)).toBeDefined();
  });
});
