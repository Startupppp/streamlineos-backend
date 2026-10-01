import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MeetingsService } from "./meetings.service";
import { ActionItemsService } from "./action-items.service";
import { BuildTicketCreationService } from "../core/tickets";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import { MEMBER_STANDING, principalAccess, projectAccessRow, standingAccess } from "../core/project-crud/__tests__/project-access-doubles";

function makeActionItemsTicketCreation() {
  return {
    createInTransaction: jest.fn(async (tx: Record<string, unknown>, command: Record<string, unknown>) => {
      const drafts = command["drafts"] as Record<string, unknown>[];
      const draft = drafts[0] ?? {};
      const inserted = await (tx["insert"] as jest.Mock)({}).values(draft).returning() as Record<string, unknown>[];
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

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("MeetingsService.addAttendee — member validation", () => {
  it("throws BadRequestException when the target user is not a project member", async () => {
    const memberChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: 2, orgId: "org-1", projectId: 1 }) },
      },
      select: jest.fn().mockReturnValue(memberChain),
    } as unknown as Db;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    await expect(
      svc.addAttendee("org-1", "actor-1", 1, 2, { userId: "non-member" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("returns meetingId + userId when the user is a project member", async () => {
    const insertChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    };
    const memberChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 7 }]),
    };
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: 2, orgId: "org-1", projectId: 1 }) },
      },
      select: jest.fn().mockReturnValue(memberChain),
      insert: jest.fn().mockReturnValue(insertChain),
    } as unknown as Db;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    const result = await svc.addAttendee("org-1", "actor-1", 1, 2, { userId: "member-user" });
    expect(result).toEqual({ meetingId: 2, userId: "member-user" });
  });

  it("throws NotFoundException when the meeting itself is not found", async () => {
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    await expect(
      svc.addAttendee("org-1", "actor-1", 1, 999, { userId: "user-x" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("MeetingsService.listMeetings — cursor pagination", () => {
  it("returns hasMore:true and a nextCursor when the page is full and more rows exist", async () => {
    const overflow = Array.from({ length: 26 }, (_, i) => ({
      id: i + 1,
      orgId: "org-1",
      scheduledAt: new Date(Date.UTC(2026, 0, 26 - i)),
    }));
    const meetingQuery = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockResolvedValue([]),
      limit: jest.fn().mockResolvedValue(overflow),
    };
    const projectRow = { from: () => projectRow, where: () => projectRow, limit: async () => [projectAccessRow()] };
    const mockDb = {
      select: jest.fn().mockReturnValueOnce(projectRow).mockReturnValue(meetingQuery),
    } as unknown as Db;
    const mockAccess = standingAccess({ "build:manage": "all" }) as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    const result = await svc.listMeetings(makeU("org-1"), 1, { limit: 25 });
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toBeTruthy();
    expect(result.data).toHaveLength(25);
    expect(meetingQuery.limit).toHaveBeenCalledWith(26);
  });
});

describe("MeetingsService.upsertStandup — caller-scoped write", () => {
  it("writes the standup entry for the authenticated caller's userId, not a body-supplied user", async () => {
    const insertReturning = jest.fn().mockResolvedValue([{ id: 1, meetingId: 2, userId: "caller-1" }]);
    const insertOnConflict = jest.fn().mockReturnValue({ returning: insertReturning });
    const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate: insertOnConflict });
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) },
      },
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    await svc.upsertStandup("org-1", "caller-1", 1, 2, {
      yesterday: "reviewed PRs",
      today: "writing tests",
      blockers: undefined,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "caller-1", meetingId: 2 }),
    );
  });

  it("throws NotFoundException when meeting not found", async () => {
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;

    const svc = new MeetingsService(mockDb, mockAccess, mockAudit);
    await expect(
      svc.upsertStandup("org-1", "caller-1", 1, 999, { today: "work" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ActionItemsService.convertToTask", () => {
  function ticketCreator(): AccessService {
    return stubService<AccessService>({ holds: jest.fn().mockResolvedValue(true), scopeFor: principalAccess(MEMBER_STANDING).scopeFor });
  }

  function projectRowSelect() {
    return jest.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) }));
  }

  function visibleProject() {
    return { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } };
  }

  function makeTx(itemOverrides: Record<string, unknown> = {}) {
    const item = {
      id: 1,
      orgId: "org-1",
      meetingId: 2,
      projectId: 1,
      title: "Write migration script",
      description: null,
      assigneeId: null,
      dueDate: null,
      convertedTicketId: null,
      status: "open",
      deletedAt: null,
      ...itemOverrides,
    };

    return {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) },
        meetingActionItems: { findFirst: jest.fn().mockResolvedValue(item) },
      },
      execute: jest.fn().mockResolvedValue([{ start: 1 }]),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 100, title: item.title }]),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([
          { id: 1, status: "converted", convertedTicketId: 100 },
        ]),
      }),
    };
  }

  it("throws ConflictException when the action item is already converted (convertedTicketId set)", async () => {
    const tx = makeTx({ convertedTicketId: 42 });
    const mockDb = {
      query: visibleProject(),
      select: projectRowSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit, makeActionItemsTicketCreation(), ticketCreator());
    await expect(svc.convertToTask(makeU("org-1", true), 1, 2, 1)).rejects.toThrow(ConflictException);
  });

  it("creates a ticket and returns { actionItem, ticketId } when the item is not yet converted", async () => {
    const tx = makeTx({ convertedTicketId: null });
    const mockDb = {
      query: visibleProject(),
      select: projectRowSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit, makeActionItemsTicketCreation(), ticketCreator());
    const result = await svc.convertToTask(makeU("org-1", true), 1, 2, 1);

    expect(result).toMatchObject({ actionItem: expect.anything(), ticketId: 100 });
    expect((result as { actionItem: { status: string } }).actionItem.status).toBe("converted");
    expect(tx.insert).toHaveBeenCalled();
  });

  it("throws NotFoundException when the action item itself is not found", async () => {
    const tx = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) },
        meetingActionItems: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      execute: jest.fn(),
    };
    const mockDb = {
      query: visibleProject(),
      select: projectRowSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit, makeActionItemsTicketCreation(), ticketCreator());
    await expect(svc.convertToTask(makeU("org-1", true), 1, 2, 999)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the meeting is not found in the transaction", async () => {
    const tx = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(undefined) },
        meetingActionItems: { findFirst: jest.fn() },
      },
      execute: jest.fn(),
    };
    const mockDb = {
      query: visibleProject(),
      select: projectRowSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit, makeActionItemsTicketCreation(), ticketCreator());
    await expect(svc.convertToTask(makeU("org-1", true), 1, 999, 1)).rejects.toThrow(NotFoundException);
  });

  it("throws ConflictException when UPDATE WHERE converted_ticket_id IS NULL returns 0 rows (concurrent conversion race)", async () => {
    const baseTx = makeTx({ convertedTicketId: null });
    const tx = {
      ...baseTx,
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([]),
      }),
    };
    const mockDb = {
      query: visibleProject(),
      select: projectRowSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit, makeActionItemsTicketCreation(), ticketCreator());
    await expect(svc.convertToTask(makeU("org-1", true), 1, 2, 1)).rejects.toThrow(ConflictException);
  });
});

