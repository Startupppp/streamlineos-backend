/**
 * Tenant isolation specs for CRM AI services that touch the DB.
 *
 * Services under test:
 *   src/modules/ai/core/services/crm-content.service.ts
 *   src/modules/ai/core/services/crm-copilot.service.ts
 *   src/modules/ai/core/services/crm-pipeline.service.ts
 */

export {};

const OWNER_ORG = "org-owner-abc";
const ATTACKER_ORG = "org-attacker-xyz";
const USER_ID = "user-111";

jest.mock("../../../../common/tenant/run-in-tenant-transaction");

describe("CrmContentService — cross-tenant isolation", () => {
  let runInTenantTransaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runInTenantTransaction = jest.requireMock(
      "../../../../common/tenant/run-in-tenant-transaction",
    ).runInTenantTransaction;
  });

  it("generateEmail: runInTenantTransaction is called with the caller's orgId, not a leaked value (cross-tenant isolation)", async () => {
    const { CrmContentService } = await import("./crm-content.service");
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { subject: "Follow up", body: "Hello", tone: "formal", callToAction: "" },
      }),
    };
    const mockDb = {} as never;
    const svc = new CrmContentService(mockDb, gateway as never);

    runInTenantTransaction.mockImplementation(
      async (_db: unknown, cb: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        cb({ select: () => ({ from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([]) }) }) }) }),
    );

    await svc.generateEmail(USER_ID, { leadName: "Alice", tone: "formal" }, { orgId: OWNER_ORG, userId: USER_ID });
    await svc.generateEmail(USER_ID, { leadName: "Bob", tone: "formal" }, { orgId: ATTACKER_ORG, userId: USER_ID });

    const calls = runInTenantTransaction.mock.calls as Array<[unknown, unknown, { orgId: string }]>;
    expect(calls[0]![2]!.orgId).toBe(OWNER_ORG);
    expect(calls[1]![2]!.orgId).toBe(ATTACKER_ORG);
    expect(calls[0]![2]!.orgId).not.toBe(ATTACKER_ORG);
    expect(calls[1]![2]!.orgId).not.toBe(OWNER_ORG);
  });
});

describe("CrmCopilotService — cross-tenant isolation", () => {
  let runInTenantTransaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runInTenantTransaction = jest.requireMock(
      "../../../../common/tenant/run-in-tenant-transaction",
    ).runInTenantTransaction;
  });

  function makeTxChain(rows: unknown[]) {
    const chain = {
      then: (
        resolve: ((value: unknown) => unknown) | null | undefined,
        reject?: ((reason: unknown) => unknown) | null | undefined,
      ) => Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined),
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    } as Record<string, unknown>;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(rows);
    return chain;
  }

  it("dealSummary: DENY — cross-tenant deal query returns null → NotFoundException", async () => {
    const { CrmCopilotService } = await import("./crm-copilot.service");

    runInTenantTransaction.mockImplementation(
      async (_db: unknown, cb: (tx: unknown) => Promise<unknown>, _opts: unknown) => {
        const emptyChain = makeTxChain([]);
        const select = () => ({
          from: () => ({
            where: () => emptyChain,
            innerJoin: () => ({ where: () => emptyChain }),
          }),
          distinct: () => ({ from: () => ({ where: () => emptyChain }) }),
        });
        return cb({ select, insert: () => ({ values: () => Promise.resolve() }) });
      },
    );

    const orgFeatures = { getFlags: jest.fn().mockResolvedValue({ aiLeadScoring: true }) };
    const gateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    const mockDb = {} as never;
    const svc = new CrmCopilotService(
      mockDb,
      gateway as never,
      orgFeatures as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(svc.dealSummary(ATTACKER_ORG, 999, USER_ID)).rejects.toMatchObject({
      message: "Deal not found",
    });
    expect(gateway.invokeStructured).not.toHaveBeenCalled();

    const calls = runInTenantTransaction.mock.calls as Array<[unknown, unknown, { orgId: string }]>;
    expect(calls[0]![2]!.orgId).toBe(ATTACKER_ORG);
  });

  it("dealSummary: CONTROL — own org deal is found and summarized", async () => {
    const { CrmCopilotService } = await import("./crm-copilot.service");

    const dealRow = {
      id: 1,
      name: "Big Deal",
      value: "100000",
      stage: "NEGOTIATION",
      probability: 70,
      contactPerson: "Alice",
      expectedCloseDate: null,
      notes: "Important client",
    };

    runInTenantTransaction.mockImplementation(
      async (_db: unknown, cb: (tx: unknown) => Promise<unknown>, _opts: unknown) => {
        let callCount = 0;
        const select = () => {
          callCount++;
          const callIdx = callCount;
          const makeChain = (rows: unknown[]) => ({
            then: (
              resolve: ((v: unknown) => unknown) | null | undefined,
              reject?: ((r: unknown) => unknown) | null | undefined,
            ) => Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined),
            orderBy: () => makeChain(rows),
            limit: () => Promise.resolve(rows),
          });
          return {
            from: () => ({
              where: () => (callIdx === 1 ? makeChain([dealRow]) : makeChain([])),
              innerJoin: () => ({ where: () => makeChain([]) }),
            }),
          };
        };
        return cb({ select, insert: () => ({ values: () => Promise.resolve() }) });
      },
    );

    const orgFeatures = { getFlags: jest.fn().mockResolvedValue({ aiLeadScoring: true }) };
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { summary: "Deal looks good.", risks: [], recommendedPlays: [], stakeholdersGap: "None" },
      }),
    };
    const mockDb = {} as never;
    const svc = new CrmCopilotService(
      mockDb,
      gateway as never,
      orgFeatures as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await svc.dealSummary(OWNER_ORG, 1, USER_ID);

    expect(result.stage).toBe("NEGOTIATION");
    expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    const calls = runInTenantTransaction.mock.calls as Array<[unknown, unknown, { orgId: string }]>;
    expect(calls[0]![2]!.orgId).toBe(OWNER_ORG);
  });
});

