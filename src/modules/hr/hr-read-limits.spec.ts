import { boundHrReadLimit } from "./hr-read-limits";

describe("boundHrReadLimit", () => {
  it.each([
    [0, 1],
    [-10, 1],
    [1.9, 1],
    [100, 100],
    [101, 100],
    [Number.POSITIVE_INFINITY, 100],
    [Number.NaN, 100],
  ])("bounds %s to %s", (value, expected) => {
    expect(boundHrReadLimit(value)).toBe(expected);
  });

  it("supports a smaller domain-specific cap", () => {
    expect(boundHrReadLimit(50, 25)).toBe(25);
    expect(boundHrReadLimit(Number.NaN, 25)).toBe(25);
  });
});
