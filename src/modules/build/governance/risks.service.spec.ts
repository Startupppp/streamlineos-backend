import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RisksService } from "./risks.service";
import { DecisionsService } from "./decisions.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

type MockDb = {
  query: {
    projects: { findFirst: jest.Mock };
    projectRisks: { findFirst: jest.Mock };
    projectDecisions: { findFirst: jest.Mock };
  };
  transaction: jest.Mock;
  update: jest.Mock;
  select: jest.Mock;
};

function makeMockDb(): MockDb {
  return {
    query: {
      projects: { findFirst: jest.fn() },
      projectRisks: { findFirst: jest.fn() },
      projectDecisions: { findFirst: jest.fn() },
    },
    transaction: jest.fn(),
    update: jest.fn(),
    select: jest.fn().mockReturnValue(makeSelectChain([{ role: "MEMBER" }])),
  };
}

function makeAccess(perms: Set<string> = new Set()): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

function makeUser(orgId: string, userId = "user-1"): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("RisksService.getRisk — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when risk belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);
    mockDb.query.projectRisks.findFirst.mockResolvedValue(undefined);

    await expect(svc.getRisk(makeUser("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns the risk when orgId and projectId match", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);
    const riskRow = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      riskNumber: 1,
      title: "DB failure",
      status: "open",
      probability: "medium",
      impact: "high",
      deletedAt: null,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.query.projectRisks.findFirst.mockResolvedValue(riskRow);

    const result = await svc.getRisk(makeUser("org-1"), 1, 1);
    expect(result).toEqual(riskRow);
  });
});

describe("RisksService.createRisk — riskNumber sequencing and createdBy", () => {
  it("assigns riskNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    let capturedValues: Record<string, unknown> | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 3 }]),
            }),
          }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedValues = vals;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 4,
                    riskNumber: vals["riskNumber"],
                    title: vals["title"],
                    orgId: vals["orgId"],
                    projectId: vals["projectId"],
                    createdBy: vals["createdBy"],
                    status: "open",
                    probability: "medium",
                    impact: "medium",
                    deletedAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    const result = await svc.createRisk(makeUser("org-1"), 1, { title: "Vendor delay risk" });
    expect(capturedValues?.["riskNumber"]).toBe(4);
    expect(capturedValues?.["createdBy"]).toBe("user-1");
    expect(result).toMatchObject({ riskNumber: 4, createdBy: "user-1" });
  });

  it("assigns riskNumber = 1 when no risks exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    let capturedRiskNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
            }),
          }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedRiskNumber = vals["riskNumber"] as number;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 1,
                    riskNumber: vals["riskNumber"],
                    title: vals["title"],
                    orgId: vals["orgId"],
                    projectId: vals["projectId"],
                    createdBy: vals["createdBy"],
                    status: "open",
                    probability: "medium",
                    impact: "medium",
                    deletedAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    await svc.createRisk(makeUser("org-1"), 1, { title: "First risk" });
    expect(capturedRiskNumber).toBe(1);
  });

  it("throws NotFoundException when project does not belong to the given orgId before inserting", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(
      svc.createRisk(makeUser("org-attacker"), 1, { title: "Hostile risk" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("RisksService — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");

  it("REJECTS a non-member with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listRisks(u, 1, {})).rejects.toThrow(ForbiddenException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("ALLOWS a direct project member", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listRisks(u, 1, {})).resolves.toEqual({ data: [], hasMore: false, nextCursor: null });
  });
});

describe("DecisionsService.getDecision — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when decision belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(undefined);

    await expect(svc.getDecision(makeUser("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });
});

describe("DecisionsService.createDecision — decisionNumber sequencing and createdBy", () => {
  it("assigns decisionNumber = maxExisting + 1 and sets createdBy to userId", async () => {
    const mockDb = makeMockDb();
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    let capturedValues: Record<string, unknown> | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 2 }]),
            }),
          }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedValues = vals;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 3,
                    decisionNumber: vals["decisionNumber"],
                    title: vals["title"],
                    orgId: vals["orgId"],
                    projectId: vals["projectId"],
                    createdBy: vals["createdBy"],
                    status: "proposed",
                    deletedAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    const result = await svc.createDecision(makeUser("org-1"), 1, {
      title: "Adopt microservices",
    });
    expect(capturedValues?.["decisionNumber"]).toBe(3);
    expect(capturedValues?.["createdBy"]).toBe("user-1");
    expect(result).toMatchObject({ decisionNumber: 3, createdBy: "user-1" });
  });
});

describe("DecisionsService — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");

  it("REJECTS a non-member with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listDecisions(u, 1, {})).rejects.toThrow(ForbiddenException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("ALLOWS a direct project member", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listDecisions(u, 1, {})).resolves.toEqual({ data: [], hasMore: false, nextCursor: null });
  });
});

