import type { RoadGraph, RoadWay } from './types.js';

/**
 * A compact binary encoding of a RoadGraph.
 *
 * ★ WHY THIS EXISTS ★
 *
 * The offline promise — "I am somewhere with no signal, I press Live, and it
 * knows where I am" — needs the road graph on the device before the signal goes
 * away. Doing that for a 100 km radius with the JSON the build script writes is
 * tens of megabytes, and the obvious alternative, pre-downloaded map tiles, is
 * ~150 MB of PICTURES OF ROADS for the same coverage.
 *
 * We already have the roads: snapping, map matching and the particle filter all
 * read RoadGraph, so its geometry is in memory whenever navigation works at all.
 * The only problem is that the on-disk form is profligate. Measured on
 * data/maps/road_graph_jabalpur.json — 9,462 ways, 75,482 nodes, 143 km² of
 * dense city:
 *
 *   graph      raw JSON  ->  encoded   ratio     gzipped -> gz    ratio
 *   city         149,757  ->   19,315   7.75x      35,442 -> 14,029  2.53x
 *   highway      210,586  ->   27,443   7.67x      50,129 -> 19,660  2.55x
 *   jabalpur   2,319,824  ->  289,003   8.03x     567,768 -> 208,777 2.72x
 *
 * 8x, against the 4.1x a compact JSON of the same quantised deltas measured —
 * the extra factor is JSON itself, whose commas, brackets and decimal digits
 * cost more than the numbers they delimit once the numbers are small.
 *
 * That is what turns a 100 km radius from tens of MB into single-digit MB, and
 * it is asserted by test rather than hoped for: `graphCodec.test.ts` fails if
 * the ratio drops below 3.5x. A refactor that reintroduced full-precision
 * floats would still round-trip perfectly and would silently make the whole
 * offline feature unaffordable, so the size is part of the contract.
 *
 * ★ WHY IT LIVES IN nav-core AND NOT IN apps/web ★
 *
 * It is pure arithmetic over a nav-core type — no I/O, no browser, nothing to
 * mock. Putting it here means the edge engine and the eval harness can read
 * compact graphs for free, which is the same payoff Golden Rule #1 already pays
 * for ML inference. The alternative, apps/web/lib, would have made it
 * unreachable from `pnpm eval` and from the 200 Hz engine.
 *
 * ★ WHAT IS DELIBERATELY NOT PRESERVED ★
 *
 * `heightM` is dropped. It feeds the HMM's flyover term, which ships OFF and is
 * derived from OSM `layer` anyway, so it is usually absent to begin with.
 * Recoverable by bumping the version if it ever earns its bytes.
 *
 * ★ NAMES USED TO BE DROPPED TOO, ON A CLAIM THAT DOES NOT SURVIVE MEASURING ★
 *
 * Version 1 dropped `name` because "names cost more than the geometry on a
 * dense graph". Measured, dictionary-coded, they do not come close:
 *
 *   graph                    ways    named   unique   names    vs geometry
 *   Jabalpur                9,462      102       42   0.8 KB          0.4 %
 *   IO-VNBD S3C (UK)       15,022    6,381    2,560  48.2 KB          5.3 %
 *
 * Street names repeat: a road is many ways sharing one name, so a deduplicated
 * table plus a one-byte index per named way is about half the cost of storing
 * the strings inline, and a rounding error against the coordinates.
 *
 * They now have a reader. The offline basemap draws labels from them, which is
 * the difference between a diagram of lines and a map you can navigate by when
 * the network is gone — and a prefetched cell that decoded to unnamed roads
 * meant labels appeared only inside the three bounding boxes chosen months ago.
 *
 * ★ THE NAME TABLE IS UTF-8, AND THE CLASS TABLE IS NOT ★
 *
 * `highway` values are an OSM enumeration — ASCII by construction, and worth
 * rejecting anything else as corruption. Street names are not: `Champs-Élysées`
 * and `छोटी लाइन` are ordinary inputs, and the ASCII writer would have thrown on
 * them and failed the whole cell's encode. Anywhere the roads are not named in
 * English is exactly where this is most needed.
 *
 * ★ VERSION 1 STILL DECODES ★
 *
 * Stored cells are v1 and there may be thousands of them on a device that has
 * been prefetching. Refusing them would silently wipe someone's offline
 * coverage — the one thing the whole feature exists to accumulate — so the
 * reader accepts either version and only v2 carries names.
 *
 * Everything the ESTIMATOR reads is preserved exactly: id, highway, oneway,
 * maxspeed. `oneway` in particular is worth 2.2 points of mean drift through
 * rejectOnewayReverse, and losing it silently would look like a tuning
 * regression rather than a codec bug.
 */

