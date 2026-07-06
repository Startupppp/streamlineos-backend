import { roundHours } from "./rounding";

describe("roundHours", () => {
  it("leaves hours unchanged for NONE / unknown / missing rule", () => {
    expect(roundHours(1.234, "NONE")).toBe(1.23);
    expect(roundHours(1.5, undefined)).toBe(1.5);
    expect(roundHours(1.5, null)).toBe(1.5);
    expect(roundHours(1.5, "WHATEVER")).toBe(1.5);
  });

  it("returns 0 for non-positive input", () => {
    expect(roundHours(0, "NEAREST_15")).toBe(0);
    expect(roundHours(-2, "NEAREST_15")).toBe(0);
  });

  it("rounds to the nearest 15 minutes", () => {
    expect(roundHours(1.03, "NEAREST_15")).toBe(1);
    expect(roundHours(1.5, "NEAREST_15")).toBe(1.5);
    expect(roundHours(1.2, "NEAREST_15")).toBe(1.25);
  });

  it("rounds to the nearest 5 / 10 minutes", () => {
    expect(roundHours(1.06, "NEAREST_5")).toBe(1.08);
    expect(roundHours(1.1, "NEAREST_10")).toBe(1.17);
  });

  it("rounds up and down to the 15-minute increment", () => {
    expect(roundHours(1.1, "ROUND_UP")).toBe(1.25);
    expect(roundHours(1.1, "ROUND_DOWN")).toBe(1);
    expect(roundHours(1.0, "ROUND_UP")).toBe(1);
  });
});
