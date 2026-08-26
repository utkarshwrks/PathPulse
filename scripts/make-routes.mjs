#!/usr/bin/env node
/**
 * Generates the simulation routes in data/routes/.
 *
 * Written as a generator rather than hand-typed coordinates so the leg
 * lengths, turn count and total distance are exact and reproducible — the
 * ablation table (Phase 7) quotes drift as a percentage of distance, so the
 * distance needs to be a known quantity, not an approximation.
 *
 * Usage: node scripts/make-routes.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const R = 6378137;
const ROOT = new URL('..', import.meta.url).pathname;
const START = { lat: 28.6315, lon: 77.2167 }; // Connaught Place, Delhi

/** Walk `distM` from a point along a compass bearing, on a sphere. */
function project(lat, lon, bearingDeg, distM) {
  const br = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(br)) / R;
  const dLon = (distM * Math.sin(br)) / (R * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + (dLat * 180) / Math.PI, lon: lon + (dLon * 180) / Math.PI };
}

/** Emit vertices every `stepM` so the route has drivable resolution. */
function leg(from, bearingDeg, lengthM, stepM = 25) {
  const pts = [];
  for (let d = stepM; d <= lengthM + 1e-6; d += stepM) {
    pts.push(project(from.lat, from.lon, bearingDeg, Math.min(d, lengthM)));
  }
  return pts;
}

function build(legs) {
  let cur = { ...START };
  const coords = [[+START.lon.toFixed(7), +START.lat.toFixed(7)]];
  for (const { bearing, length } of legs) {
    for (const p of leg(cur, bearing, length)) {
      coords.push([+p.lon.toFixed(7), +p.lat.toFixed(7)]);
    }
    cur = project(cur.lat, cur.lon, bearing, length);
  }
  return coords;
}

function feature(name, description, coordinates, stopsAtFraction) {
  return {
    type: 'Feature',
    properties: { name, description, stopsAtFraction },
    geometry: { type: 'LineString', coordinates },
  };
}

// --- City: 2 km, four 90-degree turns, three stops -------------------------
const cityLegs = [
  { bearing: 90, length: 400 },  // east
  { bearing: 180, length: 350 }, // turn right -> south
  { bearing: 270, length: 500 }, // turn right -> west
  { bearing: 180, length: 400 }, // turn left  -> south
  { bearing: 90, length: 350 },  // turn left  -> east
];
const city = feature(
  'City loop',
  '2 km urban route: four 90-degree turns and three signalised stops.',
  build(cityLegs),
  [0.25, 0.55, 0.8],
);

// --- Highway: 3 km, straight - long curve - straight -----------------------
const highwayLegs = [{ bearing: 45, length: 1000 }];
// Sweep 45 -> 105 degrees over 1 km in 4-degree increments: a long, gentle bend.
for (let i = 1; i <= 15; i++) {
  highwayLegs.push({ bearing: 45 + i * 4, length: 1000 / 15 });
}
highwayLegs.push({ bearing: 105, length: 1000 });
const highway = feature(
  'Highway curve',
  '3 km highway route: straight, one long sweeping curve, straight. No stops.',
  build(highwayLegs),
  [],
);

for (const [file, data] of [
  ['route_city.json', city],
  ['route_highway.json', highway],
]) {
  const path = join(ROOT, 'data/routes', file);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`${file}: ${data.geometry.coordinates.length} vertices`);
}
