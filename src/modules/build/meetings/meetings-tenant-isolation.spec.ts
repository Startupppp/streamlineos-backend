import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import { MeetingsService } from "./meetings.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

describe("MeetingsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const MEMBERSHIP_ID = 7;

  const audit = { log: jest.fn() } as never;

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-7",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
    };
  }

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

  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin2 = jest.fn().mockReturnValue({ where });
    const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2, where });
    const from = jest.fn().mockReturnValue({ innerJoin: innerJoin1, where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) },
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select,
    } as unknown as Db;
  }

  function makeAccess() {
    return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
  }

  function makeNoAccessAccess() {
    return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as unknown as AccessService;
  }

  it("throws NotFoundException when meeting belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new MeetingsService(db, makeAccess(), audit);
    await expect(svc.getMeeting(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns meeting for the owning org (same-tenant control)", async () => {
    const meeting = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Standup" };
    const db = makeDb(meeting);
    const svc = new MeetingsService(db, makeAccess(), audit);
    const result = await svc.getMeeting(makeU(OWNER_ORG), 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });

  it("throws ForbiddenException when caller is not a project member (source ACL)", async () => {
    const db = makeNonMemberDb();
    const svc = new MeetingsService(db, makeNoAccessAccess(), audit);
    await expect(svc.getMeeting(makeU(OWNER_ORG), 1, 1)).rejects.toThrow(ForbiddenException);
  });
});
