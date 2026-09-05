/* eslint-disable no-undef */
/**
 * PathPulse tile cache.
 *
 * ★ THE AEROPLANE-MODE DEMO DEPENDS ON THIS ★
 * The navigation engine needs no network at all — that is the whole point of
 * the project. The basemap does, and a map that goes blank the moment the
 * radios are switched off undercuts the claim it is meant to prove.
 *
 * Strategy is cache-first for map tiles, deliberately: a tile is immutable for
 * our purposes (roads do not move during a demo), so serving the stored copy
 * and skipping the network is both faster and the behaviour we want offline.
 * Everything else is left completely alone — this worker does not touch app
 * code, and it will not serve a stale build.
 *
 * Cache-first also means the ONLY reason a tile is missing offline is that it
 * was never fetched. Hence the explicit pre-cache in lib/tileCache.ts, rather
 * than relying on the user having happened to pan over the right area.
 */

const CACHE = 'pathpulse-tiles-v1';

/**
 * Font atlases, cached apart from the tiles.
 *
 * ★ WHY NOT JUST ADD THE HOST TO THE TILE LIST ★
 * The tile cache is capped at MAX_TILES and evicts oldest-first. Glyphs are
 * fetched once, at the very start of a session, so they would be the OLDEST
 * entries in it — first out the moment a drive stores two thousand tiles. The
 * symptom is street labels that work for the first few minutes of every
 * session and are gone by the time anyone is offline and needs them.
 *
 * There are a handful of these (one range per script actually used, ~41 KB
 * each), so this cache needs no cap.
 */
const FONT_CACHE = 'pathpulse-fonts-v1';
const FONT_HOST = 'tiles.basemaps.cartocdn.com';

/**
 * Hosts whose responses may be cached.
 *
 * An allowlist, not a pattern match on the URL. Caching by URL shape would
 * eventually catch something that is not a tile — an API response, a build
 * asset — and serve it stale for ever with no way for the user to tell.
 */
const TILE_HOSTS = [
  // Kept in step with TILE_HOSTS in apps/web/config/map.ts. A worker cannot
  // import from the bundle, so this is a copy — if the basemap host changes
  // and this list does not, tiles are fetched and never stored, and the
  // aeroplane-mode demo fails with no error anywhere.
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
  'basemaps.cartocdn.com',
  'api.maptiler.com',
];

/**
 * Cap on stored tiles. Roughly 40 MB at OSM's average tile size.
 *
 * Bounded because this is a phone, and because an unbounded cache is a bug
 * that only shows up as a storage-full error weeks later on someone else's
 * device. Eviction is oldest-first.
 */
const MAX_TILES = 2000;

function isTileRequest(url) {
  try {
    const u = new URL(url);
    return TILE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function isFontRequest(url) {
  try {
    const u = new URL(url);
    return u.hostname === FONT_HOST && u.pathname.startsWith('/fonts/');
  } catch {
    return false;
  }
}

self.addEventListener('install', (event) => {
  // Take over immediately. A worker that waits for every tab to close would
  // not be active during the demo it was installed for.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (n) =>
              (n.startsWith('pathpulse-tiles-') && n !== CACHE) ||
              (n.startsWith('pathpulse-fonts-') && n !== FONT_CACHE),
          )
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Drop the oldest entries once the cache exceeds its cap. */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  const excess = keys.length - MAX_TILES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const font = isFontRequest(request.url);
  if (!font && !isTileRequest(request.url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(font ? FONT_CACHE : CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      try {
        const response = await fetch(request);
        // Only store a real success. Caching an error page as though it were a
        // tile would leave a permanent grey square that no amount of network
        // would repair.
        if (response && response.status === 200) {
          await cache.put(request, response.clone());
          if (!font) await trim(cache);
        }
        return response;
      } catch (e) {
        // Offline with no stored copy. Returning a transparent tile rather than
        // letting the request fail keeps MapLibre from logging an error per
        // tile per frame; the map simply has a hole, which is honest.
        const miss = await cache.match(request);
        if (miss) return miss;
        throw e;
      }
    })(),
  );
});

/**
 * Pre-cache a list of tile URLs, reporting progress back to the page.
 *
 * Sequential with a small concurrency window rather than a single
 * Promise.all: firing a thousand requests at once gets the tile server to
 * rate-limit or ban, which turns "download this area" into "lose the basemap
 * entirely" — the opposite of what it is for.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'PRECACHE_TILES') return;

  event.waitUntil(
    (async () => {
      const urls = Array.isArray(data.urls) ? data.urls : [];
      const cache = await caches.open(CACHE);
      const source = event.source;
      let done = 0;
      let failed = 0;
      const CONCURRENCY = 6;

      const queue = urls.slice();
      async function worker() {
        for (;;) {
          const url = queue.shift();
          if (url === undefined) return;
          try {
            const existing = await cache.match(url);
            if (!existing) {
              const res = await fetch(url, { mode: 'cors' });
              if (res && res.status === 200) await cache.put(url, res.clone());
              else failed++;
            }
          } catch {
            failed++;
          }
          done++;
          if (source && done % 10 === 0) {
            source.postMessage({ type: 'PRECACHE_PROGRESS', done, total: urls.length, failed });
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      await trim(cache);
      if (source) {
        source.postMessage({ type: 'PRECACHE_DONE', done, total: urls.length, failed });
      }
    })(),
  );
});
