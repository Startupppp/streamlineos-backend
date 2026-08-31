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
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }),
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
});
