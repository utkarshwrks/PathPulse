#!/usr/bin/env node
/**
 * Measure the brightness of a basemap tile, and check it is still a basemap.
 *
 * This exists because of how CARTO's keyless tier ended. It did not start
 * returning 401, or timing out, or serving a broken image — every request kept
 * answering HTTP 200 with a structurally valid PNG. The provider had simply
 * begun compositing "API KEY REQUIRED" diagonally across the artwork. A status
 * check, a content-type check and a byte-length check all still passed. The
 * only thing that changed was pixels, so pixels are what this reads.
 *
 * Two numbers come out, and they catch different failures:
 *
 *   mean luma  — is it still a DARK basemap, once the layer's own invert is
 *                applied? Must stay under the #3a4250 roads OfflineBasemapLayer
 *                draws on top of it, or those roads vanish into the basemap.
 *   flat       — share of pixels in the single most common luma bucket. A map
 *                is busy; a notice is a flat ground with text on it. Measured:
 *                real OSM 15%, real Esri 35%, OSM's "Access blocked" tile 81%,
 *                Esri's "Map data not yet available" tile 96%.
 *
 * ★ WHAT THIS CANNOT SEE ★
 * It does not catch a watermark composited over real cartography. CARTO's
 * "API KEY REQUIRED" tile measures flat 33% and 13 distinct tones — the same
 * as any legitimate dark basemap, because underneath the text it IS one. No
 * threshold here separates them. That case is caught by asserting the host in
 * apps/web/config/map.test.ts, and otherwise by looking at the map.
 *
 * Usage:
 *   node scripts/measure-tile.mjs                    # current basemap, Delhi
 *   node scripts/measure-tile.mjs --url '<template>' # {z}/{x}/{y} substituted
 *   node scripts/measure-tile.mjs --lat 23.16 --lon 79.93 --zoom 15
 *   node scripts/measure-tile.mjs --ua 'curl/8'   # see the block tile detected
 *
 * Exits non-zero if the tile is missing, is not dark once the layer's invert
 * is applied, or is a notice rather than a map — so it can run unattended
 * before a demo.
 *
 * JPEG needs a decoder this repo does not vendor: on macOS it shells out to
 * sips, elsewhere to ImageMagick. PNG is decoded here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/** Kept in step with apps/web/config/map.ts by the assertions in map.test.ts. */
const DEFAULT_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * OSM's usage policy requires a User-Agent that identifies the app. This is
 * not a formality: with a generic one, tile.openstreetmap.org returns 200 and
 * a PNG reading "Access blocked", and every number below is measured off that
 * notice instead of off a map. Override with --ua to reproduce it on purpose.
 */
const UA = 'PathPulse-tile-check/1.0 (+https://github.com/utkarshwrks/PathPulse)';

/**
 * What apps/web/config/map.ts paints on the raster layer, applied here so the
 * numbers describe what a viewer sees rather than what the server sent. Keep
 * in step with BASEMAP_PAINT; map.test.ts asserts the style side of it.
 */
const PAINT = { brightnessMin: 1, brightnessMax: 0, hueRotate: 180 };
/** Connaught Place — the app's DEFAULT_CENTER, so this is what a demo opens on. */
const DEFAULT = { lat: 28.6315, lon: 77.2167, zoom: 15 };

/** Luma of the offline road overlay, #3a4250. The tile must stay under it. */
const OFFLINE_ROAD_LUMA = 0.299 * 0x3a + 0.587 * 0x42 + 0.114 * 0x50;
/** Above this the rendered basemap is not dark. Inverted OSM measures 38. */
const MAX_RENDERED_MEAN = 90;
/**
 * Above this the tile is a flat ground with a message on it, not a map.
 *
 * Set between the two clusters actually measured — real tiles 15-35%, notice
 * tiles 81-96% — not at a round number that happens to look reasonable.
 */