/** ASCII 'P','P','G','1'. The magic is the format, not the version. */
const MAGIC = [0x50, 0x50, 0x47, 0x31] as const;
/** What `encodeGraph` writes. */
const VERSION = 2;
/** Oldest version `decodeGraph` accepts. See the note on stored cells above. */
const MIN_VERSION = 1;
/** First version carrying the name table. */
const VERSION_WITH_NAMES = 2;

/**
 * Coordinate quantisation, in degrees.
 *
 * 1e-5 deg is ~1.11 m of latitude. That is well inside GNSS error — a good
 * urban fix disagrees with itself by 2 to 6 m — and far inside roadsnap's 50 m
 * search radius, so quantisation CANNOT change which road is matched. Going
 * finer costs bytes for precision the sensors cannot deliver; going coarser
 * would start to move the geometry the estimator projects onto.
 */
const COORD_SCALE = 1e5;

/** Worst-case round-trip displacement, metres. Rounding is +/- half a step. */
export const COORD_PRECISION_M = 0.79;

/** The bbox is metadata, not geometry, so it keeps more precision for free. */
const BBOX_SCALE = 1e7;

/** Bit layout of the per-way flags byte. */
const F_ONEWAY_MASK = 0b0000_0011; // 0 absent, 1 true, 2 false
const F_HAS_MAXSPEED = 0b0000_0100;
const F_HAS_CLASS = 0b0000_1000;
/** The id is exactly "w" followed by digits — the shape every OSM way has. */
const F_ID_NUMERIC = 0b0001_0000;
/**
 * Draw this way, never match against it.
 *
 * ★ LOSING THIS BIT WOULD BE A SILENT SAFETY FAILURE ★ A round trip that
 * dropped it would turn every stored footpath into an ordinary road the next
 * time the cell was read, and the symptom — a vehicle snapped onto a pavement
 * running beside the road it is on — looks like a matching bug, miles from
 * this file. Hence a flag bit rather than a derived property.
 */
const F_RENDER_ONLY = 0b0010_0000;
/** v2+. The way carries an index into the name table. */
const F_HAS_NAME = 0b0100_0000;

/**
 * Shared, because constructing a TextEncoder per string shows up: a dense graph
 * has thousands of names and the encode runs on the phone while it is driving.
 */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** LEB128, unsigned. Values must be non-negative integers. */
  varint(v: number): void {
    if (!Number.isFinite(v) || v < 0) throw new Error(`varint out of range: ${v}`);
    let x = Math.floor(v);
    this.ensure(10);
    while (x >= 0x80) {
      this.buf[this.len++] = (x & 0x7f) | 0x80;
      // Not >>> 7: values here exceed 32 bits once scaled, and a bit shift
      // would silently truncate them to garbage rather than failing.
      x = Math.floor(x / 128);
    }
    this.buf[this.len++] = x;
  }

  /** Zigzag so small negative deltas cost one byte, like small positive ones. */
  zigzag(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  /** Length-prefixed ASCII. Non-ASCII is rejected rather than mangled. */
  ascii(s: string): void {
    this.varint(s.length);
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 0x7f) throw new Error(`non-ASCII in graph string: ${JSON.stringify(s)}`);
      this.buf[this.len++] = c;
    }
  }

  /**
   * Length-prefixed UTF-8, the length counting BYTES rather than characters.
   *
   * Used for street names, which are routinely not ASCII. The byte length is
   * what the reader needs to advance, and for a name like `छोटी लाइन` it is
   * three times the character count — prefixing the character count would
   * leave the reader mid-way through the next field with no error, which is
   * the class of bug the bounds checks exist to make impossible.
   */
  utf8(s: string): void {
    const bytes = UTF8_ENCODER.encode(s);
    this.varint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  /**
   * ★ EVERY READ IS BOUNDS-CHECKED, AND THE REASON IS SILENCE ★
   * A download cut short mid-way decodes, without this, into a graph that looks
   * structurally fine and is missing geometry — roads that stop existing
   * halfway along, which the estimator then snaps to and the map then draws.
   * Failing loudly on a truncated buffer is the only way that becomes a
   * download to retry rather than a navigation bug to chase.
   */
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `truncated road graph: needed ${n} byte(s) at offset ${this.pos}, have ${this.buf.length}`,
      );
    }
  }

  byte(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      this.need(1);
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new Error('malformed varint in road graph');
  }

  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  ascii(): string {
    const len = this.varint();
    this.need(len);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.buf[this.pos + i]!);
    this.pos += len;
    return s;
  }

  /** Length-prefixed UTF-8; the length is in bytes. See `Writer.utf8`. */
  utf8(): string {
    const len = this.varint();
    this.need(len);
    const s = UTF8_DECODER.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  get exhausted(): boolean {
    return this.pos >= this.buf.length;
  }
}

