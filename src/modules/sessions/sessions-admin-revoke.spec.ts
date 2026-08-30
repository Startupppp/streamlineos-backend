import { Test } from "@nestjs/testing";
import { UserProfileService } from "../users/user-profile.service";
import { SessionsService } from "./sessions.service";
import { AuditService } from "../../common/audit/audit.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { UserActivityService } from "../users/user-activity.service";
import { DRIZZLE } from "../../db/drizzle.constants";

/**
 * Regression guard for the defect where administrative revocation set
 * `userSessions.isRevoked` but never published the Redis tombstone that
 * `JwtAuthGuard` actually reads — so a force-logged-out member kept full access
 * until their JWT expired on its own.
 */
async function buildService(activeSessions: { id: string }[]) {
  const setWhere = jest.fn().mockResolvedValue(undefined);
  const mockDb = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 42, status: "ACTIVE" }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(activeSessions),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: setWhere }),
    }),
  };
  const publishRevocations = jest.fn().mockResolvedValue(undefined);

  // `UserProfileService` gained the employment accessor for its profile reads.
  // Revocation does not consult it, so this stub exists to satisfy the injector
  // and is asserted below to stay uncalled — if revocation ever starts reading
  // employment, that is a change worth failing on rather than absorbing.
  const getFacts = jest.fn().mockResolvedValue(null);

  const ref = await Test.createTestingModule({
    providers: [
      UserProfileService,
      { provide: DRIZZLE, useValue: mockDb },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: SessionsService, useValue: { publishRevocations } },
      { provide: EmploymentFactsService, useValue: { getFacts } },
      { provide: UserActivityService, useValue: { getUserActivity: jest.fn().mockResolvedValue([]) } },
    ],
  }).compile();

  return { svc: ref.get(UserProfileService), publishRevocations, setWhere, getFacts };
}

describe("administrative session revocation publishes tombstones", () => {
  it("revokeAllSessions tombstones every active session, not just the DB flag", async () => {
    const { svc, publishRevocations, setWhere, getFacts } = await buildService([
      { id: "s1" },
      { id: "s2" },
    ]);

    await svc.revokeAllSessions("org-1", "target", "admin-1");

    expect(setWhere).toHaveBeenCalledTimes(1);
    expect(publishRevocations).toHaveBeenCalledWith(["s1", "s2"]);
    expect(getFacts).not.toHaveBeenCalled();
  });

  it("revokeSession tombstones the single session it revoked", async () => {
    const { svc, publishRevocations } = await buildService([]);

    await svc.revokeSession("org-1", "target", "sess-9", "admin-1");

    expect(publishRevocations).toHaveBeenCalledWith(["sess-9"]);
  });

  it("revokeAllSessions still publishes an empty list when there is nothing active", async () => {
    const { svc, publishRevocations } = await buildService([]);

    await svc.revokeAllSessions("org-1", "target", "admin-1");

    expect(publishRevocations).toHaveBeenCalledWith([]);
  });
});
