/**
 * The three matrix operations a logistic fit needs, and nothing else.
 *
 * Cholesky rather than a general solver because the matrix being inverted is the
 * penalised Fisher information — symmetric, and positive definite for any ridge
 * above zero. That makes the decomposition both cheaper and a check: if it
 * fails, the matrix was not what the caller believed, and returning null is a
 * better answer than a set of coefficients derived from a silent fallback.
 *
 * No dependency, because a forecast has to be auditable and a hundred lines a
 * reviewer can read beats a library they will not.
 */

export type Matrix = readonly (readonly number[])[];

/**
 * The lower-triangular L with L Lᵀ = A, or null when A is not positive definite.
 */
export function choleskyDecompose(a: Matrix): number[][] | null {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let i = 0; i < n; i += 1) {
    const rowA = a[i];
    const rowL = l[i];
    if (rowA === undefined || rowL === undefined || rowA.length !== n) return null;

    for (let j = 0; j <= i; j += 1) {
      const rowJ = l[j];
      if (rowJ === undefined) return null;

      let sum = rowA[j] ?? 0;
      for (let k = 0; k < j; k += 1) sum -= (rowL[k] ?? 0) * (rowJ[k] ?? 0);

      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        rowL[j] = Math.sqrt(sum);
      } else {
        const pivot = rowJ[j] ?? 0;
        if (pivot === 0) return null;
        rowL[j] = sum / pivot;
      }
    }
  }

  return l;
}

/** Solves A x = b given L from `choleskyDecompose(A)`. */
export function choleskySolve(l: Matrix, b: readonly number[]): number[] {
  const n = l.length;
  const y = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const row = l[i];
    let sum = b[i] ?? 0;
    for (let k = 0; k < i; k += 1) sum -= (row?.[k] ?? 0) * (y[k] ?? 0);
    y[i] = sum / (row?.[i] ?? 1);
  }

  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i] ?? 0;
    for (let k = i + 1; k < n; k += 1) sum -= (l[k]?.[i] ?? 0) * (x[k] ?? 0);
    x[i] = sum / (l[i]?.[i] ?? 1);
  }

  return x;
}

/** A⁻¹ for a symmetric positive definite A, or null when it is not. */
export function symmetricInverse(a: Matrix): number[][] | null {
  const l = choleskyDecompose(a);
  if (l === null) return null;

  const n = a.length;
  const columns: number[][] = [];
  for (let j = 0; j < n; j += 1) {
    const unit = new Array<number>(n).fill(0);
    unit[j] = 1;
    columns.push(choleskySolve(l, unit));
  }

  // Symmetry is a property of the answer, not of the arithmetic that produced
  // it; averaging the two triangles keeps rounding from making a variance
  // depend on which side of the diagonal it was read from.
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => ((columns[j]?.[i] ?? 0) + (columns[i]?.[j] ?? 0)) / 2),
  );
}

/** xᵀ A x — a variance, when A is a covariance matrix. Never negative. */
export function quadraticForm(a: Matrix, x: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < x.length; i += 1) {
    const row = a[i];
    if (row === undefined) continue;
    for (let j = 0; j < x.length; j += 1) total += (x[i] ?? 0) * (row[j] ?? 0) * (x[j] ?? 0);
  }
  return Number.isFinite(total) && total > 0 ? total : 0;
}
