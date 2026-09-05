import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapContext } from './MapContext';
import TileRefresh from './TileRefresh';

/**
 * Re-requesting tiles that failed while offline.
 *
 * The behaviour under test is entirely about WHEN a refresh happens, and the
 * expensive mistake is refreshing when nothing was broken: phones raise
 * `online` on every wifi/cellular handover, so an unconditional refresh would
 * re-download the visible map repeatedly on an ordinary drive.
 */

function makeMap(withSetTiles = true) {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const setTiles = vi.fn();
  const source = withSetTiles
    ? { setTiles, tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'] }
    : { tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'] };
  return {
    setTiles,
    source,
    getSource: (id: string) => (id === 'osm' ? source : undefined),
    on: (ev: string, fn: (e: unknown) => void) => {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    off: (ev: string, fn: (e: unknown) => void) => {
      const list = (handlers.get(ev) ?? []).filter((f) => f !== fn);
      handlers.set(ev, list);
    },
    emit: (ev: string, payload: unknown) => {
      for (const fn of handlers.get(ev) ?? []) fn(payload);
    },
    listenerCount: (ev: string) => (handlers.get(ev) ?? []).length,
  };
}

type MockMap = ReturnType<typeof makeMap>;

function withMap(map: MockMap) {
  return render(
    <MapContext.Provider value={map as never}>
      <TileRefresh />
    </MapContext.Provider>,
  );
}

afterEach(cleanup);

describe('TileRefresh', () => {
  it('★ re-requests tiles after coming back online, if any had failed', () => {
    const map = makeMap();
    withMap(map);
    map.emit('error', { sourceId: 'osm' });
    window.dispatchEvent(new Event('online'));
    expect(map.setTiles).toHaveBeenCalledTimes(1);
    // The SAME template: this is not a URL change, it is an instruction to
    // forget what was tried and ask again.
    expect(map.setTiles).toHaveBeenCalledWith(map.source.tiles);
  });

  it('★ does nothing on `online` when no tile ever failed', () => {
    // Phones raise `online` on every wifi/cellular handover. Refreshing
    // unconditionally would re-download the visible map several times on an
    // ordinary drive, which is exactly what an offline-first app must not do.
    const map = makeMap();
    withMap(map);
    window.dispatchEvent(new Event('online'));
    expect(map.setTiles).not.toHaveBeenCalled();
  });

  it('refreshes only once per outage', () => {
    const map = makeMap();
    withMap(map);
    map.emit('error', { sourceId: 'osm' });
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(map.setTiles).toHaveBeenCalledTimes(1);
  });

  it('ignores errors from sources that are not the tile layer', () => {
    // The trail, the matched road and the offline basemap are all GeoJSON
    // sources on the same map. An error in one of them says nothing about
    // whether tiles need re-fetching.
    const map = makeMap();
    withMap(map);
    map.emit('error', { sourceId: 'trail' });
    window.dispatchEvent(new Event('online'));
    expect(map.setTiles).not.toHaveBeenCalled();
  });

  it('★ also refreshes when the app comes back to the foreground', () => {
    // Locking and unlocking the phone left a blank map, and that is not an
    // `online` event.
    const map = makeMap();
    withMap(map);
    map.emit('error', { sourceId: 'osm' });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(map.setTiles).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the app goes to the background', () => {
    const map = makeMap();
    withMap(map);
    map.emit('error', { sourceId: 'osm' });
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(map.setTiles).not.toHaveBeenCalled();
  });

  it('survives a source with no setTiles rather than throwing', () => {
    // Older MapLibre, or a vector source swapped in. The offline basemap
    // underneath is what makes a missing tile survivable anyway.
    const map = makeMap(false);
    withMap(map);
    map.emit('error', { sourceId: 'osm' });
    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
  });

  it('removes every listener on unmount', () => {
    const map = makeMap();
    const { unmount } = withMap(map);
    expect(map.listenerCount('error')).toBe(1);
    unmount();
    expect(map.listenerCount('error')).toBe(0);
  });
});
