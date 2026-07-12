import { CrmRulesService } from "../crm-rules.service";

function mockRule(overrides: Record<string, unknown>) {
  return {
    id: 1,
    orgId: "org1",
    name: "Test Rule",
    conditions: [],
    assignmentType: "round_robin" as const,
    assignToUserId: null,
    roundRobinUserIds: ["user-a", "user-b"],
    priority: 10,
    isActive: true,
    config: {},
    assignmentTypeText: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDbWithRules(rules: unknown[], leadCounts: Record<string, number> = {}) {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rules),
          }),
        }),
        groupBy: jest.fn().mockResolvedValue(
          Object.entries(leadCounts).map(([assignedToId, cnt]) => ({ assignedToId, cnt }))
        ),
      }),
    })),
  };
}

const mockCacheService = { cached: jest.fn(), invalidatePattern: jest.fn() };
const mockTerritoryMatch = { match: jest.fn().mockResolvedValue(null) };

describe("CrmRulesService.preview", () => {
  it("round_robin: rule matches → returns first candidate", async () => {
    const rules = [mockRule({ assignmentType: "round_robin", roundRobinUserIds: ["user-a", "user-b"] })];
    const db = makeDbWithRules(rules);
    const service = new CrmRulesService(db as never, mockCacheService as never, mockTerritoryMatch as never);

    const result = await service.preview("org1", { source: "web" });

    expect(result.matchedRule).not.toBeNull();
    expect(result.wouldAssignTo).toBe("user-a");
    expect(result.trace[0]?.matched).toBe(true);
  });

  it("weighted_round_robin: rule matches → picks from weighted list", async () => {
    const rules = [
      mockRule({
        assignmentType: "round_robin",
        assignmentTypeText: "weighted_round_robin",
        config: { weights: { "user-a": 1, "user-b": 99 } },
      }),
    ];
    const db = makeDbWithRules(rules);
    const service = new CrmRulesService(db as never, mockCacheService as never, mockTerritoryMatch as never);

    const result = await service.preview("org1", { source: "web" });

    expect(result.matchedRule?.id).toBe(1);
    expect(["user-a", "user-b"]).toContain(result.wouldAssignTo);
  });

  it("least_loaded: picks user with fewer open leads", async () => {
    const rules = [
      mockRule({
        assignmentTypeText: "least_loaded",
        roundRobinUserIds: ["user-a", "user-b"],
        config: { leastLoadedWindowDays: 7 },
      }),
    ];
    const db = makeDbWithRules(rules, { "user-a": 5, "user-b": 1 });
    const service = new CrmRulesService(db as never, mockCacheService as never, mockTerritoryMatch as never);

    const result = await service.preview("org1", { source: "web" });

    expect(result.matchedRule).not.toBeNull();
    expect(["user-a", "user-b"]).toContain(result.wouldAssignTo);
  });

  it("no rule matches → matchedRule null, trace has failed entries", async () => {
    const rules = [
      mockRule({
        conditions: [{ field: "source", operator: "eq", value: "email" }],
        roundRobinUserIds: ["user-x"],
      }),
    ];
    const db = makeDbWithRules(rules);
    const service = new CrmRulesService(db as never, mockCacheService as never, mockTerritoryMatch as never);

    const result = await service.preview("org1", { source: "web" });

    expect(result.matchedRule).toBeNull();
    expect(result.wouldAssignTo).toBeNull();
    expect(result.trace[0]?.matched).toBe(false);
  });
});