describe("CrmPipelineService — cross-tenant isolation", () => {
  beforeEach(() => jest.resetAllMocks());

  function makePipelineChain(rows: unknown[]) {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      groupBy: () => chain,
      orderBy: () => chain,
      then: (
        resolve: ((v: unknown) => unknown) | null | undefined,
        reject?: ((r: unknown) => unknown) | null | undefined,
      ) => Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined),
    } as Record<string, unknown>;
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    return chain;
  }

  it("stalePipelineDigest: DENY — cross-tenant query returns empty deals (different-org isolation)", async () => {
    const { CrmPipelineService } = await import("./crm-pipeline.service");

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makePipelineChain([{ total: 0 }]);
        return makePipelineChain([]);
      }),
    };
    const orgFeatures = { getFlags: jest.fn().mockResolvedValue({ aiLeadScoring: true }) };
    const gateway = {
      invokeStructured: jest.fn(),
    };
    const svc = new CrmPipelineService(mockDb as never, gateway as never, orgFeatures as never, {} as never);

    const result = await svc.stalePipelineDigest(ATTACKER_ORG, USER_ID);
    expect(result).toBeDefined();
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("stalePipelineDigest: CONTROL — own org deals returned and summarized", async () => {
    const { CrmPipelineService } = await import("./crm-pipeline.service");

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleDeals = [
      { id: 1, name: "Deal A", stage: "PROPOSAL", value: "5000", assignedToId: null, updatedAt: oldDate },
      { id: 2, name: "Deal B", stage: "NEGOTIATION", value: "8000", assignedToId: null, updatedAt: oldDate },
    ];

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makePipelineChain([{ total: 2 }]);
        if (selectCallCount === 2) return makePipelineChain(staleDeals);
        return makePipelineChain([]);
      }),
    };
    const orgFeatures = { getFlags: jest.fn().mockResolvedValue({ aiLeadScoring: true }) };
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { summary: "2 stale deals need attention.", riskLevel: "medium", topRisks: [], recommendations: [] },
      }),
    };
    const svc = new CrmPipelineService(mockDb as never, gateway as never, orgFeatures as never, {} as never);

    const result = await svc.stalePipelineDigest(OWNER_ORG, USER_ID);
    expect(result).toBeDefined();
    expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    const callArg = gateway.invokeStructured.mock.calls[0][0] as { actor: { orgId: string } };
    expect(callArg.actor.orgId).toBe(OWNER_ORG);
  });
});
