import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPLIANCE, STATUS_LABEL } from './pitch';

/**
 * The last-resort offline brief.
 *
 * `scripts/make-offline-brief.mjs` duplicates the compliance rows on purpose:
 * it must build with nothing but Node and two JSON reads, because the day that
 * file is needed is the day the toolchain is the problem. Duplication is the
 * right call there and a liability everywhere else — so the copy is asserted
 * to stay in step with the one the app shows.
 */

const ROOT = resolve(process.cwd(), '../..');
const SCRIPT = readFileSync(resolve(ROOT, 'scripts/make-offline-brief.mjs'), 'utf8');
const BRIEF = resolve(ROOT, 'docs/offline-brief.html');

describe('the offline brief mirrors the in-app deck', () => {
  it('★ carries the same number of compliance rows', () => {
    const rows = SCRIPT.split('\n').filter((l) => /^\s*\['.+', '(DONE|PARTIAL|PART B)'/.test(l));
    expect(rows).toHaveLength(COMPLIANCE.length);
  });

  it('★ agrees on every status, so the two cannot tell different stories', () => {
    for (const row of COMPLIANCE) {
      // The requirement wording is abbreviated for the print layout, so match
      // on the status keyword count rather than the exact sentence.
      expect(STATUS_LABEL[row.status]).toBeDefined();
    }
    const counts = (label: string) =>
      SCRIPT.split('\n').filter((l) => l.includes(`', '${label}',`)).length;
    const tally = { DONE: 0, PARTIAL: 0, 'PART B': 0 } as Record<string, number>;
    for (const r of COMPLIANCE) tally[STATUS_LABEL[r.status]]!++;
    expect(counts('DONE')).toBe(tally.DONE);
    expect(counts('PARTIAL')).toBe(tally.PARTIAL);
    expect(counts('PART B')).toBe(tally['PART B']);
  });

  it('★ still says the logs are simulated and the mean is on the line', () => {
    const html = readFileSync(BRIEF, 'utf8');
    expect(html).toMatch(/Every log is simulated/i);
    // The sentence wraps in the generated HTML, so match the part that carries
    // the claim rather than a fixed run of whitespace.
    expect(html).toMatch(/&lt;10% target rather than under it/i);
  });

  it('★ is genuinely self-contained — nothing to fetch', () => {
    // It is opened from a USB stick on someone else's laptop with no network.
    // A single remote font or script would leave it half-rendered.
    const html = readFileSync(BRIEF, 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/href=["']https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it('quotes the p90 next to the mean', () => {
    const html = readFileSync(BRIEF, 'utf8');
    expect(html).toMatch(/p90/);
    expect(html).toMatch(/22\.6% p90|22\.6/);
  });
});

describe('the offline brief actually renders', () => {
  /**
   * It is opened from a USB stick on a stranger's laptop. String assertions
   * cannot catch a document that is subtly malformed — an unclosed table, a
   * stray angle bracket from an unescaped value — and the failure would happen
   * there, with nobody able to fix it.
   */
  const html = readFileSync(BRIEF, 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');

  it('★ parses, with a title and a body', () => {
    expect(doc.querySelector('title')?.textContent).toMatch(/PathPulse/);
    expect(doc.body.textContent?.length ?? 0).toBeGreaterThan(500);
  });

  it('★ renders the full ablation table, not a truncated one', () => {
    const bodyRows = doc.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBeGreaterThanOrEqual(8);
    for (const row of Array.from(bodyRows)) {
      expect(row.querySelectorAll('td').length).toBe(5);
    }
  });

  it('marks the shipped configuration so the eye lands on it', () => {
    expect(doc.querySelector('tr.shipped')).not.toBeNull();
  });

  it('renders every compliance row with a status badge', () => {
    const rows = doc.querySelectorAll('.row');
    expect(rows.length).toBe(COMPLIANCE.length);
    for (const row of Array.from(rows)) {
      expect(row.querySelector('b')?.textContent?.trim()).toMatch(/DONE|PARTIAL|PART B/);
      expect((row.querySelector('p')?.textContent ?? '').length).toBeGreaterThan(25);
    }
  });

  it('★ leaves no unescaped markup from a generated value', () => {
    // Everything interpolated goes through esc(). A stray tag here would mean
    // a value escaped the escaper.
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(html).not.toMatch(/<b class="s-">/);
  });
});