describe("MeetingsService.listMeetings — server-side full-text search predicate", () => {
  const u = makeU("org-1");

  function makeChain(rows: unknown[]) {
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

  function makeMeetingsMockDb() {
    return {
      select: jest.fn().mockReturnValue(makeChain([])),
    };
  }

  function makeSearchAccessService(): AccessService {
    return standingAccess(MEMBER_STANDING) as unknown as AccessService;
  }

  function setupSearchMocks(
    mockDb: ReturnType<typeof makeMeetingsMockDb>,
    meetingChain: ReturnType<typeof makeChain>,
  ) {
    mockDb.select
      .mockReturnValueOnce(makeChain([projectAccessRow({ memberRole: "MEMBER" })]))
      .mockReturnValueOnce(meetingChain);
  }

  it("includes the search term as a WHERE param so the DB filters rather than the caller", async () => {
    const mockDb = makeMeetingsMockDb();
    const meetingChain = makeChain([]);
    setupSearchMocks(mockDb, meetingChain);
    const svc = new MeetingsService(mockDb as unknown as Db, makeSearchAccessService(), mockAudit);

    await svc.listMeetings(u, 1, { limit: 25, q: "standup-keyword" });

    const whereArg: unknown = meetingChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).toContain("standup-keyword");
  });

  it("does not include a search param for 'standup-keyword' in WHERE when no search is provided", async () => {
    const mockDb = makeMeetingsMockDb();
    const meetingChain = makeChain([]);
    setupSearchMocks(mockDb, meetingChain);
    const svc = new MeetingsService(mockDb as unknown as Db, makeSearchAccessService(), mockAudit);

    await svc.listMeetings(u, 1, { limit: 25 });

    const whereArg: unknown = meetingChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).not.toContain("standup-keyword");
  });

  it("keeps orgId and projectId in WHERE beside the search term, which is the only reason the measured cost of search is a heap filter over one project's rows: a GIN index on the title expression is never chosen under RLS because ts_match_vq is not leakproof and so cannot be evaluated before the tenant qual (BE-80)", async () => {
    const mockDb = makeMeetingsMockDb();
    const meetingChain = makeChain([]);
    setupSearchMocks(mockDb, meetingChain);
    const svc = new MeetingsService(mockDb as unknown as Db, makeSearchAccessService(), mockAudit);

    await svc.listMeetings(u, 4242, { limit: 25, q: "quarterly-review" });

    const whereArg: unknown = meetingChain.where.mock.calls[0]?.[0];
    const params = collectParamValues(whereArg);
    expect(params).toContain("quarterly-review");
    expect(params).toContain("org-1");
    expect(params).toContain(4242);
  });
});

