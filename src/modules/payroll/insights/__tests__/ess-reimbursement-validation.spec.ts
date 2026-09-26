import { essCreateReimbursementSchema } from "../dto/insights.schemas";
import { createReimbursementSchema } from "../../hr-payroll/dto/payroll.schemas";
import { reimbursementAmountSchema } from "../../../../common/validation/reimbursement-amount.schema";

describe("reimbursementAmountSchema — shared money constraint (PAY-004)", () => {
  it("accepts 1234.57, two-decimal-place values above ₹1 and whole rupees so a legitimate claim is not rejected", () => {
    expect(reimbursementAmountSchema.safeParse(1234.57).success).toBe(true);
    expect(reimbursementAmountSchema.safeParse(99.99).success).toBe(true);
    expect(reimbursementAmountSchema.safeParse(1.07).success).toBe(true);
    expect(reimbursementAmountSchema.safeParse(1).success).toBe(true);
    expect(reimbursementAmountSchema.safeParse(100).success).toBe(true);
    expect(reimbursementAmountSchema.safeParse(999999).success).toBe(true);
  });

  it("rejects 1234.5678 and 10.005 which exceed two decimal places", () => {
    expect(reimbursementAmountSchema.safeParse(1234.5678).success).toBe(false);
    expect(reimbursementAmountSchema.safeParse(10.005).success).toBe(false);
  });

  it("rejects amounts below ₹1 because the floor is not just positive but a whole rupee minimum", () => {
    expect(reimbursementAmountSchema.safeParse(0).success).toBe(false);
    expect(reimbursementAmountSchema.safeParse(0.50).success).toBe(false);
    expect(reimbursementAmountSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects amounts above ₹9,99,999", () => {
    expect(reimbursementAmountSchema.safeParse(1000000).success).toBe(false);
  });
});

describe("ESS Reimbursement Validation — PAY-004", () => {
  describe("applies the identical amount rule on the HR route and the employee self-service route, because both write the same decimal(15,2) column", () => {
    it("rejects 1234.5678 on the employee self-service route, which previously accepted it and let Postgres silently round the reimbursement to an amount the employee did not type", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 1234.5678,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Amount must have at most 2 decimal places");
      }
    });

    it("rejects 1234.5678 on the HR route too, confirming both routes share the same validation", () => {
      const result = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 1234.5678,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Amount must have at most 2 decimal places");
      }
    });

    it("accepts 1234.57, two-decimal-place values and whole rupees so a legitimate two-decimal claim is not rejected", () => {
      const essResult = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 1234.57,
        description: "Valid claim",
        payrollMonth: "2026-09",
      });
      expect(essResult.success).toBe(true);

      const hrResult = createReimbursementSchema.safeParse({
        category: "Travel",
        amount: 99.99,
        description: "Valid claim",
      });
      expect(hrResult.success).toBe(true);
    });
  });

  describe("essCreateReimbursementSchema — amount validation", () => {
    it("rejects negative amounts", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: -1,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero amounts", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 0,
        description: "Test expense",
      });
      expect(result.success).toBe(false);
    });

    it("rejects amounts below ₹1 because the ESS floor is now ₹1 to match the HR route, not merely positive", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 0.50,
        description: "Small expense",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Amount must be at least ₹1");
      }
    });

    it("accepts positive amounts above ₹1", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 100.50,
        description: "Valid expense",
        payrollMonth: "2026-09",
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

    it("rejects 10.005 which has three decimal places", () => {
      const result = essCreateReimbursementSchema.safeParse({
        category: "Travel",
        amount: 10.005,
        description: "Too many decimals",
      });
      expect(result.success).toBe(false);
    });
  });
});
