import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedTileCount,
  clearTileCache,
  precacheTiles,
  registerTileWorker,
  serviceWorkerSupported,
} from './offline';

/**
 * The service-worker layer.
 *
 * Everything here must degrade rather than throw. A browser with no service
 * worker, a private window with no Cache Storage, a WebView that refuses
 * registration — none of those may take the app down, because the navigation
 * engine needs none of it. Losing the basemap is a bad demo; a blank screen is
 * a failed one.
 */

const originalNavigator = globalThis.navigator;
const originalCaches = (globalThis as { caches?: unknown }).caches;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

function setCaches(value: unknown) {
  Object.defineProperty(globalThis, 'caches', {
    value,
    configurable: true,
    writable: true,
  });
}

/** jsdom does not define isSecureContext, so it cannot be spied on. */
function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setNavigator(originalNavigator);
  setCaches(originalCaches);
  vi.restoreAllMocks();
});

describe('serviceWorkerSupported', () => {
  it('is false when the browser has no service worker', () => {
    setNavigator({});
    setCaches({});
    expect(serviceWorkerSupported()).toBe(false);
  });

  it('is false when Cache Storage is missing, even with a worker', () => {
    // Private windows in some browsers expose one and not the other.
    setNavigator({ serviceWorker: {} });
    setCaches(undefined);
    expect(serviceWorkerSupported()).toBe(false);
  });
});

describe('registerTileWorker', () => {
  it('reports unsupported rather than throwing', async () => {
    setNavigator({});
    setCaches({});
    const cap = await registerTileWorker();
    expect(cap.supported).toBe(false);
    expect(cap.active).toBe(false);
    expect(cap.reason).toBeTruthy();
  });

  it('★ explains an insecure origin instead of failing silently', async () => {
    // Testing on a phone over plain http on the LAN is a documented workflow
    // in this repo. A service worker is simply absent there, and "unavailable"
    // with no reason is indistinguishable from a bug.
    setNavigator({ serviceWorker: { register: vi.fn() } });
    setCaches({});
    setSecureContext(false);
    const cap = await registerTileWorker();
    expect(cap.active).toBe(false);
    expect(cap.reason).toMatch(/insecure/i);
  });

  it('reports the error when registration is refused', async () => {
    setNavigator({
      serviceWorker: {
        register: vi.fn().mockRejectedValue(new Error('blocked by policy')),
        ready: Promise.resolve(),
      },
    });
    setCaches({});
    setSecureContext(true);
    const cap = await registerTileWorker();
    expect(cap.supported).toBe(true);
    expect(cap.active).toBe(false);
    expect(cap.reason).toBe('blocked by policy');
  });

  it('reports active on a successful registration', async () => {
    setNavigator({
      serviceWorker: {
        register: vi.fn().mockResolvedValue({ active: {} }),
        ready: Promise.resolve(),
        controller: {},
      },
    });
    setCaches({});
    setSecureContext(true);
    const cap = await registerTileWorker();
    expect(cap.supported).toBe(true);
    expect(cap.active).toBe(true);
  });
});

describe('cachedTileCount', () => {
  it('counts only PathPulse tile caches, not every cache on the origin', () => {
    setCaches({
      keys: async () => ['pathpulse-tiles-v1', 'next-static', 'other'],
      open: async (name: string) => ({
        keys: async () => (name === 'pathpulse-tiles-v1' ? [1, 2, 3] : [1, 1, 1, 1, 1]),
      }),
    });
    return expect(cachedTileCount()).resolves.toBe(3);
  });

  it('returns zero rather than throwing when Cache Storage is unavailable', async () => {
    setCaches(undefined);
    await expect(cachedTileCount()).resolves.toBe(0);
  });

  it('returns zero when the cache API rejects', async () => {
    setCaches({ keys: async () => { throw new Error('denied'); } });
    await expect(cachedTileCount()).resolves.toBe(0);
  });
});

describe('clearTileCache', () => {
  it('deletes only the tile caches', async () => {
    const deleted: string[] = [];
    setCaches({
      keys: async () => ['pathpulse-tiles-v1', 'next-static'],
      delete: async (n: string) => {
        deleted.push(n);
        return true;
      },
    });
    await expect(clearTileCache()).resolves.toBe(true);
    expect(deleted).toEqual(['pathpulse-tiles-v1']);
  });

  it('reports failure rather than throwing', async () => {
    setCaches(undefined);
    await expect(clearTileCache()).resolves.toBe(false);
  });
});

describe('precacheTiles', () => {
  it('★ resolves immediately when no worker controls the page', async () => {
    // Otherwise the UI waits for ever on a message that will never arrive, and
    // the progress bar sits at zero looking like a hung download.
    setNavigator({ serviceWorker: { controller: null } });
    setCaches({});
    const result = await precacheTiles(['a', 'b']);
    expect(result.finished).toBe(true);
    expect(result.total).toBe(2);
    expect(result.done).toBe(0);
  });

  it('resolves immediately when service workers are unsupported', async () => {
    setNavigator({});
    setCaches({});
    await expect(precacheTiles(['a'])).resolves.toMatchObject({ finished: true });
  });

  it('posts the urls and resolves on the worker’s completion message', async () => {
    const listeners: Array<(e: MessageEvent) => void> = [];
    const posted: unknown[] = [];
    setNavigator({
      serviceWorker: {
        controller: { postMessage: (m: unknown) => posted.push(m) },
        addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
        removeEventListener: () => {},
      },
    });
    setCaches({});

    const progressSeen: number[] = [];
    const pending = precacheTiles(['u1', 'u2'], (p) => progressSeen.push(p.done));

    expect(posted).toEqual([{ type: 'PRECACHE_TILES', urls: ['u1', 'u2'] }]);
    listeners.forEach((fn) =>
      fn({ data: { type: 'PRECACHE_PROGRESS', done: 1, total: 2, failed: 0 } } as MessageEvent),
    );
    listeners.forEach((fn) =>
      fn({ data: { type: 'PRECACHE_DONE', done: 2, total: 2, failed: 0 } } as MessageEvent),
    );

    const result = await pending;
    expect(result).toMatchObject({ done: 2, total: 2, failed: 0, finished: true });
    expect(progressSeen).toContain(1);
  });

  it('ignores unrelated worker messages', async () => {
    const listeners: Array<(e: MessageEvent) => void> = [];
    setNavigator({
      serviceWorker: {
        controller: { postMessage: () => {} },
        addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
        removeEventListener: () => {},
      },
    });
    setCaches({});

    let settled = false;
    const pending = precacheTiles(['u1']).then((r) => {
      settled = true;
      return r;
    });

    listeners.forEach((fn) => fn({ data: undefined } as MessageEvent));
    listeners.forEach((fn) => fn({ data: { type: 'SOMETHING_ELSE' } } as MessageEvent));
    await Promise.resolve();
    expect(settled).toBe(false);

    listeners.forEach((fn) =>
      fn({ data: { type: 'PRECACHE_DONE', done: 1, total: 1, failed: 0 } } as MessageEvent),
    );
    await expect(pending).resolves.toMatchObject({ finished: true });
  });
});
