import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoadGraph } from '@pathpulse/nav-core';

/** Repository root, from this file's location. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Minimal `--flag value` parsing. No dependency for four lines of work. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

export interface EvalConfig {
  name: string;
  description?: string;
  engine: Record<string, unknown>;
}

export function loadConfig(nameOrPath: string): EvalConfig {
  const candidates = [
    nameOrPath,
    join(ROOT, 'configs', nameOrPath),
    join(ROOT, 'configs', `${nameOrPath}.json`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as EvalConfig;
  }
  throw new Error(`no config named "${nameOrPath}" — looked in configs/`);
}

/** Every config in configs/, in a deliberate order for the ablation table. */
export const ABLATION_ORDER = [
  'naive',
  'filtered',
  'zaru',
  'zupt',
  'nhc',
  'speedclamp',
  'highpass',
  'full',
  'full_forwardbias',
  'eskf',
];

export function listLogs(): string[] {
  const dir = join(ROOT, 'data', 'replay');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
}

export function readLog(name: string): string {
  const candidates = [name, join(ROOT, 'data', 'replay', name)];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  throw new Error(`no log named "${name}" — looked in data/replay/`);
}

/**
 * The road graph covering a position, or null.
 *
 * Road snapping only engages where a graph exists, so a run outside the
 * covered area silently loses that constraint. The caller reports which graph
 * was used rather than leaving it implicit.
 */
export function loadGraphFor(lat: number, lon: number): { name: string; graph: RoadGraph } | null {
  const manifestPath = join(ROOT, 'data', 'maps', 'index.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    graphs: Array<{ name: string; file: string; bbox: [number, number, number, number] }>;
  };
  const inside = manifest.graphs.filter(
    (g) => lon >= g.bbox[0] && lon <= g.bbox[2] && lat >= g.bbox[1] && lat <= g.bbox[3],
  );
  if (inside.length === 0) return null;
  // Smallest bbox wins: a tight local extract beats a wide regional one.
  const best = inside.reduce((a, b) =>
    (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) <
    (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])
      ? a
      : b,
  );
  const graph = JSON.parse(
    readFileSync(join(ROOT, 'data', 'maps', best.file), 'utf8'),
  ) as RoadGraph;
  return { name: best.name, graph };
}
