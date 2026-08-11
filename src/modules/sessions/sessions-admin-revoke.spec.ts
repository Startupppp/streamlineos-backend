import { Test } from "@nestjs/testing";
import { UserProfileService } from "../users/user-profile.service";
import { SessionsService } from "./sessions.service";
import { AuditService } from "../../common/audit/audit.service";
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

  const ref = await Test.createTestingModule({
    providers: [
      UserProfileService,
      { provide: DRIZZLE, useValue: mockDb },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: SessionsService, useValue: { publishRevocations } },
    ],
  }).compile();

  return { svc: ref.get(UserProfileService), publishRevocations, setWhere };
}

describe("administrative session revocation publishes tombstones", () => {
  it("revokeAllSessions tombstones every active session, not just the DB flag", async () => {
    const { svc, publishRevocations, setWhere } = await buildService([
      { id: "s1" },
      { id: "s2" },
    ]);

    await svc.revokeAllSessions("org-1", "target", "admin-1");

    expect(setWhere).toHaveBeenCalledTimes(1);
    expect(publishRevocations).toHaveBeenCalledWith(["s1", "s2"]);
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
