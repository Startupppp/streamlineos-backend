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
});
