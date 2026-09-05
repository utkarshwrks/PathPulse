#!/usr/bin/env node
/**
 * Build a road graph from OpenStreetMap for a bounding box.
 *
 *   node scripts/build-road-graph.mjs --route city
 *   node scripts/build-road-graph.mjs --route highway
 *   node scripts/build-road-graph.mjs --centre 23.1815,79.9864 --radius 3000 --name jabalpur
 *   node scripts/build-road-graph.mjs --bbox 79.90,23.13,80.02,23.23 --name jabalpur
 *
 * Output: data/maps/road_graph_<name>.json, and a copy in
 * apps/web/public/maps/ so the app can fetch it at runtime.
 *
 * ★ RUN ONCE, COMMIT THE RESULT ★
 * Overpass is rate-limited and occasionally down, and a demo that needs a live
 * API call to draw its roads is a demo that fails in a room with bad wifi. The
 * generated JSON is committed so the app, the tests and the eval harness never
 * touch the network.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Road classes worth matching against.
 *
 * Deliberately excludes footway, path, cycleway, steps and construction: a
 * vehicle cannot be on them, and offering them as candidates would let the
 * matcher snap a car onto the pavement running alongside its actual road.
 * `service` is kept because car parks and access roads are exactly where GNSS
 * tends to fail.
 */
const HIGHWAY_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

/** Bounding box of a route file, padded so nearby roads are included. */
function bboxFromRoute(routeKey, padM) {
  const path = join(ROOT, 'data', 'routes', `route_${routeKey}.json`);
  if (!existsSync(path)) throw new Error(`no such route: ${path}`);
  const route = JSON.parse(readFileSync(path, 'utf8'));
  const coords = route.geometry.coordinates;
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = padM / 111_320;
  const dLon = padM / (111_320 * Math.cos((midLat * Math.PI) / 180));
  return [
    Math.min(...lons) - dLon,
    Math.min(...lats) - dLat,
    Math.max(...lons) + dLon,
    Math.max(...lats) + dLat,
  ];
}

function bboxFromCentre(centre, radiusM) {
  const [lat, lon] = centre.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('--centre must be "lat,lon"');
  }
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

function buildQuery([minLon, minLat, maxLon, maxLat]) {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const filter = HIGHWAY_CLASSES.join('|');
  // `out geom` returns each way's coordinates inline, so there is no second
  // pass to resolve node ids — far less data and far less code.
  return `[out:json][timeout:120];way["highway"~"^(${filter})$"](${bbox});out geom;`;
}

async function fetchOverpass(query) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      process.stdout.write(`  querying ${new URL(endpoint).host}… `);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass answers 406 to requests without an identifiable
          // User-Agent. Its usage policy asks for a contactable one so an
          // abusive client can be reached rather than silently blocked.
          'User-Agent': 'PathPulse/0.1 (SIH26168 road-graph builder; dev@blaziken.in)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`ok (${json.elements?.length ?? 0} ways)`);
      return json;
    } catch (err) {
      console.log(`failed: ${err.message}`);
      lastError = err;
    }
  }
  throw new Error(
    `every Overpass endpoint failed (${lastError?.message}). It rate-limits ` +
      `aggressively — wait a minute and retry, or use a Geofabrik extract.`,
  );
}

/** OSM maxspeed tags are free text: "50", "50 mph", "RU:urban", "none". */
function parseMaxspeed(tag) {
  if (!tag) return undefined;
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/i.exec(tag);
  if (mph) return Math.round(Number(mph[1]) * 1.609344);
  const kph = /^(\d+(?:\.\d+)?)(\s*km\/?h)?$/i.exec(tag.trim());
  if (kph) return Math.round(Number(kph[1]));
  return undefined;
}

function toGraph(osm, bbox, meta) {
  const ways = [];
  for (const el of osm.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const way = {
      id: `w${el.id}`,
      coords: el.geometry.map((g) => [
        Number(g.lon.toFixed(7)),
        Number(g.lat.toFixed(7)),
      ]),
    };
    if (tags.name) way.name = tags.name;
    if (tags.highway) way.highway = tags.highway;
    const ms = parseMaxspeed(tags.maxspeed);
    if (ms !== undefined) way.maxspeed = ms;
    // "-1" means one-way against the drawn direction; treating it as one-way
    // in the drawn direction would be worse than treating it as two-way.
    if (tags.oneway === 'yes' || tags.oneway === 'true' || tags.oneway === '1') {
      way.oneway = true;
    }
    // ★ OSM's `layer` IS AN ORDERING, NOT A HEIGHT ★ It says which way is on
    // top where two cross, and nothing about how far. Five metres a level is
    // the usual clearance for a road bridge and is a modelled estimate, which
    // is why the field is named layerM and not altitudeM. Phase 14's HMM uses
    // it only to separate a flyover from the road beneath it, where being
    // roughly right is enough and being absent is fatal.
    const layer = Number(tags.layer);
    if (Number.isFinite(layer) && layer !== 0) way.layerM = layer * 5;
    ways.push(way);
  }
  return { bbox: bbox.map((v) => Number(v.toFixed(7))), ways, meta };
}