const MAX_FLAT = 0.6;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Baseline PNG: 8-bit, non-interlaced, which is what tile servers emit. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8;
  let w, h, bitDepth, colorType, interlace, palette = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      [bitDepth, colorType] = [data[8], data[9]];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    i += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  const nch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * nch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let row = 0, p = 0; row < h; row++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= nch ? line[x - nch] : 0;
      const b = prev[x];
      const c = x >= nch ? prev[x - nch] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, row * stride);
    prev = line;
  }
  const luma = new Float64Array(w * h);
  for (let j = 0, k = 0; k < luma.length; j += nch, k++) {
    let r, g, b;
    if (colorType === 3) [r, g, b] = [palette[out[j] * 3], palette[out[j] * 3 + 1], palette[out[j] * 3 + 2]];
    else if (nch >= 3) [r, g, b] = [out[j], out[j + 1], out[j + 2]];
    else r = g = b = out[j];
    luma[k] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return luma;
}

function toPng(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-tile-'));
  const src = join(dir, 'in.img');
  const dst = join(dir, 'out.png');
  writeFileSync(src, buf);
  const tries = [
    ['sips', ['-s', 'format', 'png', src, '--out', dst]],
    ['magick', [src, dst]],
    ['convert', [src, dst]],
  ];
  for (const [cmd, args] of tries) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      if (existsSync(dst)) return readFileSync(dst);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('cannot decode JPEG — install ImageMagick, or run this on macOS for sips');
}

function stats(luma) {
  const sorted = Float64Array.from(luma).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = at(0.5);
  // Uniformity, in 4-luma buckets. This is the one that separates a map from
  // a notice: cartography spreads across many tones, a notice is one flat
  // ground plus glyphs. Deliberately not a variance — a black tile with white
  // text has a large variance and is still not a map.
  const buckets = new Map();
  let flat = 0;
  for (const v of sorted) {
    const k = Math.floor(v / 4);
    const c = (buckets.get(k) ?? 0) + 1;
    buckets.set(k, c);
    if (c > flat) flat = c;
  }
  return { mean, median, p5: at(0.05), p95: at(0.95), flat: flat / sorted.length };
}

const template = arg('url', DEFAULT_TEMPLATE);
const lat = Number(arg('lat', DEFAULT.lat));
const lon = Number(arg('lon', DEFAULT.lon));
const z = Number(arg('zoom', DEFAULT.zoom));
const { x, y } = tileXY(lat, lon, z);
const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

const res = await fetch(url, { headers: { 'User-Agent': arg('ua', UA) } });
const type = res.headers.get('content-type') ?? 'unknown';
const buf = Buffer.from(await res.arrayBuffer());
console.log(`tile   ${url}`);
console.log(`http   ${res.status} · ${type} · ${buf.length} bytes`);
if (!res.ok) {
  console.error('FAIL   tile did not load');
  process.exit(1);
}

const luma = decodePng(type.includes('png') ? buf : toPng(buf));
const raw = stats(luma);
// The layer paint, applied per pixel: MapLibre rescales into [min, max].
const rendered = stats(
  Float64Array.from(luma, (v) => 255 * (PAINT.brightnessMin + (v / 255) * (PAINT.brightnessMax - PAINT.brightnessMin))),
);

const f = (n) => n.toFixed(1).padStart(5);
const row = (name, t) =>
  console.log(`${name} mean ${f(t.mean)} · median ${f(t.median)} · p5 ${f(t.p5)} · p95 ${f(t.p95)}`);
row('raw   ', raw);
row('shown ', rendered);
console.log(`flat   ${(raw.flat * 100).toFixed(1)}% of pixels share one luma bucket (a map is busy, a notice is not)`);
console.log(`       offline road overlay sits at luma ${OFFLINE_ROAD_LUMA.toFixed(1)}`);

const problems = [];
if (rendered.mean > MAX_RENDERED_MEAN)
  problems.push(`rendered mean luma ${rendered.mean.toFixed(1)} — this is not a dark basemap`);
if (rendered.mean > OFFLINE_ROAD_LUMA)
  problems.push(`basemap is brighter than the #3a4250 roads drawn on it — they will vanish`);
if (raw.flat > MAX_FLAT)
  problems.push(`flat ${(raw.flat * 100).toFixed(1)}% — this is a notice, not a map`);
if (problems.length) {
  for (const p of problems) console.error(`FAIL   ${p}`);
  process.exit(1);
}
console.log('ok     a real map, dark once inverted, and darker than the roads drawn on it');
