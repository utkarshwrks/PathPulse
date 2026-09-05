'use client';

import { useEffect, useRef } from 'react';
import { useMap } from './MapContext';

/**
 * Re-requests map tiles that failed while the network was away.
 *
 * ★ THE BUG ★
 * Field report: "I switch off the internet, map goes proper right, and when I
 * turn on the internet it does not load the proper current place. It load the
 * place that came after." Also: locking and unlocking the phone left a blank
 * map.
 *
 * MapLibre requests a tile once. If that request fails — and offline it fails
 * immediately, because the service worker has no cached copy to answer with —
 * the tile is marked errored and is never asked for again. Reconnecting does
 * not help, because nothing tells the map that anything has changed. Nothing
 * in this app was listening for `online` at all.
 *
 * The second half of the report is the same fault seen from the other side:
 * the tiles that DO eventually appear are the ones requested after the network
 * returned, which are wherever the camera has since travelled to. The area the
 * vehicle was in when the connection dropped stays permanently empty, so the
 * map looks like it "loaded the place that came after".
 *
 * ★ WHY setTiles AND NOT A STYLE RELOAD ★
 * Three things can force a refetch, and they are not equally destructive:
 *
 *   sourceCache.reload()  — reaches into MapLibre's internals; different
 *                           between versions, and silently absent when it
 *                           changes.
 *   source.setTiles(...)  — public API. Re-declaring the same URL template
 *                           invalidates the source's tiles and re-requests
 *                           the ones currently on screen. Nothing else moves.
 *   map.setStyle(...)     — works, and flashes the whole map while discarding
 *                           every layer this app added on top of it: the
 *                           trail, the marker, the matched road, the offline
 *                           basemap. Visually it reads as a crash.
 *
 * So: setTiles, and no fallback to setStyle. If setTiles is unavailable the
 * honest outcome is that tiles stay missing until the user pans — which is
 * exactly what the offline basemap underneath is there to make survivable.
 *
 * Note this component is only half the fix, and the smaller half.
 * OfflineBasemapLayer draws roads from the road graph beneath the tiles, so a
 * missing tile is a dimmer map rather than a blank one whether or not this
 * ever fires.
 */

interface RasterSourceLike {
  setTiles?: (tiles: string[]) => void;
  tiles?: string[];
}

/** Sources this app declares; see config/map.ts. */
const TILE_SOURCE_IDS = ['osm'];

export default function TileRefresh() {
  const map = useMap();
  /**
   * Whether anything actually failed since the last refresh.
   *
   * Without this, every `online` event refetches tiles that were never
   * missing. Phones raise `online` on every transition between wifi and
   * cellular, and on some devices when the screen unlocks — so an
   * unconditional refresh would mean re-downloading the visible map several
   * times on an ordinary drive, which is the opposite of what an offline-first
   * app should do to somebody's data.
   */
  const sawError = useRef(false);

  useEffect(() => {
    if (!map) return;

    const onError = (e: unknown) => {
      const sourceId = (e as { sourceId?: string })?.sourceId;
      if (sourceId && TILE_SOURCE_IDS.includes(sourceId)) sawError.current = true;
    };

    const refresh = () => {
      if (!sawError.current) return;
      sawError.current = false;
      for (const id of TILE_SOURCE_IDS) {
        try {
          const source = map.getSource(id) as RasterSourceLike | undefined;
          // Re-declaring the SAME template is the point: it is not a change of
          // URL, it is an instruction to forget what was tried and ask again.
          if (source?.setTiles && Array.isArray(source.tiles)) source.setTiles([...source.tiles]);
        } catch {
          // A source that has gone away mid-refresh is not worth a crash on a
          // presentation-only path.
        }
      }
    };

    map.on('error', onError);
    window.addEventListener('online', refresh);
    // Coming back from the lock screen is not an `online` event, and it is the
    // other way the tester saw a blank map.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      map.off('error', onError);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [map]);

  return null;
}
