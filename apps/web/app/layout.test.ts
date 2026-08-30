import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The layout rules, asserted against the source.
 *
 * ★ WHY A GREP TEST AND NOT A RENDER TEST ★
 * page.tsx dynamically imports a WebGL map, so it cannot be mounted in jsdom —
 * it is one of the files at 0% coverage. But the overlap bugs were never
 * subtle runtime behaviour; they were two elements given the same corner and
 * the same z-index, visible in the source. Overlap kept coming back because
 * each new panel picked its own position with nothing to check it against.
 *
 * These are the rules that stop it recurring.
 */

const PAGE = readFileSync(resolve(process.cwd(), 'app/page.tsx'), 'utf8');
const COMPONENTS = resolve(process.cwd(), 'components');
const read = (f: string) => readFileSync(resolve(COMPONENTS, f), 'utf8');

describe('only one panel can be open', () => {
  it('★ panels are one state value, not a bag of booleans', () => {
    // Six independent `show*` flags meant several panels could be open at
    // once and stack. A single value cannot express "two things open".
    expect(PAGE).toMatch(/const \[panel, setPanel\] = useState<Panel>/);
    const showFlags = PAGE.match(/const \[show[A-Z]\w*, setShow\w+\] = useState/g) ?? [];
    expect(showFlags).toEqual([]);
  });

  it('every panel is rendered by comparing that one value', () => {
    for (const name of ['menu', 'sources', 'debug', 'offline', 'benchmarks', 'pitch', 'device']) {
      expect(PAGE, name).toContain(`panel === '${name}'`);
    }
  });
});

describe('what is allowed to sit over the map', () => {
  it('★ exactly two things: the HUD and the menu button', () => {
    // Everything else moved behind the menu. This is what stops the top of
    // the screen filling up again one button at a time.
    expect(read('Hud.tsx')).toContain('left-3 top-3');
    expect(PAGE).toMatch(/absolute right-3 top-3[^"]*z-30/);
    // The old five-button row is gone.
    expect(PAGE).not.toContain('Benchmarks\n        </button>');
  });

  it('the demo button is centred, so it cannot collide with a left panel', () => {
    expect(PAGE).toMatch(/absolute bottom-4 left-1\/2[^"]*-translate-x-1\/2/);
  });
});

describe('every overlay can be dismissed', () => {
  it('★ the shared sheet always renders a close button', () => {
    const sheet = read('Sheet.tsx');
    expect(sheet).toMatch(/aria-label=\{`Close \$\{title\}`\}/);
  });

  it('★ the permission gate offers a way out, not just Retry', () => {
    // It covers the whole screen. Offering only Retry made it a trap: deny
    // once, or be on an http origin, and there was no way back to a working
    // source because everything else was underneath it.
    const gate = read('PermissionGate.tsx');
    expect(gate).toContain('onUseSimulation');
    expect(gate).toMatch(/Use the simulation instead/);
  });

  it('the gate sits above the sheets, so it is never half-covered', () => {
    expect(read('PermissionGate.tsx')).toMatch(/z-\[45\]/);
    expect(read('Sheet.tsx')).toMatch(/z-40/);
  });
});
