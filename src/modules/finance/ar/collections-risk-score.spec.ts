import { computeRiskScore } from "./collections-risk.util";

describe("computeRiskScore", () => {
  describe("bounds 0–100", () => {
    it("is 0 when nothing is overdue", () => {
      expect(computeRiskScore(0, 1000, 0)).toBe(0);
    });

    it("is 100 when fully overdue with maxDaysOverdue >= 180", () => {
      expect(computeRiskScore(1000, 1000, 180)).toBe(100);
    });

    it("is capped at 100 even when overdueAmount > totalInvoiced", () => {
      const score = computeRiskScore(99999, 1000, 365);
      expect(score).toBe(100);
    });

    it("is never negative", () => {
      expect(computeRiskScore(0, 0, 0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("overdueRatio weighting (50 points)", () => {
    it("50% overdue ratio contributes 25 points from ratio", () => {
      const score = computeRiskScore(500, 1000, 0);
      expect(score).toBe(25);
    });

    it("100% overdue ratio contributes 50 points from ratio", () => {
      const score = computeRiskScore(1000, 1000, 0);
      expect(score).toBe(50);
    });

    it("0% ratio with max days gives 50", () => {
      const score = computeRiskScore(0, 1000, 180);
      expect(score).toBe(50);
    });

    it("totalInvoiced of zero yields ratio 0 (no division by zero)", () => {
      const score = computeRiskScore(100, 0, 0);
      expect(score).toBe(0);
    });
  });

  describe("daysOverdue capped at 180", () => {
    it("180 days contributes 50 points from days component", () => {
      const score = computeRiskScore(0, 1000, 180);
      expect(score).toBe(50);
    });

    it("270 days is capped to 180 — same as 180", () => {
      const atCap = computeRiskScore(0, 1000, 180);
      const beyond = computeRiskScore(0, 1000, 270);
      expect(beyond).toBe(atCap);
    });

    it("90 days contributes 25 points from days component", () => {
      const score = computeRiskScore(0, 1000, 90);
      expect(score).toBe(25);
    });
  });

  describe("combined scoring", () => {
    it("50% ratio + 90 days = 50 (ratio=25 + days=25)", () => {
      const score = computeRiskScore(500, 1000, 90);
      expect(score).toBe(50);
    });

    it("rounding: Math.round applied correctly", () => {
      const score = computeRiskScore(333, 1000, 90);
      const expected = Math.round(0.333 * 50 + 90 / 180 * 50);
      expect(score).toBe(expected);
    });
  });
});