describe("RisksService.getRisk — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const riskRow = {
    id: 1, orgId: "org-1", projectId: 1, riskNumber: 1, title: "DB failure",
    status: "open", probability: "medium", impact: "medium", description: null,
    ownerId: null, mitigation: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member reading a specific risk with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectRisks.findFirst.mockResolvedValue(riskRow);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.getRisk(u, 1, 1)).rejects.toThrow(ForbiddenException);
  });

  it("ALLOWS a direct project member to read a specific risk", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]));
    mockDb.query.projectRisks.findFirst.mockResolvedValue(riskRow);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.getRisk(u, 1, 1)).resolves.toEqual(riskRow);
  });
});

describe("RisksService.updateRisk — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const riskRow = {
    id: 1, orgId: "org-1", projectId: 1, riskNumber: 1, title: "DB failure",
    status: "open", probability: "medium", impact: "medium", description: null,
    ownerId: null, mitigation: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member updating a risk with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectRisks.findFirst.mockResolvedValue(riskRow);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.updateRisk(u, 1, 1, { title: "Updated" })).rejects.toThrow(ForbiddenException);
  });
});

describe("RisksService.softDeleteRisk — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const riskRow = {
    id: 1, orgId: "org-1", projectId: 1, riskNumber: 1, title: "DB failure",
    status: "open", probability: "medium", impact: "medium", description: null,
    ownerId: null, mitigation: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member soft-deleting a risk with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectRisks.findFirst.mockResolvedValue(riskRow);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.softDeleteRisk(u, 1, 1)).rejects.toThrow(ForbiddenException);
  });
});

describe("DecisionsService.getDecision — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const decisionRow = {
    id: 1, orgId: "org-1", projectId: 1, decisionNumber: 1, title: "Adopt PostgreSQL",
    context: null, decision: null, optionsConsidered: null, status: "proposed",
    ownerId: null, decidedAt: null, revisitAt: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member reading a specific decision with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(decisionRow);
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.getDecision(u, 1, 1)).rejects.toThrow(ForbiddenException);
  });

  it("ALLOWS a direct project member to read a specific decision", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]));
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(decisionRow);
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.getDecision(u, 1, 1)).resolves.toEqual(decisionRow);
  });
});

describe("DecisionsService.updateDecision — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const decisionRow = {
    id: 1, orgId: "org-1", projectId: 1, decisionNumber: 1, title: "Adopt PostgreSQL",
    context: null, decision: null, optionsConsidered: null, status: "proposed",
    ownerId: null, decidedAt: null, revisitAt: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member updating a decision with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(decisionRow);
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.updateDecision(u, 1, 1, { title: "Revised" })).rejects.toThrow(ForbiddenException);
  });
});

describe("DecisionsService.softDeleteDecision — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");
  const decisionRow = {
    id: 1, orgId: "org-1", projectId: 1, decisionNumber: 1, title: "Adopt PostgreSQL",
    context: null, decision: null, optionsConsidered: null, status: "proposed",
    ownerId: null, decidedAt: null, revisitAt: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };

  it("REJECTS a non-project-member soft-deleting a decision with ForbiddenException", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(decisionRow);
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.softDeleteDecision(u, 1, 1)).rejects.toThrow(ForbiddenException);
  });
});

function makeRiskRow(id: number): Record<string, unknown> {
  return {
    id, orgId: "org-1", projectId: 1, riskNumber: id, title: `Risk ${id}`,
    description: null, probability: "medium", impact: "medium", status: "open",
    ownerId: null, mitigation: null, linkedTicketId: null,
    deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
  };
}

function hasOwnPropStr<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
  return key in obj;
}

function collectParamValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    acc.push(node);
    return acc;
  }
  if (typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectParamValues(item, acc);
    return acc;
  }
  if (hasOwnPropStr(node, "encoder") && hasOwnPropStr(node, "value")) {
    acc.push(node.value);
    return acc;
  }
  if (hasOwnPropStr(node, "queryChunks")) {
    const qc = node.queryChunks;
    if (Array.isArray(qc)) {
      for (const chunk of qc) collectParamValues(chunk, acc);
    }
  }
  return acc;
}

describe("RisksService.listRisks — page 2 cursor returned by page 1 excludes all page-1 rows and no page-2 row is skipped", () => {
  const u = makeUser("org-1");

  it("page 2 starts exactly where page 1 ended — no repeated rows, no skipped rows when sentinel row is present", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    const page1DbRows = Array.from({ length: 101 }, (_, i) => makeRiskRow(105 - i));
    const page2DbRows = [makeRiskRow(5), makeRiskRow(4), makeRiskRow(3)];

    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain(page1DbRows))
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain(page2DbRows));

    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    const page1 = await svc.listRisks(u, 1, {});
    expect(page1.hasMore).toBe(true);
    expect(page1.data).toHaveLength(100);
    expect(page1.nextCursor).toBe(6);

    const page2 = await svc.listRisks(u, 1, { cursor: page1.nextCursor ?? undefined });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const page1Ids = new Set(page1.data.map((r) => r.id));
    expect(page2.data.every((r) => !page1Ids.has(r.id))).toBe(true);
    expect(page2.data.every((r) => r.id < (page1.nextCursor ?? 0))).toBe(true);
  });

  it("last page has hasMore=false and nextCursor=null when no sentinel row is returned", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([makeRiskRow(1)]));

    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);
    const page = await svc.listRisks(u, 1, { cursor: 3 });

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.data.map((r) => r.id)).toEqual([1]);
  });
});

