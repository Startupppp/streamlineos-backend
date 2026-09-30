import { AuthService } from "./auth.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(async () => undefined),
}));

/**
 * CHAT-008: a session sitting in org "alpha" reloaded into "streamline" — the account's
 * most-recently-activated org — because session-data ignored which org the session had chosen.
 */
describe("AuthService.getSessionData honours the session's own org", () => {
  const MEMBERSHIPS: Record<string, Record<string, unknown>> = {
    "org-streamline": { orgId: "org-streamline", isOwner: true, role: "OWNER" },
    "org-alpha": { orgId: "org-alpha", isOwner: false, role: "MEMBER" },
  };

  function buildService(activeOrgIds: string[]) {
    const db = {
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: "user-1",
            email: "a@example.com",
            firstName: null,
            lastName: null,
            name: "A",
            image: null,
            isActive: true,
            onboardingCompletedAt: null,
            lastActiveOrgId: "org-streamline",
          }),
        },
      },
    };
    const cache = {
      cached: jest.fn((_key: string, load: () => Promise<unknown>) => load()),
    };
    const membershipResolver = {
      // Mirrors resolveActiveMembership: the preferred org if still active, else another.
      resolveActiveMembership: jest.fn(async (_userId: string, preferred: string | null) =>
        preferred && activeOrgIds.includes(preferred)
          ? MEMBERSHIPS[preferred]
          : MEMBERSHIPS[activeOrgIds[0]] ?? null,
      ),
      resolveSuspendedMembership: jest.fn().mockResolvedValue(null),
    };
    const service = new AuthService(
      db as never,
      {} as never,
      cache as never,
      {} as never,
      {} as never,
      membershipResolver as never,
      {} as never,
    );
    return { service, db };
  }

  it("without a session org, answers the most recently activated org", async () => {
    const { service } = buildService(["org-streamline", "org-alpha"]);
    await expect(service.getSessionData("user-1")).resolves.toMatchObject({
      orgId: "org-streamline",
      role: "OWNER",
    });
  });

  it("keeps a session in the org it selected, with that org's role", async () => {
    const { service } = buildService(["org-streamline", "org-alpha"]);
    await expect(service.getSessionData("user-1", "org-alpha")).resolves.toMatchObject({
      orgId: "org-alpha",
      role: "MEMBER",
      isOrgOwner: false,
    });
  });

  it("falls back to the default org once the session's org membership is gone", async () => {
    const { service } = buildService(["org-streamline"]);
    await expect(service.getSessionData("user-1", "org-alpha")).resolves.toMatchObject({
      orgId: "org-streamline",
    });
  });

  it("loads once when the session org already is the default", async () => {
    const { service, db } = buildService(["org-streamline", "org-alpha"]);
    await service.getSessionData("user-1", "org-streamline");
    expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
  });
});
