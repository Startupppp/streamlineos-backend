import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
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

  it("throws NotFoundException when user is not a member of the requesting org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockAudit = { log: jest.fn() } as any;
    const mockSessions = {} as any;
    const mockEmployment = {} as any;
    const svc = new UserProfileService(db, mockAudit, mockSessions, mockEmployment);
    await expect(svc.getUserSessions(ATTACKER_ORG, USER_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns sessions for the owning org (control — same-tenant)", async () => {
    const db = makeDb({ userId: USER_ID });
    const mockAudit = { log: jest.fn() } as any;
    const mockSessions = {} as any;
    const mockEmployment = {} as any;
    const svc = new UserProfileService(db, mockAudit, mockSessions, mockEmployment);
    await expect(svc.getUserSessions(OWNER_ORG, USER_ID)).resolves.toEqual([]);
  });
});