describe("MeetingsService.getMeeting — attendees carry userId from the membership join", () => {
  const MEETING = {
    id: 3, orgId: "org-1", projectId: 1, meetingNumber: 1,
    title: "Sprint Planning", type: "meeting" as const, status: "scheduled" as const,
    agenda: null, notes: null, scheduledAt: null, endAt: null,
    durationMinutes: null, timezone: null, recurrenceRule: null,
    cycleId: null, createdBy: "user-1",
    createdAt: new Date("2026-09-01T10:00:00Z"),
    updatedAt: new Date("2026-09-01T10:00:00Z"),
    deletedAt: null,
  };
  const ATTENDEE_BASE = { id: 1, orgId: "org-1", meetingId: 3, membershipId: 5, attended: false, createdAt: new Date("2026-09-01T10:00:00Z") };

  function makeGetMeetingDb() {
    let selectCall = 0;
    function makeSimpleChain(rows: unknown[]) {
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
            }),
          }),
        }),
      };
    }
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(MEETING) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return makeSimpleChain([projectAccessRow({ memberRole: "MEMBER" })]);
        if (selectCall === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([ATTENDEE_BASE]) }),
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ ...ATTENDEE_BASE, userId: "user-42" }]) }),
              }),
            }),
          };
        }
        return makeSimpleChain([]);
      }),
    };
  }

  it("includes userId on each attendee so the display layer can match names without a second fetch", async () => {
    const db = makeGetMeetingDb();
    const access = principalAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new MeetingsService(db as unknown as Db, access, mockAudit);
    const result = await svc.getMeeting(makeU("org-1"), 1, 3);
    expect(result.attendees[0]).toHaveProperty("userId", "user-42");
  });

  it("returns exactly the attendees in the meeting, no extras from the join", async () => {
    const db = makeGetMeetingDb();
    const access = principalAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new MeetingsService(db as unknown as Db, access, mockAudit);
    const result = await svc.getMeeting(makeU("org-1"), 1, 3);
    expect(result.attendees).toHaveLength(1);
    expect(result.attendees[0]).toHaveProperty("userId", "user-42");
  });
});

describe("MeetingsService — project membership gate (assertProjectAccess)", () => {
  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([projectAccessRow()]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projectMeetings: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
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
    const meetingsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projectMeetings: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return makeLimitChain([projectAccessRow({ memberRole: "MEMBER" })]);
        return meetingsChain;
      }),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new MeetingsService(db, access, mockAudit);
    await expect(svc.listMeetings(makeU("org-1"), 1, { limit: 25 })).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = standingAccess(MEMBER_STANDING) as unknown as AccessService;
    const svc = new MeetingsService(db, access, mockAudit);
    await expect(svc.listMeetings(makeU("org-1"), 1, { limit: 25 })).resolves.toMatchObject({
      data: [],
      pagination: { hasMore: false, nextCursor: null },
    });
  });
});
