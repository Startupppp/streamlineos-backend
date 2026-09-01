import { accessStub } from "../helpers/e2e-app";

describe("E2E access fixture core-module parity", () => {
  it("keeps core modules available across every stub interface", async () => {
    await expect(accessStub.isModuleEnabled("org-1", "chat")).resolves.toBe(true);
    await expect(accessStub.getModuleState("org-1", "chat")).resolves.toBe(true);
    await expect(accessStub.moduleAvailability({}, "chat")).resolves.toEqual({
      available: true,
    });
    await expect(
      accessStub.moduleAvailabilityFor("org-1", "user-1", "chat"),
    ).resolves.toEqual({ available: true });

    const resolver = accessStub.buildModuleAvailabilityResolver(async () => ({}));
    expect(resolver.isCoreModule("chat")).toBe(true);
  });

  it("keeps an unenabled plan-gated module unavailable", async () => {
    await expect(accessStub.isModuleEnabled("org-1", "hr")).resolves.toBe(false);
    await expect(accessStub.getModuleState("org-1", "hr")).resolves.toBeUndefined();
    await expect(accessStub.moduleAvailability({}, "hr")).resolves.toEqual({
      available: false,
      reason: "org-disabled",
    });

    const resolver = accessStub.buildModuleAvailabilityResolver(async () => ({}));
    expect(resolver.isCoreModule("hr")).toBe(false);
  });
});
