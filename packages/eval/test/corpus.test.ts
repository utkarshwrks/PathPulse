import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../src/harness.js';
import { listLogs, readLog } from '../src/paths.js';

/**
 * The evaluation corpus must contain continuous-GNSS recordings only.
 *
 * ★ THE REGRESSION THIS PREVENTS ★
 * `listLogs()` enumerates every .jsonl in data/replay/ and the ablation punches
 * its own outage window into each one. A log that already has a hole in it
 * gets a second hole punched on top, and the scores are meaningless — but they
 * are still *numbers*, printed in the same table, in the same place, with no
 * warning.
 *
 * This happened: the Phase 10 backup log, which has a 60 s outage baked in,
 * was written into data/replay/. The headline moved from 10.0% mean / 22.6%
 * p90 to 19.0% / 53.7% and nothing failed. It was caught by the final audit
 * comparing the generated table against the figure in PROJECT_STATUS.md — one
 * step later and it would have been on a slide.
 */

const logs = listLogs();

describe('the evaluation corpus', () => {
  it('has logs in it at all', () => {
    expect(logs.length).toBeGreaterThan(0);
  });

  for (const name of logs) {
    it(`★ ${name} has no pre-existing GNSS outage`, () => {
      const samples = parseJsonl(readLog(name));
      const fixes = samples.filter((s) => s.gnss);
      expect(fixes.length).toBeGreaterThan(10);

      // The harness withholds GNSS itself. A gap already present in the file
      // means the outage is being applied twice and the score is nonsense.
      let worstGapMs = 0;
      for (let i = 1; i < fixes.length; i++) {
        worstGapMs = Math.max(worstGapMs, fixes[i]!.t - fixes[i - 1]!.t);
      }
      // These are 1 Hz recordings; anything past a few seconds is a hole.
      expect(worstGapMs, `${name} has a ${(worstGapMs / 1000).toFixed(0)}s GNSS gap`).toBeLessThan(
        5000,
      );
    });
  }

  it('★ does not contain the demo backup log', () => {
    // It belongs in apps/web/public/replay/, where the app fetches it. Named
    // explicitly because that is the file that actually did this.
    expect(logs).not.toContain('demo.jsonl');
  });
});
