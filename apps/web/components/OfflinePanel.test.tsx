import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * ★ NO UNIT TEST MAY TOUCH THE NETWORK ★
 * `handleDownload` fetches a road graph from OpenStreetMap. Left unmocked this
 * suite made a real Overpass request, which is slow, rate-limited, and turns a
 * logic test into a test of somebody else's uptime. Both boundaries are
 * stubbed: the fetch, and the coverage lookup that reads the app's manifest.
 */
vi.mock('@/lib/roadGraphFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/roadGraphFetch')>();
  return { ...actual, fetchRoadGraph: vi.fn().mockRejectedValue(new Error('offline in tests')) };
});

vi.mock('@/lib/roadGraph', () => ({ findGraphFor: vi.fn().mockResolvedValue(null) }));

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
      position={{ lat: 23.16, lon: 79.93 }}
      onRoadGraphChanged={() => {}}
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
    const button = screen.getByRole('button', { name: /download (this area|roads \+ map)/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot download while offline — there is nothing to download from', () => {
    renderPanel({ online: false });
    const button = screen.getByRole('button', { name: /download (this area|roads \+ map)/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('still offers the download with no tile worker, because roads matter more', () => {
    // ★ A DELIBERATE CHANGE ★ The button used to be disabled without a service
    // worker, because tiles were the only thing it fetched. The road graph
    // needs no worker — it goes to IndexedDB — and it is the half that decides
    // whether the marker stays on the road rather than merely whether the map
    // is pretty. Refusing the important download because the cosmetic one is
    // unavailable had it exactly backwards.
    renderPanel({ capability: { supported: true, active: false, reason: 'blocked' } });
    const button = screen.getByRole('button', { name: /download (this area|roads \+ map)/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('hands the worker a real list of tile urls', async () => {
    // The road-graph fetch runs first and fails in jsdom with no network, which
    // must not stop the tiles being stored: the two halves fail independently.
    const s = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /download (this area|roads \+ map)/i }));
    await waitFor(() => expect(s.download).toHaveBeenCalledTimes(1));
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
    const button = screen.getByRole('button', { name: /download (this area|roads \+ map)/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears stored roads as well as tiles', async () => {
    // No longer gated on the tile count: a downloaded road graph is storage
    // too, and it can exist with zero tiles cached.
    const s = renderPanel({ cachedTiles: 50 });
    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    expect((clearButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(clearButton);
    await waitFor(() => expect(s.clear).toHaveBeenCalled());
  });

  it('waits for the map rather than quoting a made-up area', () => {
    render(
      <OfflinePanel
        status={status()}
        bounds={null}
        position={{ lat: 23.16, lon: 79.93 }}
      onRoadGraphChanged={() => {}}
      mapSourceLabel="OpenStreetMap raster"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Waiting for the map/)).toBeDefined();
    expect(
      (screen.getByRole('button', { name: /download (this area|roads \+ map)/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('OfflinePanel — road graph coverage', () => {
  /**
   * ★ THE HALF OF "OFFLINE" THAT WAS MISSING ★
   * The panel used to say "the engine never needs a network, this is about the
   * basemap". True of the physics, false of the result: road snapping is what
   * holds the marker on the road during an outage, it needs a road graph, and
   * the app shipped graphs for three bounding boxes chosen months in advance.
   * Anywhere else, snapping silently did nothing and the panel said everything
   * was fine.
   */
  it('says plainly when no road graph covers this area', async () => {
    // jsdom has no network and no IndexedDB, so the lookup finds nothing —
    // which is exactly the state a driver outside the bundled boxes is in.
    renderPanel();
    await waitFor(() => expect(screen.getByText('NOT COVERED')).toBeDefined());
    expect(screen.getByText(/will not be held on the road/i)).toBeDefined();
  });

  it('relabels the button so the missing half is the obvious thing to fix', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /download roads \+ map/i })).toBeDefined(),
    );
  });

  it('does not claim the engine is fine without a network', () => {
    renderPanel();
    expect(screen.getByText(/the map and the road graph do/i)).toBeDefined();
  });
});
