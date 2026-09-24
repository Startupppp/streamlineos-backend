import { ANONYMITY_MIN_RESPONSES, isBelowAnonymityThreshold } from "./anonymity-threshold";

describe("anonymity threshold", () => {
  it("hides a segment with one fewer response than the minimum and shows one at the minimum", () => {
    expect(isBelowAnonymityThreshold(ANONYMITY_MIN_RESPONSES - 1)).toBe(true);
    expect(isBelowAnonymityThreshold(ANONYMITY_MIN_RESPONSES)).toBe(false);
    expect(isBelowAnonymityThreshold(ANONYMITY_MIN_RESPONSES + 1)).toBe(false);
  });

  it("treats a single response as hidden, since a segment of one is that person's answer", () => {
    expect(isBelowAnonymityThreshold(1)).toBe(true);
  });

  it("is the one floor every anonymised HR and survey aggregate shares", () => {
    expect(ANONYMITY_MIN_RESPONSES).toBe(5);
  });
});