async function main() {
  const args = parseArgs(process.argv);
  let bbox;
  let name;

  if (args.route) {
    bbox = bboxFromRoute(args.route, Number(args.pad ?? 400));
    name = String(args.route);
  } else if (args.centre || args.center) {
    bbox = bboxFromCentre(String(args.centre ?? args.center), Number(args.radius ?? 3000));
    name = String(args.name ?? 'area');
  } else if (args.bbox) {
    bbox = String(args.bbox).split(',').map(Number);
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
      throw new Error('--bbox must be "minLon,minLat,maxLon,maxLat"');
    }
    name = String(args.name ?? 'area');
  } else {
    console.error(
      'usage:\n' +
        '  --route <city|highway> [--pad 400]\n' +
        '  --centre <lat,lon> --radius <m> --name <name>\n' +
        '  --bbox <minLon,minLat,maxLon,maxLat> --name <name>\n' +
        '  --eval-only   write only data/maps, keep it out of the APK',
    );
    process.exit(1);
  }

  const widthKm = ((bbox[2] - bbox[0]) * 111.32 * Math.cos((bbox[1] * Math.PI) / 180)).toFixed(1);
  const heightKm = ((bbox[3] - bbox[1]) * 111.32).toFixed(1);
  console.log(`\nroad graph "${name}"`);
  console.log(`  bbox ${bbox.map((v) => v.toFixed(5)).join(', ')}  (~${widthKm} x ${heightKm} km)`);

  const query = buildQuery(bbox);
  const osm = await fetchOverpass(query);
  const graph = toGraph(osm, bbox, {
    source: 'OpenStreetMap via Overpass',
    licence: 'ODbL 1.0',
    generatedAt: new Date().toISOString(),
    highwayClasses: HIGHWAY_CLASSES.join(','),
  });

  const points = graph.ways.reduce((n, w) => n + w.coords.length, 0);
  const named = graph.ways.filter((w) => w.name).length;
  const withSpeed = graph.ways.filter((w) => w.maxspeed !== undefined).length;

  /*
   * ★ NOT EVERY GRAPH BELONGS IN THE APK ★
   *
   * Writing to both places is right for the areas the app demonstrates: the
   * eval harness reads data/maps and the handset reads the bundled copy, and
   * they must be the same file.
   *
   * It is wrong for a graph that exists only as an evaluation fixture. The two
   * IO-VNBD routes are in the English Midlands, and shipping them added 4.4 MB
   * to an APK whose users will never be within a thousand kilometres of them —
   * 7.41 MB to 8.65 MB in one build, caught only because the size is a tracked
   * baseline. `--eval-only` keeps such a graph out of the app entirely.
   */
  const evalOnly = args['eval-only'] === true || args['eval-only'] === 'true';
  const outDirs = evalOnly
    ? [join(ROOT, 'data', 'maps')]
    : [join(ROOT, 'data', 'maps'), join(ROOT, 'apps', 'web', 'public', 'maps')];
  const json = JSON.stringify(graph);
  for (const dir of outDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `road_graph_${name}.json`), json);
    // A manifest of bboxes, so the app can pick the graph covering wherever it
    // happens to be without downloading every graph to find out.
    const manifestPath = join(dir, 'index.json');
    let manifest = { graphs: [] };
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        // A corrupt manifest is rebuilt rather than allowed to break the build.
      }
    }
    manifest.graphs = (manifest.graphs ?? []).filter((g) => g.name !== name);
    manifest.graphs.push({
      name,
      file: `road_graph_${name}.json`,
      bbox: graph.bbox,
      ways: graph.ways.length,
      sizeKb: Math.round(json.length / 1024),
    });
    manifest.graphs.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(`  ways ${graph.ways.length}  points ${points}  named ${named}  maxspeed ${withSpeed}`);
  console.log(`  size ${(json.length / 1024).toFixed(0)} KB`);
  console.log(`  wrote data/maps/road_graph_${name}.json`);
  if (evalOnly) console.log(`  eval only — NOT bundled into the app\n`);
  else console.log(`  wrote apps/web/public/maps/road_graph_${name}.json\n`);

  if (json.length > 8 * 1024 * 1024) {
    console.warn('  ⚠ over 8 MB — this ships inside the APK. Narrow the bbox.\n');
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
