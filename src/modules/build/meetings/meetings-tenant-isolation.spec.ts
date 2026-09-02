import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MeetingsService } from "./meetings.service";

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, isOrgOwner),
  };
}

describe("MeetingsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;
  const mockAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  beforeEach(() => jest.resetAllMocks());

  function makeDb(meetingRow: unknown | null) {
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(meetingRow), findMany: jest.fn().mockResolvedValue([]) },
      },
      select,
    } as unknown as Db;
  }

  it("throws NotFoundException when meeting belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new MeetingsService(db, audit, mockAccess);
    await expect(svc.getMeeting(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns meeting for the owning org (same-tenant control)", async () => {
    const meeting = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Standup" };
    const db = makeDb(meeting);
    const svc = new MeetingsService(db, audit, mockAccess);
    const result = await svc.getMeeting(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("MeetingsService — project membership gate for listMeetings", () => {
  const audit = { log: jest.fn() } as never;
  const mockAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  beforeEach(() => jest.resetAllMocks());

  it("rejects a non-member for listMeetings (isOrgOwner=false, no build:manage, no membership row)", async () => {
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const teamInnerJoin = jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    });
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin: teamInnerJoin }) }),
    } as unknown as Db;
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
    const svc = new MeetingsService(db, audit, mockAccess);

    await expect(svc.listMeetings(makeU("org-1", false), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member to list meetings", async () => {
    const memberRow = [{ role: "MEMBER" }];
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberRow) }),
    });
    const meetingChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValue(meetingChain),
    } as unknown as Db;
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
    const svc = new MeetingsService(db, audit, mockAccess);

    const result = await svc.listMeetings(makeU("org-1", false), 1, {});
    expect(result).toEqual([]);
  });
});