describe("DecisionsService.listDecisions — page 2 cursor returned by page 1 excludes all page-1 rows and no page-2 row is skipped", () => {
  const u = makeUser("org-1");

  function makeDecisionRow(id: number): Record<string, unknown> {
    return {
      id, orgId: "org-1", projectId: 1, decisionNumber: id, title: `Decision ${id}`,
      context: null, decision: null, optionsConsidered: null, status: "proposed",
      ownerId: null, decidedAt: null, revisitAt: null, linkedTicketId: null,
      deletedAt: null, createdBy: "user-1", createdAt: new Date(), updatedAt: new Date(),
    };
  }

  it("page 2 starts exactly where page 1 ended — no repeated rows, no skipped rows when sentinel row is present", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });

    const page1DbRows = Array.from({ length: 101 }, (_, i) => makeDecisionRow(105 - i));
    const page2DbRows = [makeDecisionRow(5), makeDecisionRow(4), makeDecisionRow(3)];

    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain(page1DbRows))
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain(page2DbRows));

    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    const page1 = await svc.listDecisions(u, 1, {});
    expect(page1.hasMore).toBe(true);
    expect(page1.data).toHaveLength(100);
    expect(page1.nextCursor).toBe(6);

    const page2 = await svc.listDecisions(u, 1, { cursor: page1.nextCursor ?? undefined });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const page1Ids = new Set(page1.data.map((r) => r.id));
    expect(page2.data.every((r) => !page1Ids.has(r.id))).toBe(true);
    expect(page2.data.every((r) => r.id < (page1.nextCursor ?? 0))).toBe(true);
  });
});

describe("RisksService.listRisks — server-side full-text search predicate", () => {
  const u = makeUser("org-1");

  function setupMocks(mockDb: MockDb, riskChain: ReturnType<typeof makeSelectChain>) {
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(riskChain);
  }

  it("includes the search term as a WHERE param so the DB filters rather than the caller", async () => {
    const mockDb = makeMockDb();
    const riskChain = makeSelectChain([makeRiskRow(150)]);
    setupMocks(mockDb, riskChain);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    const result = await svc.listRisks(u, 1, { search: "vendor" });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe(150);
    const whereArg: unknown = riskChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).toContain("vendor");
  });

  it("does not include a search param for 'vendor' in WHERE when no search is provided", async () => {
    const mockDb = makeMockDb();
    const riskChain = makeSelectChain([]);
    setupMocks(mockDb, riskChain);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await svc.listRisks(u, 1, {});

    const whereArg: unknown = riskChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).not.toContain("vendor");
  });

  it("search term and cursor are both forwarded as WHERE params so the two predicates compose", async () => {
    const mockDb = makeMockDb();
    const riskChain = makeSelectChain([]);
    setupMocks(mockDb, riskChain);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await svc.listRisks(u, 1, { search: "vendor", cursor: 50 });

    const whereArg: unknown = riskChain.where.mock.calls[0]?.[0];
    const params = collectParamValues(whereArg);
    expect(params).toContain("vendor");
    expect(params).toContain(50);
  });

  it("orgId is always in WHERE alongside the search term so another tenant's matching risk is excluded", async () => {
    const mockDb = makeMockDb();
    const riskChain = makeSelectChain([]);
    setupMocks(mockDb, riskChain);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await svc.listRisks(u, 1, { search: "supply chain" });

    const whereArg: unknown = riskChain.where.mock.calls[0]?.[0];
    const params = collectParamValues(whereArg);
    expect(params).toContain("supply chain");
    expect(params).toContain("org-1");
  });

  it("keeps orgId and projectId in WHERE beside the search term, which is the only reason the measured cost of search is a heap filter over one project's rows: a GIN index on the searched expression is never chosen under RLS because ts_match_vq is not leakproof and so cannot be evaluated before the tenant qual (BE-80)", async () => {
    const mockDb = makeMockDb();
    const riskChain = makeSelectChain([]);
    setupMocks(mockDb, riskChain);
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await svc.listRisks(u, 4242, { search: "vendor" });

    const whereArg: unknown = riskChain.where.mock.calls[0]?.[0];
    const params = collectParamValues(whereArg);
    expect(params).toContain("vendor");
    expect(params).toContain("org-1");
    expect(params).toContain(4242);
  });
});

describe("RisksService.getRiskStats — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");

  it("REJECTS a non-member before running either aggregate, so the size of another project's risk register never leaks", async () => {
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.getRiskStats(u, 1)).rejects.toThrow(ForbiddenException);
  });
});
