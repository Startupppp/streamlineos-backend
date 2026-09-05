import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { SessionsService } from "../sessions/sessions.service";
import type { EmploymentFactsService } from "../directory/employment-facts.service";
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
    const audit: Pick<AuditService, "log"> = { log: jest.fn() };
    const sessions: Partial<SessionsService> = {};
    const employment: Partial<EmploymentFactsService> = {};
    const activity: Partial<UserActivityService> = {};
    return new UserProfileService(
      makeDb(memberRow),
      audit as AuditService,
      sessions as SessionsService,
      employment as EmploymentFactsService,
      activity as UserActivityService,
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

      const audit: Pick<AuditService, "log"> = { log: jest.fn() };
      const svc = new UserProfileService(
        db,
        audit as AuditService,
        {} as SessionsService,
        {} as EmploymentFactsService,
        {} as UserActivityService,
      );

      const result = await svc.updatePreferences(OWNER_ORG, USER_ID, {});

      expect(result).toEqual({ success: true });
      expect(prefsFindFirst).not.toHaveBeenCalled();
      expect(updateSet).not.toHaveBeenCalled();
    });
  });
});
