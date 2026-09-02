import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RisksService } from "./risks.service";
import { DecisionsService } from "./decisions.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
    select: jest.fn(),
  };
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 100, isOrgOwner: false },
    ...overrides,
  };
}

function makeSelectChain(resolved: unknown[]) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(resolved),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccessNoPerms = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
} as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("RisksService.getRisk — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when risk belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);
    mockDb.query.projectRisks.findFirst.mockResolvedValue(undefined);

    await expect(svc.getRisk("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns the risk when orgId and projectId match", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);
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

    const result = await svc.getRisk("org-1", 1, 1);
    expect(result).toEqual(riskRow);
  });
});

describe("RisksService.createRisk — riskNumber sequencing and createdBy", () => {
  it("assigns riskNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);

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

    const result = await svc.createRisk(
      makeUser({ isOrgOwner: true, orgId: "org-1", userId: "user-1" }),
      1,
      { title: "Vendor delay risk" },
    );
    expect(capturedValues?.["riskNumber"]).toBe(4);
    expect(capturedValues?.["createdBy"]).toBe("user-1");
    expect(result).toMatchObject({ riskNumber: 4, createdBy: "user-1" });
  });

  it("assigns riskNumber = 1 when no risks exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);

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

    await svc.createRisk(
      makeUser({ isOrgOwner: true, orgId: "org-1", userId: "user-1" }),
      1,
      { title: "First risk" },
    );
    expect(capturedRiskNumber).toBe(1);
  });

  it("throws NotFoundException when project does not exist in org before inserting", async () => {
    const mockDb = makeMockDb();
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccess);
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(
      svc.createRisk(makeUser({ isOrgOwner: false, orgId: "org-attacker" }), 1, { title: "Hostile risk" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("RisksService — assertProjectAccess gate BITES", () => {
  it("rejects a non-member caller with ForbiddenException", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue(project);
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));

    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccess);
    await expect(
      svc.listRisks(makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }), 1, {}),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("allows a direct project member to list risks", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue(project);
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]));

    const svc = new RisksService(mockDb as unknown as Db, mockAudit, mockAccess);
    const result = await svc.listRisks(
      makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }),
      1,
      {},
    );
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("DecisionsService.getDecision — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when decision belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new DecisionsService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);
    mockDb.query.projectDecisions.findFirst.mockResolvedValue(undefined);

    await expect(svc.getDecision("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });
});

describe("DecisionsService.createDecision — decisionNumber sequencing and createdBy", () => {
  it("assigns decisionNumber = maxExisting + 1 and sets createdBy to userId", async () => {
    const mockDb = makeMockDb();
    const svc = new DecisionsService(mockDb as unknown as Db, mockAudit, mockAccessNoPerms);

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

    const result = await svc.createDecision(
      makeUser({ isOrgOwner: true, orgId: "org-1", userId: "user-1" }),
      1,
      { title: "Adopt microservices" },
    );
    expect(capturedValues?.["decisionNumber"]).toBe(3);
    expect(capturedValues?.["createdBy"]).toBe("user-1");
    expect(result).toMatchObject({ decisionNumber: 3, createdBy: "user-1" });
  });
});

describe("DecisionsService — assertProjectAccess gate BITES", () => {
  it("rejects a non-member caller with ForbiddenException", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue(project);
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));

    const svc = new DecisionsService(mockDb as unknown as Db, mockAudit, mockAccess);
    await expect(
      svc.listDecisions(makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }), 1, {}),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("allows a direct project member to list decisions", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = makeMockDb();
    mockDb.query.projects.findFirst.mockResolvedValue(project);
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]));

    const svc = new DecisionsService(mockDb as unknown as Db, mockAudit, mockAccess);
    const result = await svc.listDecisions(
      makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }),
      1,
      {},
    );
    expect(Array.isArray(result)).toBe(true);
  });
});
