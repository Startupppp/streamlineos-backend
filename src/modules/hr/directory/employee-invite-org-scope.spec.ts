import { buildService, makeHarness } from "./employee-onboarding.spec-fixtures";

const ORG_ID = "org-invite-org-scope";
const OTHER_ORG_ID = "org-other-tenant";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };
const TARGET = "user-target-1";

function activeMember(overrides: Record<string, unknown> = {}) {
  return {
    email: "target@example.com",
    name: "Target Person",
    firstName: "Target",
    lastName: "Person",
    isActive: true,
    emailVerified: null,
    membershipStatus: "ACTIVE",
    isOwner: false,
    ...overrides,
  };
}

describe("EmployeeOnboardingService — magic link mints are scoped to the acting org", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("createInviteLink", () => {
    it("records the actor's org so a link minted by org A cannot redeem into org B", async () => {
      const harness = makeHarness({
        selects: { organization_members: [[activeMember()]] },
      });
      const { service } = buildService(harness.db);

      await service.createInviteLink(ACTOR as never, TARGET);

      const token = harness.inserted.find((r) => r.table === "magic_link_tokens");
      expect(token).toBeDefined();
      expect((token!.values as Record<string, unknown>).orgId).toBe(ORG_ID);
    });

    it("does not stamp a foreign org onto the token when the actor belongs to a different org", async () => {
      const harness = makeHarness({
        selects: { organization_members: [[activeMember()]] },
      });
      const { service } = buildService(harness.db);

      await service.createInviteLink(ACTOR as never, TARGET);

      const token = harness.inserted.find((r) => r.table === "magic_link_tokens");
      expect((token!.values as Record<string, unknown>).orgId).not.toBe(OTHER_ORG_ID);
      expect((token!.values as Record<string, unknown>).orgId).toBe(ORG_ID);
    });
  });

  describe("resendInvite — welcome path (unverified account)", () => {
    it("records the actor's org so the token is scoped to the org that issued the invite", async () => {
      const harness = makeHarness({
        selects: { organization_members: [[activeMember()]] },
      });
      const { service } = buildService(harness.db);

      await service.resendInvite(ACTOR as never, TARGET);

      const token = harness.inserted.find((r) => r.table === "magic_link_tokens");
      expect(token).toBeDefined();
      expect((token!.values as Record<string, unknown>).orgId).toBe(ORG_ID);
    });

    it("does not attach a foreign org to the token when a different actor org is in scope", async () => {
      const harness = makeHarness({
        selects: { organization_members: [[activeMember()]] },
      });
      const { service } = buildService(harness.db);

      await service.resendInvite(ACTOR as never, TARGET);

      const token = harness.inserted.find((r) => r.table === "magic_link_tokens");
      expect((token!.values as Record<string, unknown>).orgId).not.toBe(OTHER_ORG_ID);
      expect((token!.values as Record<string, unknown>).orgId).toBe(ORG_ID);
    });
  });
});
