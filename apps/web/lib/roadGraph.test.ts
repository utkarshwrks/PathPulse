import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MANIFEST = {
  graphs: [
    // Deliberately overlapping: a wide regional extract and a tight local one.
    { name: 'wide', file: 'road_graph_wide.json', bbox: [77.0, 28.4, 77.4, 28.8], ways: 9000, sizeKb: 2000 },
    { name: 'city', file: 'road_graph_city.json', bbox: [77.21, 28.62, 77.23, 28.64], ways: 725, sizeKb: 146 },
    { name: 'far', file: 'road_graph_far.json', bbox: [79.9, 23.1, 80.1, 23.3], ways: 500, sizeKb: 90 },
  ],
};

const GRAPH = { bbox: [77.21, 28.62, 77.23, 28.64], ways: [{ id: 'w1', coords: [[77.22, 28.63]] }] };

/**
 * The module caches the manifest and every fetched graph at module scope, which
 * is correct at runtime — a graph is hundreds of kilobytes and the position
 * barely moves — but means each test needs a fresh copy of the module.
 */
async function freshModule() {
  vi.resetModules();
  return import('./roadGraph');
}

function mockFetch(handler: (url: string) => { ok: boolean; json?: unknown } | Promise<never>) {
  return vi.fn(async (url: string) => {
    const r = handler(url);
    if (r instanceof Promise) return r;
    return { ok: r.ok, json: async () => r.json } as Response;
  });
}

describe('roadGraph — choosing a graph for where we actually are', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.endsWith('index.json') ? { ok: true, json: MANIFEST } : { ok: true, json: GRAPH },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists what the build produced', async () => {
    const { listRoadGraphs } = await freshModule();
    expect((await listRoadGraphs()).map((g) => g.name)).toEqual(['wide', 'city', 'far']);
  });

  it('finds the graph covering a position', async () => {
    const { findGraphFor } = await freshModule();
    expect((await findGraphFor(23.18, 79.99))!.name).toBe('far');
  });

  it('prefers the tightest bbox when several overlap', async () => {
    // ★ A local extract is a better match than a regional one that merely
    // happens to contain the point — it is denser and far smaller to load.
    const { findGraphFor } = await freshModule();
    expect((await findGraphFor(28.63, 77.22))!.name).toBe('city');
  });

  it('returns null where no graph covers — the case that must be visible', async () => {
    // Testing outside the demo area has to read as "no graph here" rather than
    // as road snapping being silently broken.
    const { findGraphFor } = await freshModule();
    expect(await findGraphFor(51.5, -0.12)).toBeNull();
  });

  it('loads and caches a graph, fetching it only once', async () => {
    const { listRoadGraphs, loadRoadGraph } = await freshModule();
    const entry = (await listRoadGraphs()).find((g) => g.name === 'city')!;
    const a = await loadRoadGraph(entry);
    const b = await loadRoadGraph(entry);
    expect(a).toBe(b);
    const graphFetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('road_graph_city'),
    );
    expect(graphFetches).toHaveLength(1);
  });

  it('fetches the manifest only once across many lookups', async () => {
    const { findGraphFor } = await freshModule();
    await findGraphFor(28.63, 77.22);
    await findGraphFor(23.18, 79.99);
    await findGraphFor(51.5, -0.12);
    const manifestFetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('index.json'),
    );
    expect(manifestFetches).toHaveLength(1);
  });

  it('finds and loads in one step', async () => {
    const { loadRoadGraphFor } = await freshModule();
    const found = await loadRoadGraphFor(28.63, 77.22);
    expect(found!.entry.name).toBe('city');
    expect(found!.graph.ways).toHaveLength(1);
  });

  it('treats bbox edges as inside', async () => {
    const { findGraphFor } = await freshModule();
    expect(await findGraphFor(28.62, 77.21)).not.toBeNull();
    expect(await findGraphFor(28.64, 77.23)).not.toBeNull();
  });
});

describe('roadGraph — failures must degrade, never throw', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('survives a missing manifest', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ ok: false })));
    const { listRoadGraphs, findGraphFor } = await freshModule();
    expect(await listRoadGraphs()).toEqual([]);
    expect(await findGraphFor(28.63, 77.22)).toBeNull();
  });

  it('survives being offline entirely', async () => {
    // Road snapping simply does not engage. It must never take the app down
    // with it — the whole point of the project is working without a network.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { listRoadGraphs, loadRoadGraphFor } = await freshModule();
    expect(await listRoadGraphs()).toEqual([]);
    expect(await loadRoadGraphFor(28.63, 77.22)).toBeNull();
  });

  it('survives a manifest that lists a graph whose file is missing', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.endsWith('index.json') ? { ok: true, json: MANIFEST } : { ok: false },
      ),
    );
    const { loadRoadGraphFor } = await freshModule();
    expect(await loadRoadGraphFor(28.63, 77.22)).toBeNull();
  });

  it('survives a corrupt graph file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('index.json')) {
          return { ok: true, json: async () => MANIFEST } as Response;
        }
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError('unexpected token');
          },
        } as unknown as Response;
      }),
    );
    const { loadRoadGraphFor } = await freshModule();
    expect(await loadRoadGraphFor(28.63, 77.22)).toBeNull();
  });
});
