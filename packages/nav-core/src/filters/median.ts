/**
 * Sliding median filter.
 *
 * Kills isolated spikes — a pothole shock, a dropped sample — without the
 * smearing a mean would cause. A single 30 m/s^2 jolt inside a 5-sample window
 * is discarded entirely by the median, whereas a mean would spread it across
 * five samples and integrate into real position error.
 */
export class MedianFilter {
  private readonly buffer: number[] = [];

  constructor(private readonly windowSize = 5) {
    if (windowSize < 1) throw new Error('windowSize must be >= 1');
  }

  push(value: number): number {
    if (!Number.isFinite(value)) return this.current();
    this.buffer.push(value);
    if (this.buffer.length > this.windowSize) this.buffer.shift();
    return this.current();
  }

  current(): number {
    if (this.buffer.length === 0) return 0;
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  }

  reset(): void {
    this.buffer.length = 0;
  }
}

/** Three independent median filters, one per axis. */
export class Vec3MedianFilter {
  private readonly x: MedianFilter;
  private readonly y: MedianFilter;
  private readonly z: MedianFilter;

  constructor(windowSize = 5) {
    this.x = new MedianFilter(windowSize);
    this.y = new MedianFilter(windowSize);
    this.z = new MedianFilter(windowSize);
  }

  push(x: number, y: number, z: number): [number, number, number] {
    return [this.x.push(x), this.y.push(y), this.z.push(z)];
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}
