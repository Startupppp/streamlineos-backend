import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { BugsService } from "./bugs.service";
import { BuildTicketCreationService } from "../core/tickets";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeBugsTicketCreation() {
  return {
    createInTransaction: jest.fn(async (tx: Record<string, unknown>, command: Record<string, unknown>) => {
      const rows = await (tx["select"] as jest.Mock)({}).from({}).where({}) as Array<{ maxNum?: number }>;
      const ticketNumber = (rows[0]?.maxNum ?? 0) + 1;
      const drafts = command["drafts"] as Record<string, unknown>[];
      const draft = drafts[0] ?? {};
      const inserted = await (tx["insert"] as jest.Mock)({})
        .values({ ...draft, ticketNumber })
        .returning() as Record<string, unknown>[];
      return { tickets: inserted, command };
    }),
    publish: jest.fn(),
  } as unknown as BuildTicketCreationService;
}

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
    tickets: { findFirst: jest.Mock };
    workItemQaDetails: { findFirst: jest.Mock };
    projects: { findFirst: jest.Mock };
    organizationMembers: { findFirst: jest.Mock };
  };
  select: jest.Mock;
  transaction: jest.Mock;
  update: jest.Mock;
};

function makeSelectChain(rows: unknown[]) {
  const limitChain = { limit: jest.fn().mockResolvedValue(rows) };
  const orderByChain = { orderBy: jest.fn().mockReturnValue(limitChain) };
  const whereChain = { where: jest.fn().mockReturnValue(orderByChain) };
  const leftJoinChain = { leftJoin: jest.fn().mockReturnValue(whereChain) };
  const fromChain = { from: jest.fn().mockReturnValue(leftJoinChain) };
  return jest.fn().mockReturnValue(fromChain);
}

function makeMockDb(): MockDb {
  return {
    query: {
      tickets: { findFirst: jest.fn() },
      workItemQaDetails: { findFirst: jest.fn() },
      projects: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  };
}

function makeUpdateChain(returning: unknown[]) {
  return jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returning),
      }),
    }),
  });
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
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(svc.listBugs(makeU("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });

  it("asserts the project lookup is performed to enforce tenant scope", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(svc.listBugs(makeU("org-1"), 99, {})).rejects.toThrow(NotFoundException);
    expect(mockDb.query.projects.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("BugsService.createBug — ticketNumber sequencing", () => {
  it("assigns ticketNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });

    let capturedTicketNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
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
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 1) {
                capturedTicketNumber = vals["ticketNumber"] as number;
                return {
                  returning: jest.fn().mockResolvedValue([
                    {
                      id: 10,
                      ticketNumber: vals["ticketNumber"],
                      title: "Test Bug",
                      orgId: "org-1",
                      projectId: 1,
                      type: "BUG",
                      status: "TODO",
                      priority: "MEDIUM",
                      assigneeMembershipId: null,
                      reporterId: "user-7",
                      deletedAt: null,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    },
                  ]),
                };
              }
              return Promise.resolve();
            }),
          })),
        };
        return cb(txMock);
      },
    );

    const result = await svc.createBug(makeU("org-1"), 1, { title: "Test Bug" });
    expect(capturedTicketNumber).toBe(6);
    expect(result).toMatchObject({ ticketNumber: 6 });
  });

  it("assigns ticketNumber = 1 when no tickets exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());

    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });

    let capturedTicketNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
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
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 1) {
                capturedTicketNumber = vals["ticketNumber"] as number;
                return {
                  returning: jest.fn().mockResolvedValue([
                    {
                      id: 1,
                      ticketNumber: vals["ticketNumber"],
                      title: "First Bug",
                      orgId: "org-1",
                      projectId: 1,
                      type: "BUG",
                      status: "TODO",
                      priority: "MEDIUM",
                      assigneeMembershipId: null,
                      reporterId: "user-7",
                      deletedAt: null,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    },
                  ]),
                };
              }
              return Promise.resolve();
            }),
          })),
        };
        return cb(txMock);
      },
    );

    await svc.createBug(makeU("org-1"), 1, { title: "First Bug" });
    expect(capturedTicketNumber).toBe(1);
  });

  it("throws NotFoundException when project is not found for the given orgId before inserting", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(
      svc.createBug(makeU("org-attacker"), 1, { title: "Injection attempt" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("BugsService.getBug — cross-tenant isolation", () => {
  it("throws NotFoundException when the caller's org has no project matching the id (cross-tenant isolation)", async () => {
    const mockDb = makeMockDb();
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue(undefined);

    await expect(svc.getBug(makeU("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the ticket+sidecar join finds no row for the given org and project", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    });

    await expect(svc.getBug(makeU("org-1"), 1, 99)).rejects.toThrow(NotFoundException);
  });
});

describe("BugsService.updateBug — assignee resolution", () => {
  it("resolves input.assigneeId to assigneeMembershipId before updating the tickets row", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1, status: "new" });
    mockDb.query.workItemQaDetails.findFirst.mockResolvedValue({ qaState: "new", reopenCount: 0 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 42 });

    const capturedSet: Record<string, unknown>[] = [];
    mockDb.update = jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
        capturedSet.push(setObj);
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, status: "new" }]),
          }),
        };
      }),
    });

    await svc.updateBug(makeU("org-1"), 1, 1, { assigneeId: "user-42" });
    expect(capturedSet[0]).toMatchObject({ assigneeMembershipId: 42 });
    expect(capturedSet[0]).not.toHaveProperty("assigneeId");
  });

  it("sets assigneeMembershipId to null when the userId is not an active project member", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1, status: "new" });
    mockDb.query.workItemQaDetails.findFirst.mockResolvedValue({ qaState: "new", reopenCount: 0 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(undefined);

    const capturedSet: Record<string, unknown>[] = [];
    mockDb.update = jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((setObj: Record<string, unknown>) => {
        capturedSet.push(setObj);
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, status: "new" }]),
          }),
        };
      }),
    });

    await svc.updateBug(makeU("org-1"), 1, 1, { assigneeId: "user-unknown" });
    expect(capturedSet[0]).toMatchObject({ assigneeMembershipId: null });
  });
});

describe("BugsService.updateBug — soft-delete TOCTOU guard", () => {
  it("throws NotFoundException when the tickets row is concurrently soft-deleted before the UPDATE completes", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1, status: "new" });
    mockDb.query.workItemQaDetails.findFirst.mockResolvedValue({ qaState: "new", reopenCount: 0 });
    mockDb.update = makeUpdateChain([]);

    await expect(svc.updateBug(makeU("org-1"), 1, 1, { title: "updated" })).rejects.toThrow(
      NotFoundException,
    );
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
        tickets: { findFirst: jest.fn() },
        workItemQaDetails: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn() },
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
    const ticketsChain = {
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        tickets: { findFirst: jest.fn() },
        workItemQaDetails: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return makeLimitChain([{ role: "MEMBER" }]);
        if (callCount === 2) return makeLimitChain([]);
        return ticketsChain;
      }),
      transaction: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation());
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation());
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).resolves.toEqual([]);
  });

  it("getBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation());
    await expect(svc.getBug(makeU("org-1"), 1, 1)).rejects.toThrow(ForbiddenException);
  });

  it("updateBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation());
    await expect(svc.updateBug(makeU("org-1"), 1, 1, { title: "x" })).rejects.toThrow(ForbiddenException);
  });

  it("deleteBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation());
    await expect(svc.deleteBug(makeU("org-1"), 1, 1)).rejects.toThrow(ForbiddenException);
  });
});
