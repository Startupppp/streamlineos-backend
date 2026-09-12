import { AuthService } from "./auth.service";

describe("AuthService organization access session state", () => {
  function buildService(options?: {
    activeMembership?: Record<string, unknown> | null;
    suspendedMembership?: Record<string, unknown> | null;
  }) {
    const db = {
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: "user-1",
            email: "admin@example.com",
            firstName: "Asha",
            lastName: "Rao",
            name: "Asha Rao",
            image: null,
            isActive: true,
            onboardingCompletedAt: null,
            lastActiveOrgId: "org-original",
          }),
        },
      },
    };
    const cache = {
      cached: jest.fn(
        (_key: string, load: () => Promise<unknown>) => load(),
      ),
    };
    const membershipResolver = {
      resolveActiveMembership: jest
        .fn()
        .mockResolvedValue(options?.activeMembership ?? null),
      resolveSuspendedMembership: jest
        .fn()
        .mockResolvedValue(options?.suspendedMembership ?? null),
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

    return { service, membershipResolver };
  }

  it("reports suspended membership instead of presenting the user as unconfigured", async () => {
    const { service, membershipResolver } = buildService({
      suspendedMembership: {
        orgId: "org-original",
        orgName: "Original workspace",
      },
    });

    await expect(service.getSessionData("user-1")).resolves.toMatchObject({
      orgId: null,
      isOrgOwner: false,
      organizationAccess: "suspended",
      suspendedOrganizationName: "Original workspace",
    });
    expect(membershipResolver.resolveActiveMembership).toHaveBeenCalledWith(
      "user-1",
      "org-original",
      { honorSuspendedPreference: true },
    );
  });

  describe("platform operator standing reaches the session payload", () => {
    const previous = process.env.PLATFORM_ADMIN_USER_IDS;

    afterEach(() => {
      if (previous === undefined) delete process.env.PLATFORM_ADMIN_USER_IDS;
      else process.env.PLATFORM_ADMIN_USER_IDS = previous;
    });

    it("is false for an account outside the deployment allowlist", async () => {
      process.env.PLATFORM_ADMIN_USER_IDS = "someone-else";
      const { service } = buildService();
      await expect(service.getSessionData("user-1")).resolves.toMatchObject({
        isPlatformAdmin: false,
      });
    });

    it("is false when the allowlist is unset, which is the correct default", async () => {
      delete process.env.PLATFORM_ADMIN_USER_IDS;
      const { service } = buildService();
      await expect(service.getSessionData("user-1")).resolves.toMatchObject({
        isPlatformAdmin: false,
      });
    });

    it("is true for an allowlisted account, so the gate can route it to /owner", async () => {
      process.env.PLATFORM_ADMIN_USER_IDS = "other-operator, user-1";
      const { service } = buildService();
      await expect(service.getSessionData("user-1")).resolves.toMatchObject({
        isPlatformAdmin: true,
      });
    });

    it("does not confer organization access — standing and membership stay separate", async () => {
      process.env.PLATFORM_ADMIN_USER_IDS = "user-1";
      const { service } = buildService();
      await expect(service.getSessionData("user-1")).resolves.toMatchObject({
        isPlatformAdmin: true,
        orgId: null,
        isOrgOwner: false,
        organizationAccess: "none",
      });
    });
  });
});
