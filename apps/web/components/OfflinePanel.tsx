'use client';

import { useMemo } from 'react';
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

/** Zoom range stored for an area: wide enough to pan, sharp enough to drive. */
export const PRECACHE_MIN_ZOOM = 12;
export const PRECACHE_MAX_ZOOM = 16;

const TILE_TEMPLATE = 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png';

interface OfflinePanelProps {
  status: OfflineStatus;
  /** Current map viewport, or null before the map is ready. */
  bounds: LatLonBounds | null;
  mapSourceLabel: string;
  onClose: () => void;
}

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
  onClose,
}: OfflinePanelProps) {
  const plan = useMemo(() => {
    if (!bounds) return null;
    const count = countTilesForBounds(bounds, PRECACHE_MIN_ZOOM, PRECACHE_MAX_ZOOM);
    return { count, bytes: estimateBytes(count), tooBig: count > MAX_PRECACHE_TILES };
  }, [bounds]);

  const canDownload =
    status.capability.active && status.online && plan !== null && !plan.tooBig && !status.progress;

  async function handleDownload() {
    if (!bounds || !plan || plan.tooBig) return;
    const tiles = tilesForBounds(bounds, PRECACHE_MIN_ZOOM, PRECACHE_MAX_ZOOM);
    await status.download(tiles.map((t) => tileUrl(TILE_TEMPLATE, t)));
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0d1117] p-4 text-neutral-200 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold">Offline status</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              The engine never needs a network. This is about the basemap.
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
        </dl>

        {!status.capability.active && status.capability.reason ? (
          <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            {status.capability.reason}. The map will need a network; navigation will not.
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
            Download this area
          </button>
          <button
            type="button"
            disabled={status.cachedTiles === 0 || Boolean(status.progress)}
            onClick={() => void status.clear()}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear cache
          </button>
        </div>

        <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-snug text-neutral-500">
          Download the area, then switch the phone to aeroplane mode. The map keeps
          drawing from storage and the vehicle keeps navigating from its own sensors —
          no radio of any kind involved.
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
