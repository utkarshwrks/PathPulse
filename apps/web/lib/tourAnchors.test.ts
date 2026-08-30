import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './tour';

/**
 * Every tour step must point at something that exists.
 *
 * ★ THE FAILURE THIS PREVENTS ★
 * A step whose anchor has been renamed or removed does not throw. The overlay
 * falls back to a centred card and the tour carries on describing a button
 * that is no longer there — visible only to whoever is holding the phone, and
 * only while a stranger is watching. Cheap to assert, impossible to notice.
 */

const WEB = resolve(process.cwd());

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(WEB, dir))
    .filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('.test.'))
    .map((f) => resolve(WEB, dir, f));
}

const sources = [...sourceFiles('components'), ...sourceFiles('app')]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('tour anchors', () => {
  const anchors = [...new Set(TOUR_STEPS.map((s) => s.anchor).filter(Boolean))] as string[];

  it('there are anchors to check', () => {
    expect(anchors.length).toBeGreaterThan(3);
  });

  for (const anchor of [...new Set(TOUR_STEPS.map((s) => s.anchor))]) {
    if (!anchor) continue;
    it(`★ something in the UI carries data-tour="${anchor}"`, () => {
      expect(sources).toContain(`data-tour="${anchor}"`);
    });
  }

  it('every step either anchors to a real element or is deliberately centred', () => {
    for (const step of TOUR_STEPS) {
      if (step.anchor === null) continue;
      expect(sources, step.id).toContain(`data-tour="${step.anchor}"`);
    }
  });
});
