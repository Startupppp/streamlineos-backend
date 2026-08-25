import { CrmValidationService, type ValidationContext } from "./crm-validation.service";

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  // The uniqueness probe reads `business_parties` through the legacy id maps.
  innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockResolvedValue([]),
  limit: jest.fn().mockReturnThis(),
  then: jest.fn(),
};

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    orgId: "org1",
    entityType: "lead",
    field: "email",
    ruleType: "required",
    config: {},
    pipelineId: null,
    stageKey: null,
    sourceKey: null,
    errorMessage: null,
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("CrmValidationService", () => {
  let svc: CrmValidationService;
  let _dbSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new CrmValidationService(mockDb as never);
    jest.clearAllMocks();
  });

  function stubRules(rules: ReturnType<typeof makeRule>[]) {
    _dbSpy = jest
      .spyOn(mockDb, "orderBy")
      .mockResolvedValue(rules);
  }

  const ctx: ValidationContext = {};

  describe("required", () => {
    it("passes when value is present", async () => {
      stubRules([makeRule({ ruleType: "required", field: "name" })]);
      const result = await svc.evaluate("org1", "lead", { name: "Alice" }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when value is absent", async () => {
      stubRules([makeRule({ ruleType: "required", field: "name" })]);
      const result = await svc.evaluate("org1", "lead", {}, ctx);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.field).toBe("name");
      expect(result.errors[0]?.ruleType).toBe("required");
    });

    it("fails when value is empty string", async () => {
      stubRules([makeRule({ ruleType: "required", field: "name" })]);
      const result = await svc.evaluate("org1", "lead", { name: "" }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("email", () => {
    it("passes for valid email", async () => {
      stubRules([makeRule({ ruleType: "email", field: "email" })]);
      const result = await svc.evaluate("org1", "lead", { email: "user@example.com" }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails for invalid email", async () => {
      stubRules([makeRule({ ruleType: "email", field: "email" })]);
      const result = await svc.evaluate("org1", "lead", { email: "not-an-email" }, ctx);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.ruleType).toBe("email");
    });

    it("passes when value is absent (email is optional)", async () => {
      stubRules([makeRule({ ruleType: "email", field: "email" })]);
      const result = await svc.evaluate("org1", "lead", {}, ctx);
      expect(result.valid).toBe(true);
    });
  });

  describe("phone", () => {
    it("passes for valid phone", async () => {
      stubRules([makeRule({ ruleType: "phone", field: "phone" })]);
      const result = await svc.evaluate("org1", "lead", { phone: "+91-9876543210" }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails for too-short string", async () => {
      stubRules([makeRule({ ruleType: "phone", field: "phone" })]);
      const result = await svc.evaluate("org1", "lead", { phone: "123" }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("url", () => {
    it("passes for valid url", async () => {
      stubRules([makeRule({ ruleType: "url", field: "website" })]);
      const result = await svc.evaluate("org1", "lead", { website: "https://example.com" }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails for invalid url", async () => {
      stubRules([makeRule({ ruleType: "url", field: "website" })]);
      const result = await svc.evaluate("org1", "lead", { website: "not a url" }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("regex", () => {
    it("passes when value matches pattern", async () => {
      stubRules([makeRule({ ruleType: "regex", field: "code", config: { pattern: "^[A-Z]{3}$" } })]);
      const result = await svc.evaluate("org1", "lead", { code: "ABC" }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when value does not match", async () => {
      stubRules([makeRule({ ruleType: "regex", field: "code", config: { pattern: "^[A-Z]{3}$" } })]);
      const result = await svc.evaluate("org1", "lead", { code: "abc" }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("numeric_min", () => {
    it("passes when value >= min", async () => {
      stubRules([makeRule({ ruleType: "numeric_min", field: "score", config: { min: 0 } })]);
      const result = await svc.evaluate("org1", "lead", { score: 5 }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when value < min", async () => {
      stubRules([makeRule({ ruleType: "numeric_min", field: "score", config: { min: 10 } })]);
      const result = await svc.evaluate("org1", "lead", { score: 5 }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("numeric_max", () => {
    it("passes when value <= max", async () => {
      stubRules([makeRule({ ruleType: "numeric_max", field: "score", config: { max: 100 } })]);
      const result = await svc.evaluate("org1", "lead", { score: 80 }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when value > max", async () => {
      stubRules([makeRule({ ruleType: "numeric_max", field: "score", config: { max: 50 } })]);
      const result = await svc.evaluate("org1", "lead", { score: 80 }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("currency_min", () => {
    it("passes when amount >= min", async () => {
      stubRules([makeRule({ ruleType: "currency_min", field: "value", config: { min: 1000 } })]);
      const result = await svc.evaluate("org1", "lead", { value: 5000 }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when amount < min", async () => {
      stubRules([makeRule({ ruleType: "currency_min", field: "value", config: { min: 10000 } })]);
      const result = await svc.evaluate("org1", "lead", { value: 5000 }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("currency_max", () => {
    it("fails when amount > max", async () => {
      stubRules([makeRule({ ruleType: "currency_max", field: "value", config: { max: 50000 } })]);
      const result = await svc.evaluate("org1", "lead", { value: 100000 }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("date_not_past", () => {
    it("passes for a future date", async () => {
      stubRules([makeRule({ ruleType: "date_not_past", field: "followUpDate" })]);
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = await svc.evaluate("org1", "lead", { followUpDate: future }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails for a past date", async () => {
      stubRules([makeRule({ ruleType: "date_not_past", field: "followUpDate" })]);
      const past = new Date(Date.now() - 86400000).toISOString();
      const result = await svc.evaluate("org1", "lead", { followUpDate: past }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("date_not_future", () => {
    it("passes for a past date", async () => {
      stubRules([makeRule({ ruleType: "date_not_future", field: "signedAt" })]);
      const past = new Date(Date.now() - 86400000).toISOString();
      const result = await svc.evaluate("org1", "lead", { signedAt: past }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails for a future date", async () => {
      stubRules([makeRule({ ruleType: "date_not_future", field: "signedAt" })]);
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = await svc.evaluate("org1", "lead", { signedAt: future }, ctx);
      expect(result.valid).toBe(false);
    });
  });

  describe("unique", () => {
    it("passes when no duplicate found", async () => {
      stubRules([makeRule({ ruleType: "unique", field: "email", entityType: "lead" })]);
      jest.spyOn(mockDb, "then").mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([])));
      const result = await svc.evaluate("org1", "lead", { email: "unique@example.com" }, ctx);
      expect(result.valid).toBe(true);
    });
  });

  describe("conditional_required", () => {
    it("passes when condition is not met", async () => {
      stubRules([makeRule({ ruleType: "conditional_required", field: "company", config: { condField: "isB2B", condValue: true } })]);
      const result = await svc.evaluate("org1", "lead", { isB2B: false }, ctx);
      expect(result.valid).toBe(true);
    });

    it("fails when condition is met and field is absent", async () => {
      stubRules([makeRule({ ruleType: "conditional_required", field: "company", config: { condField: "isB2B", condValue: true } })]);
      const result = await svc.evaluate("org1", "lead", { isB2B: true }, ctx);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.ruleType).toBe("conditional_required");
    });

    it("passes when condition is met and field is present", async () => {
      stubRules([makeRule({ ruleType: "conditional_required", field: "company", config: { condField: "isB2B", condValue: true } })]);
      const result = await svc.evaluate("org1", "lead", { isB2B: true, company: "Acme" }, ctx);
      expect(result.valid).toBe(true);
    });
  });

  describe("stage_required", () => {
    it("fails when at the matching stage and field missing", async () => {
      stubRules([makeRule({ ruleType: "stage_required", field: "contactEmail", stageKey: "PROPOSAL" })]);
      const result = await svc.evaluate("org1", "lead", {}, { stageKey: "PROPOSAL" });
      expect(result.valid).toBe(false);
    });

    it("passes when at a different stage", async () => {
      stubRules([makeRule({ ruleType: "stage_required", field: "contactEmail", stageKey: "PROPOSAL" })]);
      const result = await svc.evaluate("org1", "lead", {}, { stageKey: "NEW" });
      expect(result.valid).toBe(true);
    });
  });

  describe("source_required", () => {
    it("fails when source matches and field missing", async () => {
      stubRules([makeRule({ ruleType: "source_required", field: "referredBy", sourceKey: "referral" })]);
      const result = await svc.evaluate("org1", "lead", {}, { sourceKey: "referral" });
      expect(result.valid).toBe(false);
    });

    it("passes when source does not match", async () => {
      stubRules([makeRule({ ruleType: "source_required", field: "referredBy", sourceKey: "referral" })]);
      const result = await svc.evaluate("org1", "lead", {}, { sourceKey: "website" });
      expect(result.valid).toBe(true);
    });
  });

  describe("multiple errors", () => {
    it("returns all failing rules", async () => {
      stubRules([
        makeRule({ ruleType: "required", field: "name" }),
        makeRule({ ruleType: "email", field: "email" }),
      ]);
      const result = await svc.evaluate("org1", "lead", { email: "bad" }, ctx);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe("custom error message", () => {
    it("returns the custom error message when set", async () => {
      stubRules([makeRule({ ruleType: "required", field: "name", errorMessage: "Name is mandatory" })]);
      const result = await svc.evaluate("org1", "lead", {}, ctx);
      expect(result.errors[0]?.message).toBe("Name is mandatory");
    });
  });
});
