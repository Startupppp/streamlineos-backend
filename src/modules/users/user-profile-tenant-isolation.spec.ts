import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { SessionsService } from "../sessions/sessions.service";
import type { EmploymentFactsService } from "../directory/employment-facts.service";
import type { ReportingRelationshipService } from "../directory/reporting-relationship.service";
import type { UserActivityService } from "./user-activity.service";
import { UserProfileService } from "./user-profile.service";

describe("UserProfileService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";
  const USER_ID = "user-abc";

  function makeDb(memberRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(memberRow);
    return {
      query: {
        organizationMembers: { findFirst },
        userPreferences: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    } as unknown as Db;
  }

  function makeService(memberRow: unknown): UserProfileService {
    const cache: Partial<CacheService> = {};
    const sessions: Partial<SessionsService> = {};
    const employment: Partial<EmploymentFactsService> = {};
    const activity: Partial<UserActivityService> = {};
    return new UserProfileService(
      makeDb(memberRow),
      cache as CacheService,
      sessions as SessionsService,
      employment as EmploymentFactsService,
      activity as UserActivityService,
      {} as ReportingRelationshipService,
    );
  }

  it("throws NotFoundException when user is not a member of the requesting org (cross-tenant isolation)", async () => {
    const svc = makeService(null);
    await expect(svc.getUserSessions(ATTACKER_ORG, USER_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns sessions for the owning org (control — same-tenant)", async () => {
    const svc = makeService({ userId: USER_ID });
    await expect(svc.getUserSessions(OWNER_ORG, USER_ID)).resolves.toEqual([]);
  });

  describe("updatePreferences — empty-patch guard", () => {
    it("returns success without querying userPreferences when no fields are provided (bites if reverted: empty set would throw)", async () => {
      const memberFindFirst = jest.fn().mockResolvedValue({ userId: USER_ID });
      const prefsFindFirst = jest.fn();
      const updateSet = jest.fn();
      const db = {
        query: {
          organizationMembers: { findFirst: memberFindFirst },
          userPreferences: { findFirst: prefsFindFirst },
        },
        update: jest.fn().mockReturnValue({ set: updateSet }),
      } as unknown as Db;

      const cache: Partial<CacheService> = {};
      const svc = new UserProfileService(
        db,
        cache as CacheService,
        {} as SessionsService,
        {} as EmploymentFactsService,
        {} as UserActivityService,
        {} as ReportingRelationshipService,
      );

      const result = await svc.updatePreferences(OWNER_ORG, USER_ID, {});

      expect(result).toEqual({ success: true });
      expect(prefsFindFirst).not.toHaveBeenCalled();
      expect(updateSet).not.toHaveBeenCalled();
    });
  });
});

/**
 * The account records a person has regardless of org — sessions, sign-in
 * history, preferences — live in tables keyed by `user_id` alone, with no
 * `org_id` column. The membership probe run first in each path is therefore the
 * ONLY thing keeping one tenant's admin out of another tenant's member's
 * account. Until these cases, only `getUserSessions` above exercised it:
 * deleting the probe from any of the five paths below left the users and
 * sessions suites green — including `revokeAllSessions`, which would then force
 * a sign-out on a user in an org the caller does not belong to.
 *
 * Each case asserts the table was never touched, not just that the call threw,
 * because the mock would throw on the unscoped path too, only later.
 */
describe("UserProfileService — account records never leave the tenant", () => {
  const ATTACKER_ORG = "org-attacker";
  const TARGET = "user-in-another-org";

  function nonMemberHarness() {
    const select = jest.fn();
    const update = jest.fn();
    const insert = jest.fn();
    const prefsFindFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        userPreferences: { findFirst: prefsFindFirst },
      },
      select,
      update,
      insert,
    } as unknown as Db;
    const publishRevocations = jest.fn().mockResolvedValue(undefined);
    const svc = new UserProfileService(
      db,
      {} as unknown as CacheService,
      { publishRevocations } as unknown as SessionsService,
      {} as unknown as EmploymentFactsService,
      {} as unknown as UserActivityService,
      {} as unknown as ReportingRelationshipService,
    );
    return { svc, select, update, insert, prefsFindFirst, publishRevocations };
  }

  it("will not revoke one session of a user outside the caller's org", async () => {
    const h = nonMemberHarness();
    await expect(
      h.svc.revokeSession(ATTACKER_ORG, TARGET, "sess-1", "admin-1"),
    ).rejects.toThrow(NotFoundException);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.publishRevocations).not.toHaveBeenCalled();
  });

  it("will not revoke every session of a user outside the caller's org", async () => {
    const h = nonMemberHarness();
    await expect(
      h.svc.revokeAllSessions(ATTACKER_ORG, TARGET, "admin-1"),
    ).rejects.toThrow(NotFoundException);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.publishRevocations).not.toHaveBeenCalled();
  });

  it("will not read the preferences of a user outside the caller's org", async () => {
    const h = nonMemberHarness();
    await expect(h.svc.getPreferences(ATTACKER_ORG, TARGET)).rejects.toThrow(
      NotFoundException,
    );
    expect(h.prefsFindFirst).not.toHaveBeenCalled();
  });

  it("will not write the preferences of a user outside the caller's org", async () => {
    const h = nonMemberHarness();
    await expect(
      h.svc.updatePreferences(ATTACKER_ORG, TARGET, { theme: "dark" }),
    ).rejects.toThrow(NotFoundException);
    expect(h.prefsFindFirst).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("will not read the sign-in history of a user outside the caller's org", async () => {
    const h = nonMemberHarness();
    await expect(
      h.svc.getLoginHistory(ATTACKER_ORG, TARGET, { limit: 20, success: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(h.select).not.toHaveBeenCalled();
  });
});
