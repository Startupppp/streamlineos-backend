import { toPaise, fromPaise, applyRounding, pctOf, daysInMonth } from "../money";

describe("money helpers", () => {
  describe("toPaise", () => {
    it("converts integer rupee string", () => expect(toPaise("100")).toBe(10000));
    it("converts decimal string", () => expect(toPaise("100.50")).toBe(10050));
    it("handles zero", () => expect(toPaise("0")).toBe(0));
    it("rounds fractional paise", () => expect(toPaise("100.005")).toBe(10001));
  });

  describe("fromPaise", () => {
    it("converts paise to decimal string", () => expect(fromPaise(10050)).toBe("100.50"));
    it("handles zero", () => expect(fromPaise(0)).toBe("0.00"));
  });

  describe("applyRounding", () => {
    it("NEAREST precision 0 rounds to rupee", () => expect(applyRounding(10050, { mode: "NEAREST", precision: 0 })).toBe(10100));
    it("UP precision 0 rounds up", () => expect(applyRounding(10001, { mode: "UP", precision: 0 })).toBe(10100));
    it("DOWN precision 0 rounds down", () => expect(applyRounding(10099, { mode: "DOWN", precision: 0 })).toBe(10000));
    it("NEAREST precision 2 is identity for whole paise", () => expect(applyRounding(10050, { mode: "NEAREST", precision: 2 })).toBe(10050));
  });

  describe("pctOf", () => {
    it("12% of 100000 paise", () => expect(pctOf(100000, "12.00")).toBe(12000));
    it("40% of 83333 paise", () => expect(pctOf(83333, "40")).toBe(33333));
  });

  describe("daysInMonth", () => {
    it("Jan 2025 has 31 days", () => expect(daysInMonth("2025-01")).toBe(31));
    it("Feb 2024 (leap) has 29", () => expect(daysInMonth("2024-02")).toBe(29));
    it("Apr 2025 has 30", () => expect(daysInMonth("2025-04")).toBe(30));
  });
});
