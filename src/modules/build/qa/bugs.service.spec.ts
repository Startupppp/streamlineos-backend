import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { BugsService } from "./bugs.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeU(orgId: string, isOrgOwner = false, membershipId = 42): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, isOrgOwner),
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
      limit: jest.fn().mockResolvedValue(rows),
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

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("BugsService.listBugs — tenant scoping", () => {
  it("throws NotFoundException when project does not exist for the given orgId (BOLA guard)", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);
    mockDb.query.projects.findFirst.mockResolvedValue(null);

    await expect(svc.listBugs(makeU("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });

  it("queries the project via query.projects.findFirst with the caller orgId", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);
    mockDb.query.projects.findFirst.mockResolvedValue(null);

    await expect(svc.listBugs(makeU("org-1"), 99, {})).rejects.toThrow(NotFoundException);
    expect(mockDb.query.projects.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("BugsService.listBugs — project membership gate", () => {
  it("rejects a non-member (isOrgOwner=false, no build:manage, no membership row)", async () => {
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const teamInnerJoin = jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    });
    const mockDb = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin: teamInnerJoin }) }),
    } as unknown as Db;
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);

    await expect(svc.listBugs(makeU("org-1", false), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a project member (direct membership row present)", async () => {
    const memberRow = [{ role: "MEMBER" }];
    const bugsRows: unknown[] = [];
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberRow) }),
    });
    const mockDb = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(bugsRows) }),
            }),
          }),
        }),
    } as unknown as Db;
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);

    const result = await svc.listBugs(makeU("org-1", false), 1, {});
    expect(result).toEqual([]);
  });
});

describe("BugsService.createBug — bugNumber sequencing", () => {
  it("assigns bugNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);

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
                    reporterId: "user-1",
                    createdBy: "user-1",
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

    const result = await svc.createBug(makeU("org-1", true), 1, { title: "Test Bug" });
    expect(capturedBugNumber).toBe(6);
    expect(result).toMatchObject({ bugNumber: 6 });
  });

  it("assigns bugNumber = 1 when no bugs exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);

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
                    reporterId: "user-1",
                    createdBy: "user-1",
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

    await svc.createBug(makeU("org-1", true), 1, { title: "First Bug" });
    expect(capturedBugNumber).toBe(1);
  });

  it("throws NotFoundException when project is not found for the given orgId before inserting", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);
    mockDb.query.projects.findFirst.mockResolvedValue(null);

    await expect(
      svc.createBug(makeU("org-attacker"), 1, { title: "Injection attempt" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("BugsService.getBug — cross-tenant isolation", () => {
  it("throws NotFoundException when bug belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit, mockAccess);
    mockDb.query.bugs.findFirst.mockResolvedValue(undefined);

    await expect(svc.getBug("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });
});
