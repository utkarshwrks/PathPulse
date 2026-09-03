'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  countTilesForBounds,
  estimateBytes,
  formatBytes,
  tileUrl,
  tilesForBounds,
  MAX_PRECACHE_TILES,
  type LatLonBounds,
} from '@/lib/tileCache';
import type { OfflineStatus } from '@/hooks/useOfflineStatus';
import {
  MAX_AREA_SQ_KM,
  RoadGraphFetchError,
  areaSqKm,
  boundsToBBox,
  fetchRoadGraph,
} from '@/lib/roadGraphFetch';
import { deleteStoredGraphs, saveGraph } from '@/lib/roadGraphStore';
import { findGraphFor } from '@/lib/roadGraph';

/** Zoom range stored for an area: wide enough to pan, sharp enough to drive. */
export const PRECACHE_MIN_ZOOM = 12;
export const PRECACHE_MAX_ZOOM = 16;

const TILE_TEMPLATE = 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png';

interface OfflinePanelProps {
  status: OfflineStatus;
  /** Current map viewport, or null before the map is ready. */
  bounds: LatLonBounds | null;
  mapSourceLabel: string;
  /** Where the vehicle currently is, for checking road-graph coverage. */
  position: { lat: number; lon: number } | null;
  /** Called after a road graph is downloaded, so the engine can pick it up. */
  onRoadGraphChanged: () => void;
  onClose: () => void;
}

type RoadsState =
  | { kind: 'checking' }
  | { kind: 'covered'; by: 'bundled' | 'downloaded'; name: string; ways: number }
  | { kind: 'missing' }
  | { kind: 'downloading' }
  | { kind: 'failed'; message: string };

/**
 * Offline status, and the button that makes the aeroplane-mode demo work.
 *
 * Golden Rule #7: the claim "this works with no network" is worth nothing said
 * out loud and everything with a tile count next to it. This screen states
 * what is stored, what the radio is doing, and whether the worker that does
 * the storing is actually running — including when it is not, and why.
 */
