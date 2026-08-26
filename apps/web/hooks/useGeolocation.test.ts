import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeolocation } from './useGeolocation';

/** GeolocationPositionError codes are not defined in jsdom; mirror the spec. */
const ERR = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as const;

function makeError(code: number, message = 'mock error') {
  return { code, message, ...ERR };
}

function makePosition(over: Partial<GeolocationCoordinates> = {}) {
  return {
    coords: {
      latitude: 28.6315,
      longitude: 77.2167,
      accuracy: 4.2,
      speed: 12.5,
      heading: 90,
      altitude: 216,
      altitudeAccuracy: 3,
      ...over,
    },
    timestamp: 1_700_000_000_000,
  };
}

let watchPosition: ReturnType<typeof vi.fn>;
let clearWatch: ReturnType<typeof vi.fn>;
/** Captured callbacks so tests can drive the platform. */
let onSuccess: (p: unknown) => void;
let onError: (e: unknown) => void;

function setSecureContext(secure: boolean) {
  Object.defineProperty(globalThis.window, 'isSecureContext', {
    value: secure,
    configurable: true,
  });
}

beforeEach(() => {
  setSecureContext(true);
  onSuccess = () => {};
  onError = () => {};
  watchPosition = vi.fn((succ: (p: unknown) => void, err: (e: unknown) => void) => {
    onSuccess = succ;
    onError = err;
    return 42; // watch id
  });
  clearWatch = vi.fn();
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useGeolocation — options', () => {
  it('requests high accuracy and refuses cached fixes', () => {
    renderHook(() => useGeolocation(true));
    const opts = watchPosition.mock.calls[0]![2];
    expect(opts.enableHighAccuracy).toBe(true);
    // A cached fix would misrepresent the true update cadence on the HUD.
    expect(opts.maximumAge).toBe(0);
    expect(opts.timeout).toBe(5000);
  });

  it('does not start watching unless asked', () => {
    renderHook(() => useGeolocation(false));
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('does not open a second watch when start is called twice', () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => result.current.start());
    act(() => result.current.start());
    expect(watchPosition).toHaveBeenCalledTimes(1);
  });
});

describe('useGeolocation — fixes', () => {
  it('surfaces a fix and counts it', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onSuccess(makePosition()));

    await waitFor(() => expect(result.current.fix).not.toBeNull());
    expect(result.current.fix).toMatchObject({
      lat: 28.6315,
      lon: 77.2167,
      accuracyM: 4.2,
      speedMps: 12.5,
      headingDeg: 90,
    });
    expect(result.current.status).toBe('watching');
    expect(result.current.fixCount).toBe(1);
  });

  it('counts successive fixes so the HUD can prove the watch is alive', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onSuccess(makePosition()));
    act(() => onSuccess(makePosition({ latitude: 28.64 })));
    await waitFor(() => expect(result.current.fixCount).toBe(2));
  });

  it('normalises missing speed and heading to null, not 0', async () => {
    // A stationary phone reports null; coercing that to 0 would be a lie the
    // HUD then renders as "0 km/h, heading north".
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onSuccess(makePosition({ speed: null, heading: null })));
    await waitFor(() => expect(result.current.fix).not.toBeNull());
    expect(result.current.fix!.speedMps).toBeNull();
    expect(result.current.fix!.headingDeg).toBeNull();
  });

  it('rejects NaN speed and heading', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onSuccess(makePosition({ speed: NaN, heading: NaN })));
    await waitFor(() => expect(result.current.fix).not.toBeNull());
    expect(result.current.fix!.speedMps).toBeNull();
    expect(result.current.fix!.headingDeg).toBeNull();
  });

  it('clears a previous error once a fix arrives', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onError(makeError(ERR.TIMEOUT)));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => onSuccess(makePosition()));
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

describe('useGeolocation — failure modes', () => {
  it('stops watching when permission is denied', async () => {
    // Retrying a denied watch just spins and drains battery.
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onError(makeError(ERR.PERMISSION_DENIED, 'denied')));
    await waitFor(() => expect(result.current.status).toBe('denied'));
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(result.current.error).toMatch(/denied/i);
  });

  it('keeps watching through a timeout — that is normal indoors', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onError(makeError(ERR.TIMEOUT)));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Must NOT tear down: the fix usually arrives on a later attempt.
    expect(clearWatch).not.toHaveBeenCalled();
    expect(result.current.status).not.toBe('denied');
  });

  it('reports position unavailable without tearing down', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => onError(makeError(ERR.POSITION_UNAVAILABLE)));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(clearWatch).not.toHaveBeenCalled();
  });

  it('names the insecure origin instead of blaming the user', async () => {
    // Chrome does NOT prompt on an http:// LAN origin — it fires
    // PERMISSION_DENIED instantly. Reporting that as "you denied it" sends
    // people to a browser setting that cannot fix it.
    setSecureContext(false);
    const { result } = renderHook(() => useGeolocation(true));
    await waitFor(() => expect(result.current.status).toBe('insecure'));
    expect(result.current.error).toMatch(/secure context/i);
    // Do not even open a watch that is guaranteed to fail.
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('still watches normally on a secure origin', () => {
    setSecureContext(true);
    renderHook(() => useGeolocation(true));
    expect(watchPosition).toHaveBeenCalledTimes(1);
  });

  it('degrades cleanly when the browser has no Geolocation API', async () => {
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      value: undefined,
      configurable: true,
    });
    const { result } = renderHook(() => useGeolocation(true));
    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(result.current.fix).toBeNull();
  });
});

describe('useGeolocation — lifecycle', () => {
  it('clears the watch on unmount so it does not leak', () => {
    const { unmount } = renderHook(() => useGeolocation(true));
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  it('stop() clears the watch and returns to idle', async () => {
    const { result } = renderHook(() => useGeolocation(true));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(clearWatch).toHaveBeenCalledWith(42);
  });
});
