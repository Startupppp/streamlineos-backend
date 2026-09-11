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
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new RisksService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listRisks(u, 1, {})).resolves.toEqual([]);
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
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new DecisionsService(mockDb as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listDecisions(u, 1, {})).resolves.toEqual([]);
  });
});
