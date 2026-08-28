import { resolveFact } from "./employment-fact-resolution";

describe("employment fact resolution", () => {
  it("prefers the canonical value and never counts a fallback", () => {
    expect(resolveFact("Engineer", null)).toEqual({
      value: "Engineer",
      usedFallback: false,
      disagreed: false,
    });
  });

  it("falls back to the legacy column only when the canonical value is absent", () => {
    expect(resolveFact(null, "Engineer")).toEqual({
      value: "Engineer",
      usedFallback: true,
      disagreed: false,
    });
    expect(resolveFact("", "Engineer")).toEqual({
      value: "Engineer",
      usedFallback: true,
      disagreed: false,
    });
  });

  it("keeps the canonical value and flags a disagreement when the two differ", () => {
    expect(resolveFact("Engineer", "Developer")).toEqual({
      value: "Engineer",
      usedFallback: false,
      disagreed: true,
    });
  });

  it("does not flag a disagreement when the two agree", () => {
    expect(resolveFact("Engineer", "Engineer")).toEqual({
      value: "Engineer",
      usedFallback: false,
      disagreed: false,
    });
  });

  it("resolves nothing when neither side has a value", () => {
    expect(resolveFact(null, null)).toEqual({
      value: null,
      usedFallback: false,
      disagreed: false,
    });
  });

  it("compares structured values such as bank details by content", () => {
    const canonical = { accountNumber: "1", ifsc: "A" };
    expect(resolveFact(canonical, { accountNumber: "1", ifsc: "A" }).disagreed).toBe(false);
    expect(resolveFact(canonical, { accountNumber: "2", ifsc: "A" }).disagreed).toBe(true);
  });

  it("treats zero and false as present values rather than absent ones", () => {
    expect(resolveFact(0, 5)).toEqual({ value: 0, usedFallback: false, disagreed: true });
    expect(resolveFact(null, 0)).toEqual({ value: 0, usedFallback: true, disagreed: false });
  });
});
