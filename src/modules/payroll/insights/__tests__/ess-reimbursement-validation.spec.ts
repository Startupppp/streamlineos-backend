import { essCreateReimbursementSchema } from "../dto/insights.schemas";

describe("ESS Reimbursement Validation — PAY-004", () => {
  describe("essCreateReimbursementSchema — amount validation", () => {
    it("rejects negative amounts", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: -1,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("greater than zero");
      }
    });

    it("rejects zero amounts", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 0,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("greater than zero");
      }
    });

    it("accepts positive amounts", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 100.50,
        description: "Valid expense",
        payrollMonth: "2026-09",
      });
      expect(result.success).toBe(true);
    });

    it("accepts minimum valid amount", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 0.01,
        description: "Small expense",
      });
      expect(result.success).toBe(true);
    });

    it("rejects amounts exceeding maximum", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 1000000,
        description: "Too large",
      });
      expect(result.success).toBe(false);
    });
  });
});
