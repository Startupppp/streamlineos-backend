import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { BugsService } from "./bugs.service";
import { BuildTicketCreationService, ProjectsTicketsDeleteService, ProjectsTicketsUpdateService, TicketVersionConflictException } from "../core/tickets";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
} from "../core/project-crud/__tests__/project-access-doubles";

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

function makeBugsTicketChange() {
  return {
    updateTicket: jest.fn().mockResolvedValue({ updated: true, updatedAt: new Date().toISOString(), version: 2 }),
  } as unknown as ProjectsTicketsUpdateService;
}

function makeBugsTicketDelete() {
  return {
    deleteTicket: jest.fn().mockResolvedValue({ deleted: true }),
  } as unknown as ProjectsTicketsDeleteService;
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

function projectAccessChain(lookup: jest.Mock) {
  return {
    from: () => ({ where: () => ({ limit: async () => ((await lookup()) ? [projectAccessRow()] : []) }) }),
  };
}

function makeMockDb(): MockDb {
  const projectLookup = jest.fn();
  return {
    query: {
      tickets: { findFirst: jest.fn() },
      workItemQaDetails: { findFirst: jest.fn() },
      projects: { findFirst: projectLookup },
      organizationMembers: { findFirst: jest.fn() },
    },
    select: jest.fn((projection?: object) =>
      projection !== undefined && "manages" in projection ? projectAccessChain(projectLookup) : undefined,
    ),
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
  return standingAccess({ "build:manage": "all" }) as unknown as AccessService;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("BugsService.listBugs — tenant scoping", () => {
  it("throws NotFoundException when project does not exist for the given orgId (BOLA guard)", async () => {
    const mockDb = makeMockDb();
    const mockAccess = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

    await expect(svc.listBugs(makeU("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });

  it("asserts the project lookup is performed to enforce tenant scope", async () => {
    const mockDb = makeMockDb();
    const mockAccess = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

    await expect(svc.listBugs(makeU("org-1"), 99, {})).rejects.toThrow(NotFoundException);
    expect(mockDb.select).toHaveBeenCalledWith(expect.objectContaining({ manages: expect.anything() }));
  });
});

describe("BugsService.createBug — ticketNumber sequencing", () => {
  it("assigns ticketNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

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
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

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
    const mockAccess = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

    await expect(
      svc.createBug(makeU("org-attacker"), 1, { title: "Injection attempt" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("BugsService.getBug — cross-tenant isolation", () => {
  it("throws NotFoundException when the caller's org has no project matching the id (cross-tenant isolation)", async () => {
    const mockDb = makeMockDb();
    const mockAccess = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());

    await expect(svc.getBug(makeU("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the ticket+sidecar join finds no row for the given org and project", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.select = jest.fn().mockReturnValueOnce(projectAccessChain(mockDb.query.projects.findFirst)).mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    });

    await expect(svc.getBug(makeU("org-1"), 1, 99)).rejects.toThrow(NotFoundException);
  });
});

describe("BugsService.updateBug — canonical mutation path", () => {
  it("routes ticket fields through canonical updateTicket — does not call db.update(tickets) directly", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const ticketChange = makeBugsTicketChange();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), ticketChange, makeBugsTicketDelete());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst
      .mockResolvedValueOnce({ id: 1, version: 2 })
      .mockResolvedValueOnce(null);
    mockDb.query.workItemQaDetails.findFirst.mockResolvedValue({ qaState: "new", reopenCount: 0 });
    mockDb.update = makeUpdateChain([{ qaState: "new", reopenCount: 0 }]);
    mockDb.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: 1, title: "updated", orgId: "org-1", projectId: 1, ticketNumber: 1, description: null, type: "BUG", status: "TODO", priority: "MEDIUM", assigneeMembershipId: null, reporterId: "user-7", deletedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 3 }]),
        }),
      }),
    });

    await svc.updateBug(makeU("org-1"), 1, 1, { title: "updated" });

    expect((ticketChange.updateTicket as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((ticketChange.updateTicket as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      1,
      1,
      expect.objectContaining({ title: "updated" }),
    );
  });

  it("propagates TicketVersionConflictException from updateTicket to the caller", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const ticketChange = makeBugsTicketChange();
    (ticketChange.updateTicket as jest.Mock).mockRejectedValue(new TicketVersionConflictException(3));
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), ticketChange, makeBugsTicketDelete());
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1, version: 2 });
    mockDb.query.workItemQaDetails.findFirst.mockResolvedValue({ qaState: "new", reopenCount: 0 });

    await expect(
      svc.updateBug(makeU("org-1"), 1, 1, { title: "updated" }),
    ).rejects.toThrow(TicketVersionConflictException);
  });
});

describe("BugsService — project membership gate (assertProjectAccess)", () => {
  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([projectAccessRow()]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
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
        tickets: { findFirst: jest.fn() },
        workItemQaDetails: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return makeLimitChain([projectAccessRow({ memberRole: "MEMBER" })]);
        return ticketsChain;
      }),
      transaction: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    const u = makeU("org-1");
    await expect(svc.listBugs(u, 1, {})).resolves.toEqual([]);
  });

  it("getBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    await expect(svc.getBug(makeU("org-1"), 1, 1)).rejects.toThrow(ForbiddenException);
  });

  it("updateBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    await expect(svc.updateBug(makeU("org-1"), 1, 1, { title: "x" })).rejects.toThrow(ForbiddenException);
  });

  it("deleteBug rejects a non-member of the project with ForbiddenException (BOLA gate)", async () => {
    const db = makeNonMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new BugsService(db, access, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), makeBugsTicketDelete());
    await expect(svc.deleteBug(makeU("org-1"), 1, 1)).rejects.toThrow(ForbiddenException);
  });
});

describe("BugsService.deleteBug — canonical delete path", () => {
  it("routes deleteBug through canonical deleteTicket — does not call db.update(tickets) directly", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const ticketDelete = makeBugsTicketDelete();
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), ticketDelete);
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1 });

    const result = await svc.deleteBug(makeU("org-1"), 1, 1);

    expect((ticketDelete.deleteTicket as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((ticketDelete.deleteTicket as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      1,
      1,
      false,
    );
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("propagates NotFoundException from deleteTicket to the caller", async () => {
    const mockDb = makeMockDb();
    const mockAccess = makeAccessGranted();
    const ticketDelete = makeBugsTicketDelete();
    (ticketDelete.deleteTicket as jest.Mock).mockRejectedValue(new NotFoundException("Ticket not found"));
    const svc = new BugsService(mockDb as unknown as Db, mockAccess, mockAudit, makeBugsTicketCreation(), makeBugsTicketChange(), ticketDelete);
    mockDb.query.projects.findFirst.mockResolvedValue({ managerMembershipId: null });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 1 });

    await expect(svc.deleteBug(makeU("org-1"), 1, 1)).rejects.toThrow(NotFoundException);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
