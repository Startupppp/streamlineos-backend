jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { NotFoundException } from "@nestjs/common";
import { CrmBriefService } from "./crm-brief.service";
import { CrmScoringService } from "./crm-scoring.service";
import { CrmTasksService } from "./crm-tasks.service";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function okResult<T>(data: T) {
  return {
    ok: true as const,
    data,
    model: "test-model",
    latencyMs: 10,
    correlationId: "corr-1",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

/** Thenable chain for multi-join selects that are awaited directly (no `.limit`). */
function buildThenableChain(resolved: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {
    from: jest.fn().mockImplementation(() => chain),
    innerJoin: jest.fn().mockImplementation(() => chain),
    leftJoin: jest.fn().mockImplementation(() => chain),
    where: jest.fn().mockImplementation(() => chain),
    orderBy: jest.fn().mockImplementation(() => chain),
    limit: jest.fn().mockImplementation(() => promise),
  };
  Object.assign(chain, {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise.then(res, rej),
    catch: (rej: (e: unknown) => unknown) => promise.catch(rej),
    finally: (cb: () => void) => promise.finally(cb),
  });
  return chain;
}

// ---------------------------------------------------------------------------
// CrmBriefService
// ---------------------------------------------------------------------------

describe("CrmBriefService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: accountSummary throws NotFoundException when account not found for ATTACKER_ORG", async () => {
    const findFirstMock = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { clientAccounts: { findFirst: findFirstMock } },
      select: jest.fn(),
    };
    const gateway = { invokeText: jest.fn(), invokeStructured: jest.fn() };

    const service = new CrmBriefService(db as never, gateway as never, {} as never, {} as never);

    await expect(service.accountSummary(ATTACKER_ORG, { clientId: 1 })).rejects.toThrow(NotFoundException);

    const callArg = findFirstMock.mock.calls[0]?.[0] as { where: unknown } | undefined;
    const values = sqlValues(callArg?.where);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    expect(gateway.invokeText).not.toHaveBeenCalled();
  });

  it("CONTROL: accountSummary returns summary for OWNER_ORG", async () => {
    const account = {
      id: 1,
      orgId: OWNER_ORG,
      clientName: "Acme Corp",
      clientEmail: null,
      clientPhone: null,
      status: "active",
      planName: null,
      investmentAmount: null,
      estimatedInvestment: null,
      investmentDate: null,
      renewalStage: "none",
      renewalDate: null,
      conversionNotes: null,
      renewalNotes: null,
      createdAt: new Date("2024-01-01"),
      leadId: null,
    };
    const findFirstMock = jest.fn().mockResolvedValue(account);
    const db = {
      query: { clientAccounts: { findFirst: findFirstMock } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    };
    const gateway = {
      invokeText: jest.fn().mockResolvedValue(okResult("Account summary text")),
      invokeStructured: jest.fn(),
    };

    const service = new CrmBriefService(db as never, gateway as never, {} as never, {} as never);
    const result = await service.accountSummary(OWNER_ORG, { clientId: 1 });

    expect(result).toMatchObject({ summary: "Account summary text", clientName: "Acme Corp" });
    expect(typeof result.generatedAt).toBe("string");
    expect(gateway.invokeText).toHaveBeenCalledTimes(1);
    expect(gateway.invokeText).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "crm.account-summary", actor: { orgId: OWNER_ORG, userId: null } }),
    );
  });
});

// ---------------------------------------------------------------------------
// CrmScoringService
// ---------------------------------------------------------------------------

describe("CrmScoringService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: scoreLead returns null when no lead found for ATTACKER_ORG, gateway not called", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => buildThenableChain([])),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const gateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn(), invalidateNamespace: jest.fn() };

    const service = new CrmScoringService(db as never, gateway as never, cache as never);
    const result = await service.scoreLead(ATTACKER_ORG, 99);

    expect(result).toBeNull();
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("CONTROL: scoreLead returns score for OWNER_ORG", async () => {
    const leadRow = {
      id: 42,
      name: "John Doe",
      email: "john@example.com",
      phone: null,
      company: "ACME",
      designation: null,
      city: "Mumbai",
      source: "website",
      priority: "HOT",
      potentialValue: "500000",
      investmentInterest: null,
      notes: null,
      tags: null,
      createdAt: new Date(),
      assignedToId: null,
    };
    const scoreData = {
      score: 75,
      confidence: "high" as const,
      reasoning: "Strong profile",
      strengths: ["has email"],
      weaknesses: [],
      suggestedActions: ["follow up"],
    };

    // Select call order:
    //  0 — lead (from leadPartyMap, Promise.all branch 1)
    //  1 — activity count (from leadActivities, Promise.all branch 2)
    //  2 — partyIdsForLeads inside db.transaction (leadPartyMap)
    //  3 — adoptLead inside db.transaction (leads table, returns empty → adoptLead returns null)
    const queryResults: unknown[][] = [[leadRow], [{ count: 3 }], [], []];
    let callIdx = 0;
    const db = {
      select: jest.fn().mockImplementation(() => buildThenableChain(queryResults[callIdx++] ?? [])),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue(okResult(scoreData)),
      invokeText: jest.fn(),
    };
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn(), invalidateNamespace: jest.fn() };

    const service = new CrmScoringService(db as never, gateway as never, cache as never);
    const result = await service.scoreLead(OWNER_ORG, 42);

    expect(result).toMatchObject({ score: 75, reasoning: "Strong profile" });
    expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    expect(gateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "crm.score-lead", actor: { orgId: OWNER_ORG, userId: null } }),
    );
  });
});

// ---------------------------------------------------------------------------
// CrmTasksService
// ---------------------------------------------------------------------------

describe("CrmTasksService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: prioritizeTasks returns empty result when no tasks for ATTACKER_ORG, gateway not called", async () => {
    const whereMock = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };
    const gateway = { invokeStructured: jest.fn() };

    const service = new CrmTasksService(db as never, gateway as never);
    const result = await service.prioritizeTasks(ATTACKER_ORG, "user-1");

    expect(result).toEqual({ items: [], summary: "No pending tasks to prioritize." });
    expect(gateway.invokeStructured).not.toHaveBeenCalled();

    const predicate = whereMock.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
  });

  it("CONTROL: prioritizeTasks calls gateway when tasks exist for OWNER_ORG", async () => {
    const taskRow = {
      id: 1,
      title: "Call client",
      type: "CALL",
      notes: null,
      dueDate: null,
      entityType: "CUSTOM",
      entityId: null,
    };
    const priorityData = {
      items: [{ taskId: 1, rank: 1, urgencyScore: 80, reasoning: "Only pending task" }],
      summary: "Focus on the call.",
    };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([taskRow]) }),
        }),
      }),
    };
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue(okResult(priorityData)),
    };

    const service = new CrmTasksService(db as never, gateway as never);
    const result = await service.prioritizeTasks(OWNER_ORG, "user-1");

    expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    expect(gateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "crm.prioritize-tasks",
        actor: { orgId: OWNER_ORG, userId: "user-1" },
      }),
    );
    expect(result).toMatchObject(priorityData);
  });
});
