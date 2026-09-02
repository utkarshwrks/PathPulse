/**
 * Keeping a free-tier host awake, and being honest about what that can do.
 *
 * ★ READ THIS BEFORE TRUSTING IT ★
 * Render (and Fly, and Railway) suspend a free *Web Service* after ~15 minutes
 * with no inbound request, and the next visitor then waits ~30-60 s for a cold
 * start. On a judging day that is the difference between a demo and an
 * apology.
 *
 * Two things must be said plainly:
 *
 * 1. **A Render Static Site does not sleep at all.** This app is
 *    `output: 'export'` — a folder of static files — so deployed as a Static
 *    Site the problem does not exist and this module is inert insurance.
 *    Deploy it that way if you can.
 *
 * 2. **A browser ping only helps while a browser is open.** This keeps the
 *    service warm during a session — which is the case that actually matters,
 *    because a judge reading the landing page keeps it warm for the moment
 *    they press Download. It CANNOT keep a service warm overnight. For that
 *    you need an external pinger (UptimeRobot, cron-job.org, GitHub Actions
 *    cron) hitting /health.json on a schedule, and `render.yaml` documents it.
 *
 * Anything claiming otherwise would be a keep-alive that quietly does nothing,
 * which is worse than none — you would stop checking.
 */

/** Five minutes: comfortably inside a 15-minute idle window, three pings deep. */
export const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;

/** Where the health document lives. Relative, so it works under any base path. */
export const HEALTH_PATH = 'health.json';

export interface KeepAliveOptions {
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  intervalMs?: number;
  path?: string;
  onResult?: (ok: boolean, at: number) => void;
}

export interface KeepAliveHandle {
  stop: () => void;
  /** Ping now, outside the schedule. Used when a tab becomes visible again. */
  pingNow: () => Promise<boolean>;
}

/**
 * Ping the health document on an interval while the page is open.
 *
 * ★ WHY `no-store` AND A CACHE-BUSTING PARAM ★
 * A cached response never leaves the browser, so the host never sees a request
 * and the service sleeps anyway — a keep-alive that appears to work in the
 * network panel and does nothing at the origin. Both are needed: `no-store`
 * for the browser, the query parameter for any CDN in front of it.
 */
export function startKeepAlive(opts: KeepAliveOptions = {}): KeepAliveHandle {
  const {
    fetchFn = globalThis.fetch?.bind(globalThis),
    intervalMs = KEEP_ALIVE_INTERVAL_MS,
    path = HEALTH_PATH,
    onResult,
  } = opts;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const ping = async (): Promise<boolean> => {
    if (stopped || !fetchFn) return false;
    try {
      const res = await fetchFn(`${path}?t=${Date.now()}`, {
        cache: 'no-store',
        // A HEAD would be cheaper, but some static hosts answer HEAD from an
        // edge cache without ever waking the origin, which is the one thing
        // this exists to prevent.
        method: 'GET',
      });
      const ok = res.ok;
      onResult?.(ok, Date.now());
      return ok;
    } catch {
      // Offline is normal in this app — the whole point is that it navigates
      // without a network. A failed ping must never surface as an error.
      onResult?.(false, Date.now());
      return false;
    }
  };

  void ping();
  timer = setInterval(() => void ping(), intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    pingNow: ping,
  };
}
