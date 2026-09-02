import { describe, expect, it, vi } from 'vitest';
import { KEEP_ALIVE_INTERVAL_MS, startKeepAlive } from './keepAlive';

describe('keep-alive', () => {
  it('pings five minutes apart — three times inside a 15-minute idle window', () => {
    // The interval is the whole design: a host that suspends after 15 minutes
    // must be touched several times inside it, so one missed ping is survivable.
    expect(KEEP_ALIVE_INTERVAL_MS).toBe(300_000);
    expect(15 * 60_000 / KEEP_ALIVE_INTERVAL_MS).toBeGreaterThanOrEqual(3);
  });

  it('pings immediately rather than waiting out the first interval', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const h = startKeepAlive({ fetchFn: fetchFn as unknown as typeof fetch });
    await Promise.resolve();
    // A cold service must be woken now, not in five minutes.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('★ defeats the cache, or the origin is never reached', async () => {
    // A cached response never leaves the browser, so the host sees nothing and
    // sleeps anyway — a keep-alive that looks alive in the network panel and
    // does nothing where it matters.
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const h = startKeepAlive({ fetchFn: fetchFn as unknown as typeof fetch });
    await Promise.resolve();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toMatch(/health\.json\?t=\d+/);
    expect((init as RequestInit).cache).toBe('no-store');
    h.stop();
  });

  it('keeps pinging on the interval until stopped', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const h = startKeepAlive({ fetchFn: fetchFn as unknown as typeof fetch, intervalMs: 1000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    h.stop();
    vi.advanceTimersByTime(5000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('never throws when offline — this app is meant to work without a network', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const seen: boolean[] = [];
    const h = startKeepAlive({
      fetchFn: fetchFn as unknown as typeof fetch,
      onResult: (ok) => seen.push(ok),
    });
    await expect(h.pingNow()).resolves.toBe(false);
    expect(seen).toContain(false);
    h.stop();
  });

  it('stops cleanly and reports failure without a fetch implementation', async () => {
    const h = startKeepAlive({ fetchFn: undefined as unknown as typeof fetch });
    await expect(h.pingNow()).resolves.toBe(false);
    h.stop();
  });
});
