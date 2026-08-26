import {
  createBonusSchema,
  createFnfSchema,
  patchFnfSchema,
  createTaxWindowBodySchema,
  patchTaxWindowBodySchema,
} from "../payroll.schemas";

describe("createBonusSchema", () => {
  const validBase = {
    userId: "user-1",
    type: "PERFORMANCE" as const,
    amount: 5000,
    month: "2025-01",
  };

  it("accepts valid bonus with required month", () => {
    expect(() => createBonusSchema.parse(validBase)).not.toThrow();
  });

  it("rejects missing month", () => {
    const { month: _m, ...noMonth } = validBase;
    expect(() => createBonusSchema.parse(noMonth)).toThrow();
  });

  it("rejects invalid month format", () => {
    expect(() => createBonusSchema.parse({ ...validBase, month: "2025/01" })).toThrow();
    expect(() => createBonusSchema.parse({ ...validBase, month: "01-2025" })).toThrow();
    expect(() => createBonusSchema.parse({ ...validBase, month: "2025-1" })).toThrow();
  });

  it("accepts taxable false", () => {
    const result = createBonusSchema.parse({ ...validBase, taxable: false });
    expect(result.taxable).toBe(false);
  });

  it("taxable defaults to undefined (DB default true applies)", () => {
    const result = createBonusSchema.parse(validBase);
    expect(result.taxable).toBeUndefined();
  });

  it("accepts all new bonus types", () => {
    const newTypes = ["JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT"] as const;
    for (const type of newTypes) {
      expect(() => createBonusSchema.parse({ ...validBase, type })).not.toThrow();
    }
  });

  it("rejects unknown bonus type", () => {
    expect(() => createBonusSchema.parse({ ...validBase, type: "MYSTERY" })).toThrow();
  });
});

describe("createFnfSchema", () => {
  const validBase = { userId: "user-1" };

  it("accepts contract C4 optional decimal fields", () => {
    const result = createFnfSchema.parse({
      ...validBase,
      reimbursementsDue: 1000,
      assetRecovery: 500,
      noticeRecovery: 2000,
      otherDeductions: 300,
    });
    expect(result.reimbursementsDue).toBe(1000);
    expect(result.assetRecovery).toBe(500);
    expect(result.noticeRecovery).toBe(2000);
    expect(result.otherDeductions).toBe(300);
  });

  it("all new fields are optional", () => {
    expect(() => createFnfSchema.parse(validBase)).not.toThrow();
  });

  it("rejects negative values for new decimal fields", () => {
    expect(() => createFnfSchema.parse({ ...validBase, reimbursementsDue: -1 })).toThrow();
  });
});

describe("patchFnfSchema", () => {
  it("accepts HR_REVIEW status", () => {
    const result = patchFnfSchema.parse({ status: "HR_REVIEW" });
    expect(result.status).toBe("HR_REVIEW");
  });

  it("accepts FINANCE_REVIEW status", () => {
    const result = patchFnfSchema.parse({ status: "FINANCE_REVIEW" });
    expect(result.status).toBe("FINANCE_REVIEW");
  });

  it("still accepts legacy statuses", () => {
    for (const status of ["PENDING_APPROVAL", "APPROVED", "PAID"] as const) {
      expect(() => patchFnfSchema.parse({ status })).not.toThrow();
    }
  });
});

describe("createTaxWindowBodySchema", () => {
  const validBase = {
    financialYear: "2025-26",
    opensAt: "2025-01-01T00:00:00.000Z",
    closesAt: "2025-03-31T23:59:59.000Z",
  };

  it("accepts valid window", () => {
    expect(() => createTaxWindowBodySchema.parse(validBase)).not.toThrow();
  });

  it("rejects invalid datetime for opensAt", () => {
    expect(() => createTaxWindowBodySchema.parse({ ...validBase, opensAt: "2025-01-01" })).toThrow();
  });

  it("accepts lockDate as YYYY-MM-DD", () => {
    const result = createTaxWindowBodySchema.parse({ ...validBase, lockDate: "2025-03-31" });
    expect(result.lockDate).toBe("2025-03-31");
  });

  it("rejects invalid lockDate format", () => {
    expect(() => createTaxWindowBodySchema.parse({ ...validBase, lockDate: "31-03-2025" })).toThrow();
    expect(() => createTaxWindowBodySchema.parse({ ...validBase, lockDate: "2025/03/31" })).toThrow();
    expect(() => createTaxWindowBodySchema.parse({ ...validBase, lockDate: "2025-03-31T00:00:00Z" })).toThrow();
  });
});

describe("patchTaxWindowBodySchema", () => {
  it("accepts partial updates", () => {
    expect(() => patchTaxWindowBodySchema.parse({})).not.toThrow();
    expect(() => patchTaxWindowBodySchema.parse({ status: "OPEN" })).not.toThrow();
  });

  it("rejects invalid lockDate in patch", () => {
    expect(() => patchTaxWindowBodySchema.parse({ lockDate: "2025/03/31" })).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() => patchTaxWindowBodySchema.parse({ status: "ACTIVE" })).toThrow();
  });
});
