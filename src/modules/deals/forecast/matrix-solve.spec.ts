import {
  choleskyDecompose,
  choleskySolve,
  quadraticForm,
  symmetricInverse,
} from "./matrix-solve";

/**
 * A = [[4, 2], [2, 3]].
 *
 * By hand: L₀₀ = sqrt(4) = 2, L₁₀ = 2 / 2 = 1, L₁₁ = sqrt(3 − 1²) = sqrt(2).
 * det A = 12 − 4 = 8, so A⁻¹ = (1/8)[[3, −2], [−2, 4]].
 */
const A: number[][] = [
  [4, 2],
  [2, 3],
];

describe("choleskyDecompose", () => {
  it("factors a positive definite matrix into the L a reader can verify", () => {
    const l = choleskyDecompose(A);

    expect(l).not.toBeNull();
    expect(l?.[0]).toEqual([2, 0]);
    expect(l?.[1]?.[0]).toBeCloseTo(1, 12);
    expect(l?.[1]?.[1]).toBeCloseTo(Math.SQRT2, 12);
  });

  it("refuses a matrix that is not positive definite rather than guessing", () => {
    expect(
      choleskyDecompose([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
  });

  it("refuses a singular matrix", () => {
    expect(
      choleskyDecompose([
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull();
  });
});

describe("choleskySolve", () => {
  /** A x = [1, 1] has the solution [0.125, 0.25]: 4(⅛) + 2(¼) = 1, 2(⅛) + 3(¼) = 1. */
  it("solves A x = b", () => {
    const l = choleskyDecompose(A);
    const x = choleskySolve(l ?? [], [1, 1]);

    expect(x[0]).toBeCloseTo(0.125, 12);
    expect(x[1]).toBeCloseTo(0.25, 12);
  });
});

describe("symmetricInverse", () => {
  it("inverts a positive definite matrix", () => {
    const inverse = symmetricInverse(A);

    expect(inverse?.[0]?.[0]).toBeCloseTo(3 / 8, 12);
    expect(inverse?.[0]?.[1]).toBeCloseTo(-2 / 8, 12);
    expect(inverse?.[1]?.[0]).toBeCloseTo(-2 / 8, 12);
    expect(inverse?.[1]?.[1]).toBeCloseTo(4 / 8, 12);
  });

  it("returns a matrix that is symmetric to the bit", () => {
    const inverse = symmetricInverse([
      [10, 3, 1],
      [3, 8, 2],
      [1, 2, 6],
    ]);

    expect(inverse?.[0]?.[1]).toBe(inverse?.[1]?.[0]);
    expect(inverse?.[0]?.[2]).toBe(inverse?.[2]?.[0]);
    expect(inverse?.[1]?.[2]).toBe(inverse?.[2]?.[1]);
  });

  it("returns null rather than an inverse that does not exist", () => {
    expect(
      symmetricInverse([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
  });
});

describe("quadraticForm", () => {
  /** xᵀ A x for x = [1, 2] is 4 + 4 + 4 + 12 = 24. */
  it("computes the variance of a linear combination", () => {
    expect(quadraticForm(A, [1, 2])).toBeCloseTo(24, 12);
  });

  it("is zero for the zero vector", () => {
    expect(quadraticForm(A, [0, 0])).toBe(0);
  });

  it("never reports a negative variance", () => {
    expect(
      quadraticForm(
        [
          [-1, 0],
          [0, -1],
        ],
        [1, 1],
      ),
    ).toBe(0);
  });
});