function checkCoord(lon: number, lat: number): void {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error(`non-finite coordinate: [${lon}, ${lat}]`);
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error(`coordinate out of range: [${lon}, ${lat}]`);
  }
}

/** Encode a graph. Throws on input the estimator could not have used anyway. */
export function encodeGraph(graph: RoadGraph): Uint8Array {
  const w = new Writer();
  for (const b of MAGIC) w.byte(b);
  w.byte(VERSION);

  for (const v of graph.bbox) {
    if (!Number.isFinite(v)) throw new Error('non-finite bbox');
    w.zigzag(Math.round(v * BBOX_SCALE));
  }

  // One table for the whole graph. `highway` takes a handful of distinct values
  // across thousands of ways, so interning turns a repeated 11-byte string into
  // a one-byte index.
  const classIndex = new Map<string, number>();
  for (const way of graph.ways) {
    if (way.highway !== undefined && !classIndex.has(way.highway)) {
      classIndex.set(way.highway, classIndex.size);
    }
  }
  w.varint(classIndex.size);
  for (const cls of classIndex.keys()) w.ascii(cls);

  // ★ ONE ENTRY PER DISTINCT STREET, NOT PER WAY ★
  // OSM splits a road at every junction, speed-limit change and bridge, so a
  // single named street is commonly dozens of ways. Interning turns each of
  // those repeats into one varint — measured at roughly half the cost of
  // writing the strings inline, and the reason names are affordable at all.
  const nameIndex = new Map<string, number>();
  for (const way of graph.ways) {
    if (way.name !== undefined && way.name !== '' && !nameIndex.has(way.name)) {
      nameIndex.set(way.name, nameIndex.size);
    }
  }
  w.varint(nameIndex.size);
  for (const name of nameIndex.keys()) w.utf8(name);

  w.varint(graph.ways.length);
  for (const way of graph.ways) {
    if (!Array.isArray(way.coords) || way.coords.length < 2) {
      throw new Error(
        `way ${way.id} has ${way.coords?.length ?? 0} points; a way needs at least two`,
      );
    }

    const numericId = /^w\d+$/.test(way.id) && Number.isSafeInteger(Number(way.id.slice(1)));
    let flags = 0;
    if (way.oneway === true) flags |= 1;
    else if (way.oneway === false) flags |= 2;
    if (way.maxspeed !== undefined && Number.isFinite(way.maxspeed)) flags |= F_HAS_MAXSPEED;
    if (way.highway !== undefined) flags |= F_HAS_CLASS;
    if (numericId) flags |= F_ID_NUMERIC;
    if (way.renderOnly === true) flags |= F_RENDER_ONLY;
    if (way.name !== undefined && way.name !== '') flags |= F_HAS_NAME;
    w.byte(flags);

    // Every OSM way id is "w" plus digits, and storing "w101274337" as eleven
    // ASCII bytes rather than a four-byte varint would cost more than the
    // geometry of a short way. The general form stays available so a synthetic
    // or renamed id still round-trips.
    if (numericId) w.varint(Number(way.id.slice(1)));
    else w.ascii(way.id);

    if (flags & F_HAS_CLASS) w.varint(classIndex.get(way.highway!)!);
    if (flags & F_HAS_NAME) w.varint(nameIndex.get(way.name!)!);
    if (flags & F_HAS_MAXSPEED) w.varint(Math.round(way.maxspeed!));

    w.varint(way.coords.length);
    let prevLon = 0;
    let prevLat = 0;
    for (let i = 0; i < way.coords.length; i++) {
      const pt = way.coords[i]!;
      const lon = pt[0];
      const lat = pt[1];
      checkCoord(lon, lat);
      const qLon = Math.round(lon * COORD_SCALE);
      const qLat = Math.round(lat * COORD_SCALE);
      // Delta against the previous point, which is what makes this small: a
      // road's consecutive nodes are metres apart, so the deltas are tiny even
      // though the absolute coordinates are not.
      w.zigzag(qLon - prevLon);
      w.zigzag(qLat - prevLat);
      prevLon = qLon;
      prevLat = qLat;
    }
  }

  return w.finish();
}

