'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoadGraph } from '@pathpulse/nav-core';
import { cellBBox, type CellId, type Lod } from '@/lib/graphCells';
import {
  GraphCellStore,
  getSharedCellStore,
  requestPersistentStorage,
} from '@/lib/graphCellStore';
import { GraphPrefetcher, type PrefetchStats } from '@/lib/graphPrefetch';
import { RollingCoverage } from '@/lib/rollingCoverage';
import { fetchRoadGraph, type BBox } from '@/lib/roadGraphFetch';

/**
 * Drives background coverage acquisition from the vehicle's position.
 *
 * Deliberately thin. Everything worth testing — what to fetch, in what order,
 * how to back off, when to refuse — lives in lib/graphPrefetch.ts and
 * lib/graphCellStore.ts, where it is testable without a browser. This hook is
 * the wiring: it decides WHEN to re-target and hands over the platform pieces
 * (network, storage, connection type) that cannot exist in a unit test.
 */

const STORAGE_KEY = 'pathpulse.prefetch.allowMetered';

interface NetworkInformation {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
}

/**
 * Is this connection one we should not spend?
 *
 * ★ CONSERVATIVE WHEN UNSURE, BUT NOT PARANOID ★
 * `navigator.connection` is Chromium-only, so on anything else this cannot be
 * answered. Treating unknown as metered would disable the feature on those
 * browsers entirely; treating it as unmetered would spend a stranger's data
 * plan. The compromise is to believe an explicit signal — saveData, or a
 * cellular `type` — and otherwise proceed, because the amounts involved are
 * single-digit MB and the user can switch it off.
 */
function connectionIsMetered(): boolean {
  try {
    const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!conn) return false;
    if (conn.saveData === true) return true;
    if (conn.type === 'cellular') return true;
    // 2g on any transport is slow enough that a 3 MB fetch is antisocial
    // regardless of who is paying for it.
    return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
  } catch {
    return false;
  }
}

function readAllowMetered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * How far the vehicle must move before coverage is re-evaluated, metres.
 *
 * This is NOT the re-anchor threshold — RollingCoverage owns that, at 20 km
 * with a two-minute floor. This is only how often we bother asking, because
 * `roll()` scans stored cell metadata to evict and doing that at the engine's
 * 10 Hz would be pointless work on every frame.
 */
const ROLL_CHECK_DISTANCE_M = 1_000;
const ROLL_CHECK_INTERVAL_MS = 30_000;

export interface GraphPrefetchState {
  stats: PrefetchStats;
  persistence: 'granted' | 'denied' | 'unsupported' | 'pending';
  allowMetered: boolean;
  setAllowMetered: (v: boolean) => void;
  bytesStored: number;
  store: GraphCellStore;
  /** Where coverage is currently centred, which leads the vehicle. */
  anchor: { lat: number; lon: number } | null;
}

export function useGraphPrefetch(
  position: { lat: number; lon: number } | null,
  headingDeg: number | null,
  enabled = true,
): GraphPrefetchState {
  const store = useMemo(() => getSharedCellStore(), []);
  const [persistence, setPersistence] = useState<GraphPrefetchState['persistence']>('pending');
  const [allowMetered, setAllowMeteredState] = useState(false);
  const [stats, setStats] = useState<PrefetchStats>({
    queued: 0,
    fetched: 0,
    failed: 0,
    skipped: 0,
    running: false,
    lastError: null,
  });
  const [bytesStored, setBytesStored] = useState(0);

  const allowMeteredRef = useRef(false);
  const lastCheckRef = useRef<{ lat: number; lon: number; atMs: number } | null>(null);
  const rollingRef = useRef<RollingCoverage | null>(null);
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    const v = readAllowMetered();
    allowMeteredRef.current = v;
    setAllowMeteredState(v);
  }, []);

  const setAllowMetered = useCallback((v: boolean) => {
    allowMeteredRef.current = v;
    setAllowMeteredState(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      // A refused write only costs the preference across restarts.
    }
  }, []);

  // Ask once. See requestPersistentStorage for why refusal is normal.
  useEffect(() => {
    let cancelled = false;
    void requestPersistentStorage().then((r) => {
      if (!cancelled) setPersistence(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const prefetcher = useMemo(() => {
    const fetchCell = async (cell: CellId, lod: Lod, signal: AbortSignal): Promise<RoadGraph> => {
      const [minLon, minLat, maxLon, maxLat] = cellBBox(cell);
      const bbox: BBox = { minLon, minLat, maxLon, maxLat };
      return fetchRoadGraph(bbox, signal, lod === 'major' ? 'major' : 'full');
    };
    return new GraphPrefetcher({
      store,
      fetchCell,
      isMetered: connectionIsMetered,
      allowMetered: () => allowMeteredRef.current,
    });
  }, [store]);

  rollingRef.current ??= new RollingCoverage(store);

  /*
   * ★ RE-TARGETING IS RollingCoverage'S DECISION, NOT THIS HOOK'S ★
   * Rebuilding the plan discards whatever the prefetcher had in flight, so
   * doing it on every position update means the queue never drains and the
   * same first few cells are fetched for ever. RollingCoverage holds the
   * hysteresis — 20 km travelled AND two minutes since the last move — and
   * this only decides how often to ask it.
   */
  useEffect(() => {
    if (!enabled || !position) return;
    const now = Date.now();
    const last = lastCheckRef.current;
    const movedM = last
      ? Math.hypot(
          (position.lat - last.lat) * 110_574,
          (position.lon - last.lon) * 111_320 * Math.cos((position.lat * Math.PI) / 180),
        )
      : Infinity;
    if (last && movedM < ROLL_CHECK_DISTANCE_M && now - last.atMs < ROLL_CHECK_INTERVAL_MS) return;
    lastCheckRef.current = { lat: position.lat, lon: position.lon, atMs: now };

    const rolling = rollingRef.current;
    if (!rolling) return;
    void rolling.roll(position.lat, position.lon, headingDeg, now).then((res) => {
      if (res.anchor) setAnchor({ lat: res.anchor.lat, lon: res.anchor.lon });
      if (res.reanchored && res.anchor) {
        prefetcher.setTarget(res.anchor.lat, res.anchor.lon, headingDeg);
      }
    });
  }, [enabled, position, headingDeg, prefetcher, store]);

  useEffect(() => () => prefetcher.stop(), [prefetcher]);

  // Poll for display only. The prefetcher is the source of truth and does not
  // depend on anyone watching it.
  useEffect(() => {
    const id = window.setInterval(() => {
      setStats(prefetcher.snapshot);
      void store.totalBytes().then(setBytesStored);
    }, 2000);
    return () => window.clearInterval(id);
  }, [prefetcher, store]);

  return { stats, persistence, allowMetered, setAllowMetered, bytesStored, store, anchor };
}
