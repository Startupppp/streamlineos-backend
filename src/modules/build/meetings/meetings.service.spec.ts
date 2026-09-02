import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MeetingsService } from "./meetings.service";
import { ActionItemsService } from "./action-items.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, isOrgOwner),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
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

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
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

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
    const result = await svc.addAttendee("org-1", "actor-1", 1, 2, { userId: "member-user" });
    expect(result).toEqual({ meetingId: 2, userId: "member-user" });
  });

  it("throws NotFoundException when the meeting itself is not found", async () => {
    const mockDb = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
    await expect(
      svc.addAttendee("org-1", "actor-1", 1, 999, { userId: "user-x" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("MeetingsService.listMeetings — bounded reads", () => {
  it("rejects overflow instead of silently truncating the meeting list", async () => {
    const overflow = Array.from({ length: 101 }, (_, id) => ({ id: id + 1 }));
    const meetingQuery = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(overflow),
    };
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      select: jest.fn().mockReturnValue(meetingQuery),
    } as unknown as Db;

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
    await expect(svc.listMeetings(makeU("org-1", true), 1, {})).rejects.toThrow(BadRequestException);
    expect(meetingQuery.limit).toHaveBeenCalledWith(101);
  });
});

describe("MeetingsService.listMeetings — project membership gate", () => {
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
    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);

    await expect(svc.listMeetings(makeU("org-1", false), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member to list meetings", async () => {
    const memberRow = [{ role: "MEMBER" }];
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberRow) }),
    });
    const meetingListChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const mockDb = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValue(meetingListChain),
    } as unknown as Db;
    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);

    const result = await svc.listMeetings(makeU("org-1", false), 1, {});
    expect(result).toEqual([]);
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

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
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

    const svc = new MeetingsService(mockDb, mockAudit, mockAccess);
    await expect(
      svc.upsertStandup("org-1", "caller-1", 1, 999, { today: "work" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ActionItemsService.convertToTask", () => {
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
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit);
    await expect(svc.convertToTask("org-1", "user-1", 1, 2, 1)).rejects.toThrow(ConflictException);
  });

  it("creates a ticket and returns { actionItem, ticketId } when the item is not yet converted", async () => {
    const tx = makeTx({ convertedTicketId: null });
    const mockDb = {
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit);
    const result = await svc.convertToTask("org-1", "user-1", 1, 2, 1);

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
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit);
    await expect(svc.convertToTask("org-1", "user-1", 1, 2, 999)).rejects.toThrow(NotFoundException);
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
      transaction: jest.fn().mockImplementation(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;

    const svc = new ActionItemsService(mockDb, mockAudit);
    await expect(svc.convertToTask("org-1", "user-1", 1, 999, 1)).rejects.toThrow(NotFoundException);
  });
});
