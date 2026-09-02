'use client';

import { useEffect } from 'react';
import { startKeepAlive } from '@/lib/keepAlive';

/**
 * Keeps a free-tier host awake while somebody has the app open.
 *
 * Also pings immediately when the tab becomes visible again: a phone that has
 * been in a pocket has had its timers throttled to nothing, so the scheduled
 * ping may not have fired for minutes and the service may already be cold.
 * The moment the screen comes back is exactly when the next request is about
 * to happen, so that is the moment worth spending a ping on.
 *
 * See lib/keepAlive.ts for what this can and cannot do — in particular, it
 * does nothing at all once the last tab closes.
 */
export function useKeepAlive(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handle = startKeepAlive();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void handle.pingNow();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      handle.stop();
    };
  }, [enabled]);
}