/** Decode a graph. Throws rather than returning anything partial. */
export function decodeGraph(bytes: Uint8Array): RoadGraph {
  const r = new Reader(bytes);
  for (const expected of MAGIC) {
    if (r.byte() !== expected) throw new Error('not a PathPulse road graph: bad magic bytes');
  }
  const version = r.byte();
  if (version < MIN_VERSION || version > VERSION) {
    throw new Error(
      `unsupported road graph version ${version}, expected ${MIN_VERSION}-${VERSION}`,
    );
  }

  const bbox = [r.zigzag(), r.zigzag(), r.zigzag(), r.zigzag()].map((v) => v / BBOX_SCALE) as [
    number,
    number,
    number,
    number,
  ];

  const classCount = r.varint();
  const classes: string[] = [];
  for (let i = 0; i < classCount; i++) classes.push(r.ascii());

  // Absent in v1, which wrote no table and set no name flags, so an empty list
  // is the correct reading of an old cell rather than a special case.
  const names: string[] = [];
  if (version >= VERSION_WITH_NAMES) {
    const nameCount = r.varint();
    for (let i = 0; i < nameCount; i++) names.push(r.utf8());
  }

  const wayCount = r.varint();
  const ways: RoadWay[] = [];
  for (let i = 0; i < wayCount; i++) {
    const flags = r.byte();
    const id = flags & F_ID_NUMERIC ? `w${r.varint()}` : r.ascii();

    const way: RoadWay = { id, coords: [] };
    if (flags & F_HAS_CLASS) {
      const idx = r.varint();
      const cls = classes[idx];
      if (cls === undefined) throw new Error(`road graph references unknown class index ${idx}`);
      way.highway = cls;
    }
    if (flags & F_HAS_NAME) {
      const idx = r.varint();
      const name = names[idx];
      if (name === undefined) throw new Error(`road graph references unknown name index ${idx}`);
      way.name = name;
    }
    if (flags & F_HAS_MAXSPEED) way.maxspeed = r.varint();
    if (flags & F_RENDER_ONLY) way.renderOnly = true;
    const oneway = flags & F_ONEWAY_MASK;
    // Absent and false are different claims — "not tagged" versus "tagged
    // two-way" — and rejectOnewayReverse only acts on the positive case.
    if (oneway === 1) way.oneway = true;
    else if (oneway === 2) way.oneway = false;

    const nodeCount = r.varint();
    if (nodeCount < 2) throw new Error(`way ${id} decoded with ${nodeCount} points`);
    const coords: Array<[number, number]> = [];
    let lon = 0;
    let lat = 0;
    for (let j = 0; j < nodeCount; j++) {
      lon += r.zigzag();
      lat += r.zigzag();
      coords.push([lon / COORD_SCALE, lat / COORD_SCALE]);
    }
    way.coords = coords;
    ways.push(way);
  }

  if (!r.exhausted) {
    // Trailing bytes mean the writer and reader disagree about the format, and
    // a graph decoded by two different understandings of the same bytes is not
    // something to carry on with.
    throw new Error('road graph has trailing bytes: format mismatch');
  }

  return { bbox, ways };
}
