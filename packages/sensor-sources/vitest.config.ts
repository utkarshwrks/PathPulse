import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SimulationSource physics is pure TypeScript — no DOM needed.
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    /*
     * ★ THESE SUITES MAY NOT RUN CONCURRENTLY ★
     *
     * foregroundSource.test.ts and nativesource.test.ts both mock the SAME
     * specifier, '@capacitor/core', with DIFFERENT factories — the first needs
     * isPluginAvailable, Plugins and registerPlugin; the second deliberately
     * provides only isNativePlatform. Both sources reach Capacitor through a
     * dynamic `await import()` resolved when start() runs, not when the file
     * loads, so which factory answers is decided by scheduling once the two
     * files are in flight together.
     *
     * Measured, running only those two files:
     *   parallel (default) ......... ~1 run in 3 fails
     *   --no-file-parallelism ...... 0 failures in 10 runs
     *
     * The symptom was ForegroundSource.start() throwing "plugin is not in this
     * build" — a suite failing on a mock belonging to a different suite, which
     * is why it looked like a C/N0 parsing bug for so long. `vi.resetModules()`
     * in beforeEach was tried and measured no improvement; it is not in the
     * tree, because a no-op carrying an explanatory comment is worse than
     * nothing.
     *
     * The better fix is one shared Capacitor factory for the whole package,
     * with per-suite state. That is a refactor of two test files and is worth
     * doing; until then this costs a fraction of a second on 107 tests and
     * makes the suite deterministic, which is the property the rest of this
     * project's credibility rests on.
     */
    fileParallelism: false,
  },
});