export default function OfflinePanel({
  status,
  bounds,
  mapSourceLabel,
  position,
  onRoadGraphChanged,
  onClose,
}: OfflinePanelProps) {
  const [roads, setRoads] = useState<RoadsState>({ kind: 'checking' });

  /**
   * ★ THE HALF OF "OFFLINE" THAT WAS MISSING ★
   *
   * This screen used to say "the engine never needs a network, this is about
   * the basemap". That was true of the physics and false of the result. Road
   * snapping is what holds the marker on the road while GNSS is gone, it needs
   * a road graph, and the app shipped with graphs for three bounding boxes
   * chosen months in advance. Anywhere else, snapping silently does nothing
   * and the marker wanders into the fields — with no indication that anything
   * is missing.
   *
   * You cannot bundle a graph for a location you do not know yet. So the
   * coverage is CHECKED, reported, and downloadable on the spot.
   */
  const checkRoads = useCallback(async () => {
    if (!position) {
      setRoads({ kind: 'checking' });
      return;
    }
    const entry = await findGraphFor(position.lat, position.lon);
    setRoads(
      entry
        ? { kind: 'covered', by: entry.source, name: entry.name, ways: entry.ways }
        : { kind: 'missing' },
    );
  }, [position]);

  useEffect(() => {
    void checkRoads();
  }, [checkRoads]);
  const plan = useMemo(() => {
    if (!bounds) return null;
    const count = countTilesForBounds(bounds, PRECACHE_MIN_ZOOM, PRECACHE_MAX_ZOOM);
    return { count, bytes: estimateBytes(count), tooBig: count > MAX_PRECACHE_TILES };
  }, [bounds]);

  const roadArea = useMemo(() => (bounds ? areaSqKm(boundsToBBox(bounds)) : null), [bounds]);
  const busy = Boolean(status.progress) || roads.kind === 'downloading';

  const canDownload =
    status.online && bounds !== null && plan !== null && !plan.tooBig && !busy;

  /**
   * One button, both halves. Roads first, deliberately: it is the one that
   * makes navigation correct rather than merely pretty, it is the smaller
   * download, and if the tile fetch is going to be rate-limited it should not
   * take the important half down with it.
   */
  async function handleDownload() {
    if (!bounds) return;

    if (roads.kind !== 'covered') {
      setRoads({ kind: 'downloading' });
      try {
        const bbox = boundsToBBox(bounds);
        const graph = await fetchRoadGraph(bbox);
        const meta = await saveGraph(bbox, graph);
        setRoads({ kind: 'covered', by: 'downloaded', name: meta.name, ways: meta.ways });
        onRoadGraphChanged();
      } catch (err) {
        setRoads({
          kind: 'failed',
          message:
            err instanceof RoadGraphFetchError
              ? err.message
              : 'could not reach OpenStreetMap — check the connection',
        });
      }
    }

    if (status.capability.active && plan && !plan.tooBig) {
      const tiles = tilesForBounds(bounds, PRECACHE_MIN_ZOOM, PRECACHE_MAX_ZOOM);
      await status.download(tiles.map((t) => tileUrl(TILE_TEMPLATE, t)));
    }
  }

  async function handleClear() {
    await deleteStoredGraphs();
    await status.clear();
    await checkRoads();
    onRoadGraphChanged();
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0d1117] p-4 text-neutral-200 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold">Offline status</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              The engine needs no network. The map and the road graph do — once.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/15 px-2 py-1 text-xs text-neutral-300 hover:bg-white/10"
          >
            Close
          </button>
        </div>

        <dl className="tabular mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
          <Row
            label="radio"
            value={status.online ? 'online' : 'OFFLINE'}
            tone={status.online ? 'neutral' : 'good'}
          />
          <Row label="map source" value={mapSourceLabel} />
          <Row
            label="tile cache"
            value={status.capability.active ? 'active' : 'unavailable'}
            tone={status.capability.active ? 'good' : 'warn'}
          />
          <Row label="tiles stored" value={String(status.cachedTiles)} />
          <Row
            label="road graph"
            value={
              roads.kind === 'covered'
                ? `${roads.by} · ${roads.ways} ways`
                : roads.kind === 'downloading'
                  ? 'downloading…'
                  : roads.kind === 'checking'
                    ? 'checking…'
                    : 'NOT COVERED'
            }
            tone={roads.kind === 'covered' ? 'good' : roads.kind === 'missing' ? 'warn' : 'neutral'}
          />
        </dl>

        {roads.kind === 'missing' ? (
          <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
            No road graph covers this area, so the marker will not be held on the road
            during an outage — it will drift into open ground. Download the area while
            there is still a connection.
          </p>
        ) : null}

        {roads.kind === 'failed' ? (
          <p className="mt-2 rounded bg-red-500/10 px-2 py-1.5 text-[11px] leading-snug text-red-300">
            Road graph: {roads.message}
          </p>
        ) : null}

        {!status.capability.active && status.capability.reason ? (
          <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            {status.capability.reason}. The map will need a network; navigation will not.
          </p>
        ) : null}

        {roadArea !== null && roadArea > MAX_AREA_SQ_KM ? (
          <p className="mt-2 text-[11px] text-amber-300">
            This view is {roadArea.toFixed(0)} km², over the {MAX_AREA_SQ_KM} km² road-graph
            limit. Zoom in before downloading.
          </p>
        ) : null}

        {plan ? (
          <p className="mt-3 text-[11px] text-neutral-400">
            This view at z{PRECACHE_MIN_ZOOM}–{PRECACHE_MAX_ZOOM} is{' '}
            <span className="font-mono text-neutral-200">{plan.count}</span> tiles, roughly{' '}
            <span className="font-mono text-neutral-200">{formatBytes(plan.bytes)}</span>.
            {plan.tooBig ? (
              <span className="text-amber-300">
                {' '}
                Too large — zoom in and try again (limit {MAX_PRECACHE_TILES}).
              </span>
            ) : null}
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-neutral-500">Waiting for the map…</p>
        )}

        {status.progress ? (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-neutral-500">
              <span>
                {status.progress.finished ? 'done' : 'downloading'} {status.progress.done}/
                {status.progress.total}
                {status.progress.failed > 0 ? ` · ${status.progress.failed} failed` : ''}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-sky-400 transition-[width] duration-200"
                style={{
                  width: `${
                    status.progress.total > 0
                      ? (status.progress.done / status.progress.total) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!canDownload}
            onClick={handleDownload}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-neutral-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {roads.kind === 'missing' || roads.kind === 'failed'
              ? 'Download roads + map'
              : 'Download this area'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleClear()}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear cache
          </button>
        </div>

        <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-snug text-neutral-500">
          Download the area, then switch the phone to aeroplane mode. The map keeps
          drawing from storage, the road graph keeps the marker on the road, and the
          vehicle keeps navigating from its own sensors — no radio of any kind involved.
          Do this once, wherever you are, before the demo.
        </p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const color =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-neutral-200';
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className={color}>{value}</dd>
    </>
  );
}
