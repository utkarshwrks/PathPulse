import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOfflineStatus } from './useOfflineStatus';

/**
 * The offline status hook.
 *
 * The one that matters is the mount read of navigator.onLine: the static
 * export renders `online: true`, so a phone that opens the app already in
 * aeroplane mode would be told it was connected until the next transition —
 * which, in aeroplane mode, never comes.
 */

vi.mock('@/lib/offline', () => ({
  registerTileWorker: vi.fn().mockResolvedValue({ supported: true, active: true }),
  cachedTileCount: vi.fn().mockResolvedValue(7),
  clearTileCache: vi.fn().mockResolvedValue(true),
  precacheTiles: vi.fn().mockResolvedValue({ done: 2, total: 2, failed: 0, finished: true }),
}));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true, writable: true });
}

afterEach(() => {
  setOnline(true);
  vi.clearAllMocks();
});

describe('useOfflineStatus', () => {
  it('★ reads the real online state on mount, not the SSR default', async () => {
    setOnline(false);
    const { result } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.online).toBe(false));
  });

  it('tracks online and offline events', async () => {
    setOnline(true);
    const { result } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.online).toBe(true));

    await act(async () => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.online).toBe(false);

    await act(async () => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current.online).toBe(true);
  });

  it('registers the worker and reports the cached tile count', async () => {
    const { result } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.capability.active).toBe(true));
    await waitFor(() => expect(result.current.cachedTiles).toBe(7));
  });

  it('runs a download and refreshes the count afterwards', async () => {
    const { result } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.capability.active).toBe(true));
    await act(async () => {
      await result.current.download(['a', 'b']);
    });
    const { precacheTiles } = await import('@/lib/offline');
    expect(precacheTiles).toHaveBeenCalled();
  });

  it('clears the cache on request', async () => {
    const { result } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.capability.active).toBe(true));
    await act(async () => {
      await result.current.clear();
    });
    const { clearTileCache } = await import('@/lib/offline');
    expect(clearTileCache).toHaveBeenCalled();
  });

  it('does not set state after unmount', async () => {
    const { result, unmount } = renderHook(() => useOfflineStatus());
    await waitFor(() => expect(result.current.capability.active).toBe(true));
    expect(() => unmount()).not.toThrow();
  });
});
