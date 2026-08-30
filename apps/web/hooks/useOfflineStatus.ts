'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cachedTileCount,
  clearTileCache,
  precacheTiles,
  registerTileWorker,
  type OfflineCapability,
  type PrecacheProgress,
} from '@/lib/offline';

export interface OfflineStatus {
  /** navigator.onLine, tracked live. */
  online: boolean;
  capability: OfflineCapability;
  cachedTiles: number;
  /** Non-null while a pre-cache is running. */
  progress: PrecacheProgress | null;
  download: (urls: string[]) => Promise<void>;
  clear: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Network state, worker state, and how much of the map is stored locally.
 *
 * `navigator.onLine` is famously optimistic — it reports the interface being
 * up, not the internet being reachable — but for the demo it answers exactly
 * the right question, because aeroplane mode does take the interface down.
 * It is labelled "radio" in the UI rather than "internet" for that reason.
 */
export function useOfflineStatus(): OfflineStatus {
  const [online, setOnline] = useState(true);
  const [capability, setCapability] = useState<OfflineCapability>({
    supported: false,
    active: false,
  });
  const [cachedTiles, setCachedTiles] = useState(0);
  const [progress, setProgress] = useState<PrecacheProgress | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const count = await cachedTileCount();
    if (mounted.current) setCachedTiles(count);
  }, []);

  useEffect(() => {
    // Read the real value on mount rather than trusting the SSR default: the
    // static export renders `online: true`, and a phone that opened the app
    // already in aeroplane mode would otherwise be told it was connected.
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine);

    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);

    void registerTileWorker().then(async (cap) => {
      if (!mounted.current) return;
      setCapability(cap);
      await refresh();
    });

    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [refresh]);

  const download = useCallback(
    async (urls: string[]) => {
      setProgress({ done: 0, total: urls.length, failed: 0, finished: false });
      await precacheTiles(urls, (p) => {
        if (mounted.current) setProgress(p);
      });
      await refresh();
      // Leave the finished figure on screen for a moment — a progress bar that
      // vanishes the instant it completes leaves the user unsure it ran.
      window.setTimeout(() => {
        if (mounted.current) setProgress(null);
      }, 2500);
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    await clearTileCache();
    await refresh();
  }, [refresh]);

  return { online, capability, cachedTiles, progress, download, clear, refresh };
}
