import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { BugsService } from "./bugs.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const MEMBERSHIP_ID = 7;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, isOrgOwner),
  };
}

type MockDb = {
  query: {
    bugs: { findFirst: jest.Mock };
    projects: { findFirst: jest.Mock };
  };
  select: jest.Mock;
  transaction: jest.Mock;
  update: jest.Mock;
};

function makeSelectChain(rows: unknown[]) {
  const whereChain = {
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
  const fromChain = { from: jest.fn().mockReturnValue(whereChain) };
  return jest.fn().mockReturnValue(fromChain);
}

function makeMockDb(): MockDb {
  return {
    query: {
      bugs: { findFirst: jest.fn() },
      projects: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  };
}

function makeAccessGranted() {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  } as unknown as AccessService;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("BugsService.listBugs — tenant scoping", () => {
  it("throws NotFoundException when project does not exist for the given orgId (BOLA guard)", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(svc.listBugs(makeU("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });

  it("asserts the project lookup is performed to enforce tenant scope", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(svc.listBugs(makeU("org-1"), 99, {})).rejects.toThrow(NotFoundException);
    expect(mockDb.query.projects.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("BugsService.createBug — bugNumber sequencing", () => {
  it("assigns bugNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });

    let capturedBugNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 5 }]),
            }),
          }),
          query: {
            organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
          },
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: { bugNumber?: number }) => {
              capturedBugNumber = vals.bugNumber;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 10,
                    bugNumber: vals.bugNumber,
                    title: "Test Bug",
                    orgId: "org-1",
                    projectId: 1,
                    status: "new",
                    severity: "major",
                    priority: "medium",
                    reporterId: "user-7",
                    createdBy: "user-7",
                    deletedAt: null,
                    reopenCount: 0,
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    const result = await svc.createBug(makeU("org-1"), 1, { title: "Test Bug" });
    expect(capturedBugNumber).toBe(6);
    expect(result).toMatchObject({ bugNumber: 6 });
  });

  it("assigns bugNumber = 1 when no bugs exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });

    let capturedBugNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
            }),
          }),
          query: {
            organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
          },
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: { bugNumber?: number }) => {
              capturedBugNumber = vals.bugNumber;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 1,
                    bugNumber: vals.bugNumber,
                    title: "First Bug",
                    orgId: "org-1",
                    projectId: 1,
                    status: "new",
                    severity: "major",
                    priority: "medium",
                    reporterId: "user-7",
                    createdBy: "user-7",
                    deletedAt: null,
                    reopenCount: 0,
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    await svc.createBug(makeU("org-1"), 1, { title: "First Bug" });
    expect(capturedBugNumber).toBe(1);
  });

  it("throws NotFoundException when project is not found for the given orgId before inserting", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(
      svc.createBug(makeU("org-attacker"), 1, { title: "Injection attempt" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("BugsService.getBug — cross-tenant isolation", () => {
  it("throws NotFoundException when bug belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit);
    mockDb.query.bugs.findFirst.mockResolvedValue(undefined);

    await expect(svc.getBug("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });
});

describe("BugsService — project membership gate (assertProjectAccess)", () => {
  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        bugs: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
      transaction: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;
  }

  function makeMemberDb() {
    let callCount = 0;
    const makeLimitChain = (rows: unknown[]) => {
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
      return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
    };
    const bugsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        bugs: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? makeLimitChain([{ role: "MEMBER" }]) : bugsChain;
      }),
      transaction: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit);
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit);
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).resolves.toEqual([]);
  });
});
