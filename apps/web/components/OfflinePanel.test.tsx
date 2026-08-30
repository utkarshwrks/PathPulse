import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OfflinePanel from './OfflinePanel';
import type { OfflineStatus } from '@/hooks/useOfflineStatus';

/**
 * The offline screen.
 *
 * This is the panel a judge is looking at during the aeroplane-mode moment, so
 * every claim on it has to be true — including the awkward ones. A screen that
 * says "tile cache: active" when no worker is running is worse than no screen,
 * because it converts a recoverable "the map needs network" into a discovered
 * lie.
 */

afterEach(cleanup);

const JABALPUR = { north: 23.19, south: 23.15, east: 79.99, west: 79.95 };

function status(patch: Partial<OfflineStatus> = {}): OfflineStatus {
  return {
    online: true,
    capability: { supported: true, active: true },
    cachedTiles: 0,
    progress: null,
    download: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...patch,
  };
}

function renderPanel(patch: Partial<OfflineStatus> = {}, bounds = JABALPUR) {
  const s = status(patch);
  render(
    <OfflinePanel
      status={s}
      bounds={bounds}
      mapSourceLabel="OpenStreetMap raster"
      onClose={() => {}}
    />,
  );
  return s;
}

describe('OfflinePanel', () => {
  it('states the radio, the map source, the worker and the tile count', () => {
    renderPanel({ cachedTiles: 412 });
    expect(screen.getByText('online')).toBeDefined();
    expect(screen.getByText('OpenStreetMap raster')).toBeDefined();
    expect(screen.getByText('active')).toBeDefined();
    expect(screen.getByText('412')).toBeDefined();
  });

  it('★ shows the offline state as the good outcome, not an error', () => {
    // Being offline is the demo working, not the app failing.
    renderPanel({ online: false });
    expect(screen.getByText('OFFLINE')).toBeDefined();
  });

  it('★ says why the cache is unavailable rather than just that it is', () => {
    renderPanel({
      capability: { supported: false, active: false, reason: 'Insecure origin — use the APK' },
    });
    expect(screen.getByText('unavailable')).toBeDefined();
    expect(screen.getByText(/Insecure origin/)).toBeDefined();
  });

  it('quotes a tile count and a size before anything is downloaded', () => {
    renderPanel();
    expect(screen.getByText(/tiles, roughly/)).toBeDefined();
  });

  it('★ refuses an area too large to store, with the limit stated', () => {
    renderPanel({}, { north: 60, south: -60, east: 170, west: -170 });
    expect(screen.getByText(/Too large/)).toBeDefined();
    const button = screen.getByRole('button', { name: /download this area/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot download while offline — there is nothing to download from', () => {
    renderPanel({ online: false });
    const button = screen.getByRole('button', { name: /download this area/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot download with no worker to do the storing', () => {
    renderPanel({ capability: { supported: true, active: false, reason: 'blocked' } });
    const button = screen.getByRole('button', { name: /download this area/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('hands the worker a real list of tile urls', () => {
    const s = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /download this area/i }));
    expect(s.download).toHaveBeenCalledTimes(1);
    const urls = (s.download as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\/[a-z]\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    }
  });

  it('shows progress while a download runs', () => {
    renderPanel({ progress: { done: 40, total: 100, failed: 2, finished: false } });
    expect(screen.getByText(/downloading 40\/100/)).toBeDefined();
    expect(screen.getByText(/2 failed/)).toBeDefined();
  });

  it('does not offer a second download while one is running', () => {
    renderPanel({ progress: { done: 1, total: 100, failed: 0, finished: false } });
    const button = screen.getByRole('button', { name: /download this area/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('only offers to clear a cache that has something in it', () => {
    renderPanel({ cachedTiles: 0 });
    expect((screen.getByRole('button', { name: /clear cache/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    const s = renderPanel({ cachedTiles: 50 });
    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    expect((clearButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(clearButton);
    expect(s.clear).toHaveBeenCalled();
  });

  it('waits for the map rather than quoting a made-up area', () => {
    render(
      <OfflinePanel
        status={status()}
        bounds={null}
        mapSourceLabel="OpenStreetMap raster"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Waiting for the map/)).toBeDefined();
    expect(
      (screen.getByRole('button', { name: /download this area/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
