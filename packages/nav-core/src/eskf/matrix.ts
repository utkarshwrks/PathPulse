/**
 * A very small dense-matrix module.
 *
 * ★ WHY NOT ml-matrix ★
 * The build guide suggests it. nav-core has zero runtime dependencies and that
 * is not an accident — it is what lets the identical file run in the browser,
 * inside the Capacitor WebView, in headless replay, and in the Node edge
 * engine at 200 Hz. Adding a dependency to nav-core would put a package
 * resolution step between the phone and the estimator for the sake of an
 * inverse of a matrix that is never larger than 15x15. Everything the ESKF
 * needs is below, in about a hundred and fifty lines.
 *
 * Matrices are plain `number[][]`, row-major. Vectors are `number[]`.
 * Nothing here allocates outside the value it returns, and nothing mutates an
 * argument unless the name says so (`symmetrizeInPlace`).
 */

export type Mat = number[][];

export function zeros(rows: number, cols: number): Mat {
  const m: Mat = new Array(rows);
  for (let i = 0; i < rows; i++) m[i] = new Array(cols).fill(0);
  return m;
}

export function identity(n: number): Mat {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i]![i] = 1;
  return m;
}

/** Diagonal matrix from a list of diagonal entries. */
export function diag(values: number[]): Mat {
  const m = zeros(values.length, values.length);
  for (let i = 0; i < values.length; i++) m[i]![i] = values[i]!;
  return m;
}

export function clone(a: Mat): Mat {
  return a.map((row) => row.slice());
}

export function transpose(a: Mat): Mat {
  const rows = a.length;
  const cols = a[0]?.length ?? 0;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++) {
    const ai = a[i]!;
    for (let j = 0; j < cols; j++) out[j]![i] = ai[j]!;
  }
  return out;
}

export function add(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v + b[i]![j]!));
}

export function sub(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v - b[i]![j]!));
}

export function scale(a: Mat, k: number): Mat {
  return a.map((row) => row.map((v) => v * k));
}

export function mul(a: Mat, b: Mat): Mat {
  const n = a.length;
  const k = b.length;
  const m = b[0]?.length ?? 0;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let p = 0; p < k; p++) {
      const aip = ai[p]!;
      if (aip === 0) continue; // F and H are mostly zero; this is most of the speed
      const bp = b[p]!;
      for (let j = 0; j < m; j++) oi[j]! += aip * bp[j]!;
    }
  }
  return out;
}

/** Matrix times column vector. */
export function mulVec(a: Mat, v: number[]): number[] {
  const out = new Array(a.length).fill(0);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    let s = 0;
    for (let j = 0; j < v.length; j++) s += ai[j]! * v[j]!;
    out[i] = s;
  }
  return out;
}

/**
 * Force exact symmetry.
 *
 * ★ COVARIANCE ROT IS SILENT ★ P is symmetric in theory and drifts out of it
 * in floating point, a little on every product. Once it is asymmetric the
 * innovation covariance can lose positive-definiteness, the inverse returns
 * something that is not a covariance, and the filter walks off without ever
 * producing a NaN to trip an assertion. Averaging with the transpose costs
 * 225 additions on a 15x15 and removes the whole failure mode.
 */
export function symmetrizeInPlace(p: Mat): Mat {
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const v = 0.5 * (p[i]![j]! + p[j]![i]!);
      p[i]![j] = v;
      p[j]![i] = v;
    }
  }
  return p;
}

/**
 * Inverse by Gauss-Jordan with partial pivoting.
 *
 * Only ever called on an innovation covariance S, which is at most 3x3 in this
 * filter. Throws rather than returning garbage: a singular S means the caller
 * handed in a zero measurement noise or a degenerate H, and quietly inverting
 * it would put Infinity into the gain and from there into the state.
 */
export function inverse(a: Mat): Mat {
  const n = a.length;
  const m = clone(a);
  const inv = identity(n);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    const pv = m[pivot]![col]!;
    if (!Number.isFinite(pv) || Math.abs(pv) < 1e-12) {
      throw new Error(`matrix is singular at column ${col}`);
    }
    if (pivot !== col) {
      [m[pivot], m[col]] = [m[col]!, m[pivot]!];
      [inv[pivot], inv[col]] = [inv[col]!, inv[pivot]!];
    }

    const mc = m[col]!;
    const ic = inv[col]!;
    const d = mc[col]!;
    for (let j = 0; j < n; j++) {
      mc[j]! /= d;
      ic[j]! /= d;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      const mr = m[r]!;
      const ir = inv[r]!;
      for (let j = 0; j < n; j++) {
        mr[j]! -= f * mc[j]!;
        ir[j]! -= f * ic[j]!;
      }
    }
  }
  return inv;
}

/**
 * True when every eigenvalue is positive, tested by attempting a Cholesky
 * factorisation. Used by the tests to assert the filter keeps P a covariance.
 */
export function isPositiveDefinite(a: Mat): boolean {
  const n = a.length;
  const l = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i]![j]!;
      for (let k = 0; k < j; k++) s -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return false;
        l[i]![j] = Math.sqrt(s);
      } else {
        l[i]![j] = s / l[j]![j]!;
      }
    }
  }
  return true;
}

/** Sum of the diagonal — the scalar "how uncertain am I" the UI can plot. */
export function trace(a: Mat): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]![i]!;
  return s;
}

/** The 3x3 skew-symmetric matrix with [w]x u === cross(w, u). */
export function skew(w: readonly number[]): Mat {
  const [x, y, z] = [w[0]!, w[1]!, w[2]!];
  return [
    [0, -z, y],
    [z, 0, -x],
    [-y, x, 0],
  ];
}

/** Write `block` into `target` with its top-left corner at (row, col). */
export function setBlock(target: Mat, row: number, col: number, block: Mat): void {
  for (let i = 0; i < block.length; i++) {
    const bi = block[i]!;
    const ti = target[row + i]!;
    for (let j = 0; j < bi.length; j++) ti[col + j] = bi[j]!;
  }
}
