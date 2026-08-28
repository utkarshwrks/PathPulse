import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Benchmarks, { type BenchmarkData } from './Benchmarks';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(config: string, meanDriftPct: number, extra: Partial<BenchmarkData['rows'][number]> = {}) {
  return {
    config,
    description: `${config} description`,
    runs: 12,
    meanDriftPct,
    medianDriftPct: meanDriftPct * 0.8,
    p90DriftPct: meanDriftPct * 2,
    maxDriftPct: meanDriftPct * 2.5,
    meanRmseM: meanDriftPct * 7,
    meanAlongM: meanDriftPct * 5,
    meanCrossM: meanDriftPct * 4,
    meanCep95M: meanDriftPct * 11,
    meanRecoveryS: 1.5,
    meanUpdateHz: 50,
    totalZupt: 4,
    roadSnapPct: 90,
    positionResets: 0,
    ...extra,
  };
}

const DATA: BenchmarkData = {
  generatedFrom: ['sim_city_4242.jsonl', 'sim_highway_4242.jsonl'],
  windows: [
    { startMs: 30_000, durationMs: 60_000 },
    { startMs: 60_000, durationMs: 45_000 },
    { startMs: 45_000, durationMs: 90_000 },
  ],
  rows: [row('naive', 61.2), row('highpass', 13.6), row('full', 10.0), row('full_forwardbias', 12.8)],
};

describe('Benchmarks — the ablation table, in the demo', () => {
  it('shows every configuration with its drift', () => {
    render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    for (const r of DATA.rows) expect(screen.getByText(r.config)).toBeTruthy();
    expect(screen.getByText('61.2')).toBeTruthy();
  });

  it('headlines the shipped configuration, not the best-looking row', () => {
    render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    // 10.0% is `full`. Leading with a lower number from a config that does not
    // ship would be exactly the cherry-pick this project has already made once.
    expect(screen.getByText('10.0%')).toBeTruthy();
    expect(screen.getByText(/mean drift, full configuration/)).toBeTruthy();
  });

  it('shows the tail alongside the mean', () => {
    render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    expect(screen.getByText(/p90 20\.0%/)).toBeTruthy();
    expect(screen.getByText(/worst 25\.0%/)).toBeTruthy();
  });

  it('warns loudly that simulated logs are not a road result', () => {
    // ★ The single most damaging thing this project could do is present a
    // simulated number as a driven one.
    const { container } = render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    expect(container.textContent).toMatch(/simulated/i);
    expect(container.textContent).toMatch(/not.*a road result/i);
  });

  it('drops the warning when real drive logs are present', () => {
    const withDrive: BenchmarkData = {
      ...DATA,
      generatedFrom: ['drive_jabalpur_01.jsonl'],
    };
    const { container } = render(<Benchmarks onClose={vi.fn()} data={withDrive} />);
    expect(container.textContent).not.toMatch(/not.*a road result/i);
  });

  it('marks the negative-result row as struck through', () => {
    render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    expect(screen.getByText('full_forwardbias').className).toMatch(/line-through/);
    expect(screen.getByText('full').className).not.toMatch(/line-through/);
  });

  it('explains the along/cross split rather than just printing it', () => {
    const { container } = render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    expect(container.textContent).toMatch(/cross-track error puts the marker inside a building/i);
  });

  it('reports how many runs the numbers came from', () => {
    const { container } = render(<Benchmarks onClose={vi.fn()} data={DATA} />);
    expect(container.textContent).toMatch(/12 runs per configuration/);
    expect(container.textContent).toMatch(/2 logs × 3 outage windows/);
  });

  it('closes', () => {
    const onClose = vi.fn();
    render(<Benchmarks onClose={onClose} data={DATA} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when no benchmarks are bundled instead of showing an empty table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    render(<Benchmarks onClose={vi.fn()} />);
    expect(await screen.findByText(/no benchmarks bundled/i)).toBeTruthy();
  });

  it('loads from the app assets when nothing is injected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => DATA }) as unknown as Response),
    );
    render(<Benchmarks onClose={vi.fn()} />);
    expect(await screen.findByText('10.0%')).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith('benchmarks/benchmarks.json');
  });
});
