import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
  clampStep,
  forgetTour,
  hasSeenTour,
  markTourSeen,
  stepAt,
} from './tour';

/**
 * The guided tour's content and storage.
 *
 * The audience is someone holding a borrowed phone with about ninety seconds
 * of patience, so the constraints worth asserting are about length and escape
 * routes rather than logic.
 */

/**
 * An in-memory Storage shim.
 *
 * jsdom in this setup exposes `localStorage` as a property that reads back
 * `undefined` even with a real origin, so the browser's own storage is not
 * available to assert against. That is fine: what needs testing is this
 * module's wrapper — that it remembers, forgets and degrades quietly — not
 * whether the DOM implements the spec.
 */
function installStorage(impl?: Partial<Storage>): void {
  const data = new Map<string, string>();
  const shim = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    ...impl,
  } as Storage;
  Object.defineProperty(window, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TOUR_STEPS', () => {
  it('is short enough to finish', () => {
    expect(TOUR_STEPS.length).toBeGreaterThan(5);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(12);
  });

  it('has unique ids', () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
  });

  it('★ says something real in every step, and keeps it readable aloud', () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.length, s.id).toBeGreaterThan(5);
      expect(s.body.length, s.id).toBeGreaterThan(60);
      // Roughly fifteen seconds of speech. Longer and it gets skipped.
      expect(s.body.length, s.id).toBeLessThan(400);
    }
  });

  it('opens by explaining the problem, not the interface', () => {
    expect(TOUR_STEPS[0]!.body).toMatch(/tunnel|basement|satellite/i);
  });

  it('★ covers the features that carry the credibility', () => {
    const text = TOUR_STEPS.map((s) => `${s.title} ${s.body}`).join(' ').toLowerCase();
    for (const topic of ['ellipse', 'dead reckoning', 'constraint', 'aeroplane', 'event log']) {
      expect(text, topic).toContain(topic);
    }
  });
});

describe('clampStep / stepAt', () => {
  it('never runs off either end', () => {
    expect(clampStep(-5)).toBe(0);
    expect(clampStep(999)).toBe(TOUR_STEPS.length - 1);
    expect(clampStep(NaN)).toBe(0);
    expect(stepAt(999).id).toBe(TOUR_STEPS[TOUR_STEPS.length - 1]!.id);
  });
});

describe('tour storage', () => {
  it('remembers that the tour was seen', () => {
    installStorage();
    expect(hasSeenTour()).toBe(false);
    markTourSeen();
    expect(hasSeenTour()).toBe(true);
    expect(window.localStorage.getItem(TOUR_STORAGE_KEY)).toBe('1');
    forgetTour();
    expect(hasSeenTour()).toBe(false);
  });

  it('★ survives a browser with no localStorage at all', () => {
    // Which is exactly what this jsdom gives, and what an opaque origin gives.
    Object.defineProperty(window, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => hasSeenTour()).not.toThrow();
    expect(hasSeenTour()).toBe(false);
    expect(() => markTourSeen()).not.toThrow();
  });

  it('★ survives a browser that throws on localStorage', () => {
    // Safari private mode throws rather than returning null. A first-run
    // helper that crashes the app on a borrowed phone is a poor first run.
    const boom = () => {
      throw new Error('denied');
    };
    installStorage({ getItem: boom, setItem: boom, removeItem: boom });

    expect(() => hasSeenTour()).not.toThrow();
    expect(hasSeenTour()).toBe(false);
    expect(() => markTourSeen()).not.toThrow();
    expect(() => forgetTour()).not.toThrow();
  });
});
