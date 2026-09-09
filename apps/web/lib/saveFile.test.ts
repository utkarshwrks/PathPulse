import { describe, expect, it, vi, beforeEach } from 'vitest';
import { describeSave } from './saveFile';

/**
 * ★ THE FAILURE THIS FILE EXISTS FOR WAS SILENT ★
 *
 * A ride recorded, Save pressed, no file and no error. So the one thing worth
 * testing hardest is that every outcome produces words.
 */
describe('describeSave', () => {
  it('says so when the file was shared', () => {
    expect(describeSave({ kind: 'shared', path: '/x' }, 'drive_1.jsonl')).toContain('shared');
  });

  it('names where it landed when sharing was declined', () => {
    // Cancelling the share sheet is not a failure — the file is on disk.
    const msg = describeSave({ kind: 'saved', path: '/x' }, 'drive_1.jsonl');
    expect(msg).toContain('drive_1.jsonl');
    expect(msg).toContain('Documents');
  });

  it('says so on the browser path', () => {
    expect(describeSave({ kind: 'downloaded' }, 'a.json')).toContain('downloaded');
  });

  it('★ never fails silently', () => {
    const msg = describeSave({ kind: 'failed', reason: 'disk full' }, 'a.json');
    expect(msg).toContain('could not save');
    expect(msg).toContain('disk full');
  });

  it('every outcome produces a non-empty line', () => {
    const outcomes = [
      { kind: 'shared' as const, path: '/x' },
      { kind: 'saved' as const, path: '/x' },
      { kind: 'downloaded' as const },
      { kind: 'failed' as const, reason: 'x' },
    ];
    for (const o of outcomes) {
      expect(describeSave(o, 'f.json').length).toBeGreaterThan(0);
    }
  });
});

describe('saveTextFile', () => {
  beforeEach(() => vi.resetModules());

  it('refuses an empty file rather than writing one', async () => {
    const { saveTextFile } = await import('./saveFile');
    const r = await saveTextFile('', 'x.jsonl', 'application/x-ndjson');
    expect(r.kind).toBe('failed');
  });
});
