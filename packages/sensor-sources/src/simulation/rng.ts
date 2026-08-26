/**
 * Seeded RNG.
 *
 * Determinism is not a nicety here: the eval harness (Phase 7) compares drift
 * across constraint configurations. If the simulated noise differed between
 * runs, the ablation table would be measuring the random seed instead of the
 * constraints.
 */

/** mulberry32 — small, fast, good enough statistical quality for sensor noise. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal samples via Box-Muller.
 * Returns a generator so the second value of each pair is not wasted.
 */
export function createGaussian(seed: number): () => number {
  const rng = createRng(seed);
  let spare: number | null = null;
  return function gaussian() {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    // Guard against log(0).
    let u = rng();
    while (u === 0) u = rng();
    const v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}
