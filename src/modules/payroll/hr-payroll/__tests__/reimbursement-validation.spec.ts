import { createReimbursementSchema } from "../dto/payroll.schemas";

describe("HR Payroll Reimbursement Validation — PAY-004", () => {
  describe("createReimbursementSchema — amount validation", () => {
    it("rejects negative amounts", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: -100,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const amountError = result.error.issues.find(i => i.path.includes("amount"));
        expect(amountError?.message).toContain("at least ₹1");
      }
    });

    it("rejects zero amounts", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 0,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const amountError = result.error.issues.find(i => i.path.includes("amount"));
        expect(amountError?.message).toContain("at least ₹1");
      }
    });

    it("accepts valid positive amounts", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 150.75,
        description: "Valid expense",
        payrollMonth: "2026-09",
      });
      expect(result.success).toBe(true);
    });

    it("accepts minimum valid amount of ₹1", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Food",
        amount: 1,
        description: "Minimum amount",
      });
      expect(result.success).toBe(true);
    });

    it("rejects amounts with more than 2 decimal places", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 100.123,
        description: "Too many decimals",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const amountError = result.error.issues.find(i => i.path.includes("amount"));
        expect(amountError?.message).toContain("at most 2 decimal places");
      }
    });

    it("rejects amounts exceeding maximum", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 1000000,
        description: "Amount too large",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const amountError = result.error.issues.find(i => i.path.includes("amount"));
        expect(amountError?.message).toContain("cannot exceed ₹9,99,999");
      }
    });
  });
});
