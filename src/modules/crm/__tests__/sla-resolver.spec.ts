import { SlaResolverService } from "../sla-resolver.service";
import { checkAndRecordSlaBreach } from "../lead-triggers";

function makePolicyRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: "Default Policy",
    conditions: {},
    targetMinutes: 60,
    firstResponseHours: 1,
    businessHours: false,
    appliesToText: null,
    priorityText: null,
    ...overrides,
  };
}

function makeDbWithPolicies(policies: unknown[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(policies),
        }),
      }),
    }),
  };
}

describe("SlaResolverService.resolve", () => {
  it("matches when lead source is in sourceKeys", async () => {
    const db = makeDbWithPolicies([makePolicyRow({ conditions: { sourceKeys: ["web", "referral"] } })]);
    const service = new SlaResolverService(db as never);

    const result = await service.resolve("org1", { source: "web", appliesTo: "lead" });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(1);
  });

  it("does not match when source not in sourceKeys", async () => {
    const db = makeDbWithPolicies([makePolicyRow({ conditions: { sourceKeys: ["web"] } })]);
    const service = new SlaResolverService(db as never);

    const result = await service.resolve("org1", { source: "cold_call", appliesTo: "lead" });

    expect(result).toBeNull();
  });

  it("score range: matches when score is in [scoreMin, scoreMax]", async () => {
    const db = makeDbWithPolicies([makePolicyRow({ conditions: { scoreMin: 50, scoreMax: 100 } })]);
    const service = new SlaResolverService(db as never);

    const result = await service.resolve("org1", { score: 75, appliesTo: "lead" });
    expect(result).not.toBeNull();

    const db2 = makeDbWithPolicies([makePolicyRow({ conditions: { scoreMin: 50, scoreMax: 100 } })]);
    const service2 = new SlaResolverService(db2 as never);
    const result2 = await service2.resolve("org1", { score: 30, appliesTo: "lead" });
    expect(result2).toBeNull();
  });

  it("most specific wins: two matching policies, one has more conditions", async () => {
    const policies = [
      makePolicyRow({ id: 1, conditions: { sourceKeys: ["web"] } }),
      makePolicyRow({ id: 2, conditions: { sourceKeys: ["web"], scoreMin: 0 } }),
    ];
    const db = makeDbWithPolicies(policies);
    const service = new SlaResolverService(db as never);

    const result = await service.resolve("org1", { source: "web", score: 50, appliesTo: "lead" });

    expect(result?.id).toBe(2);
  });

  it("empty conditions: policy with no conditions matches everything with score 0", async () => {
    const db = makeDbWithPolicies([makePolicyRow({ conditions: {} })]);
    const service = new SlaResolverService(db as never);

    const result = await service.resolve("org1", { appliesTo: "lead" });
    expect(result).not.toBeNull();
  });
});

describe("checkAndRecordSlaBreach idempotency", () => {
  it("second call for same lead+policy returns recorded=false", async () => {
    let existingRows: unknown[] = [];
    const insertedValues: unknown[] = [];

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(() => Promise.resolve(existingRows)),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((vals) => {
          insertedValues.push(vals);
          existingRows = [{ id: 1 }];
          return Promise.resolve([]);
        }),
      }),
    };

    const first = await checkAndRecordSlaBreach(db as never, "org1", 42, 5);
    expect(first.recorded).toBe(true);

    const second = await checkAndRecordSlaBreach(db as never, "org1", 42, 5);
    expect(second.recorded).toBe(false);

    expect(insertedValues.length).toBe(1);
  });
});
