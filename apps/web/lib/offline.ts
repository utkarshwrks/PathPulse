/**
 * Service-worker registration and tile-cache queries.
 *
 * The arithmetic lives in `tileCache.ts` and is unit tested; this file is the
 * thin layer that actually talks to the browser, kept separate so the maths
 * never needs a DOM to be checked.
 *
 * Every function here degrades rather than throws. A browser with no service
 * worker, a private window with no Cache Storage, a WebView that refuses
 * registration — none of those may take the app down, because the navigation
 * engine does not need any of it. The map is presentation; the estimate is the
 * product.
 */

export type MapSourceKind = 'network' | 'cached' | 'mixed';

export interface OfflineCapability {
  /** The browser exposes a service worker at all. */
  supported: boolean;
  /** A worker is registered and controlling this page. */
  active: boolean;
  reason?: string;
}

const SW_URL = '/sw.js';

export function serviceWorkerSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof caches !== 'undefined'
  );
}

/**
 * Register the tile-caching worker.
 *
 * Never rejects. A failure here means the offline demo is unavailable, which
 * is worth reporting on screen — it is not worth a blank page.
 */
export async function registerTileWorker(): Promise<OfflineCapability> {
  if (!serviceWorkerSupported()) {
    return { supported: false, active: false, reason: 'No service worker in this browser' };
  }
  // A service worker needs a secure context. Over plain http on a LAN — the
  // documented way this project is tested on a phone without the APK — it is
  // simply absent, and saying so beats an unexplained missing feature.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      supported: false,
      active: false,
      reason: 'Insecure origin — use the APK or dev:https',
    };
  }
  try {
    const reg = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
    return { supported: true, active: Boolean(reg.active ?? navigator.serviceWorker.controller) };
  } catch (e) {
    return {
      supported: true,
      active: false,
      reason: e instanceof Error ? e.message : 'Registration failed',
    };
  }
}

/** How many tiles are currently stored. Zero on any failure. */
export async function cachedTileCount(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  try {
    const names = await caches.keys();
    let total = 0;
    for (const name of names) {
      if (!name.startsWith('pathpulse-tiles-')) continue;
      const cache = await caches.open(name);
      total += (await cache.keys()).length;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Discard every stored tile. Used by the debug panel, and before a re-test. */
export async function clearTileCache(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('pathpulse-tiles-')).map((n) => caches.delete(n)),
    );
    return true;
  } catch {
    return false;
  }
}

export interface PrecacheProgress {
  done: number;
  total: number;
  failed: number;
  finished: boolean;
}

/**
 * Ask the worker to fetch and store a list of tile URLs.
 *
 * Resolves when the worker reports completion. If no worker is controlling the
 * page there is nothing to ask, and the caller is told immediately rather than
 * waiting on a message that will never arrive.
 */
export function precacheTiles(
  urls: string[],
  onProgress?: (p: PrecacheProgress) => void,
): Promise<PrecacheProgress> {
  const empty: PrecacheProgress = { done: 0, total: urls.length, failed: 0, finished: true };
  if (!serviceWorkerSupported()) return Promise.resolve(empty);
  const worker = navigator.serviceWorker.controller;
  if (!worker) return Promise.resolve(empty);

  return new Promise((resolve) => {
    function handle(event: MessageEvent) {
      const data = event.data as
        | { type: string; done: number; total: number; failed: number }
        | undefined;
      if (!data) return;
      if (data.type === 'PRECACHE_PROGRESS') {
        onProgress?.({ ...data, finished: false });
      } else if (data.type === 'PRECACHE_DONE') {
        navigator.serviceWorker.removeEventListener('message', handle);
        const final = { ...data, finished: true };
        onProgress?.(final);
        resolve(final);
      }
    }
    navigator.serviceWorker.addEventListener('message', handle);
    worker.postMessage({ type: 'PRECACHE_TILES', urls });
  });
}
