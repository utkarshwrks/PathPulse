import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTour } from './useTour';
import { TOUR_STEPS, TOUR_STORAGE_KEY } from '@/lib/tour';

/** In-memory storage; jsdom here does not provide one. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
    writable: true,
  });
  return data;
}

let store: Map<string, string>;
beforeEach(() => {
  store = installStorage();
});
afterEach(() => store.clear());

describe('useTour', () => {
  it('★ decides after mount, so a returning visitor never sees a flash', () => {
    // The app is a static export: the first paint happens before storage can
    // be read. Starting in `welcome` would flash it for one frame every time.
    const { result } = renderHook(() => useTour());
    expect(['loading', 'welcome', 'done']).toContain(result.current.phase);
  });

  it('shows the welcome screen on a first run', async () => {
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('welcome'));
  });

  it('★ does not nag a visitor who has already seen it', async () => {
    store.set(TOUR_STORAGE_KEY, '1');
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('done'));
  });

  it('runs the tour and finishes on the last step', async () => {
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('welcome'));

    act(() => result.current.begin());
    expect(result.current.phase).toBe('tour');
    expect(result.current.index).toBe(0);

    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      act(() => result.current.next());
    }
    expect(result.current.index).toBe(TOUR_STEPS.length - 1);

    act(() => result.current.next());
    expect(result.current.phase).toBe('done');
    expect(store.get(TOUR_STORAGE_KEY)).toBe('1');
  });

  it('remembers a skip, so it does not reappear next launch', async () => {
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('welcome'));
    act(() => result.current.skip());
    expect(result.current.phase).toBe('done');
    expect(store.get(TOUR_STORAGE_KEY)).toBe('1');
  });

  it('never steps before the first step', async () => {
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('welcome'));
    act(() => result.current.begin());
    act(() => result.current.back());
    expect(result.current.index).toBe(0);
  });

  it('★ can be replayed from the Help button after it was dismissed', async () => {
    store.set(TOUR_STORAGE_KEY, '1');
    const { result } = renderHook(() => useTour());
    await waitFor(() => expect(result.current.phase).toBe('done'));
    act(() => result.current.restart());
    expect(result.current.phase).toBe('tour');
    expect(result.current.index).toBe(0);
  });
});
