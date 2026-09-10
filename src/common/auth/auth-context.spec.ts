import { createAuthContext } from "./auth-context";
import type { CurrentUserContext } from "./backend-claims";
import type { ModuleAvailabilityResult } from "../rbac/module-availability";
import { humanSessionPrincipal } from "./principal";

function makeActor(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "ENGINEERING",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...partial,
  };
}

describe("createAuthContext", () => {
  it("calls the lookup only once for two moduleAvailable calls with the same key", async () => {
    const moduleAvailability = jest.fn(
      (_user: CurrentUserContext, _key: string): Promise<ModuleAvailabilityResult> =>
        Promise.resolve({ available: true }),
    );
    const ctx = createAuthContext(makeActor(), { moduleAvailability });

    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable("hr");

    expect(moduleAvailability).toHaveBeenCalledTimes(1);
  });

  it("calls the lookup once per distinct key", async () => {
    const moduleAvailability = jest.fn(
      (_user: CurrentUserContext, _key: string): Promise<ModuleAvailabilityResult> =>
        Promise.resolve({ available: true }),
    );
    const ctx = createAuthContext(makeActor(), { moduleAvailability });

    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable("crm");

    expect(moduleAvailability).toHaveBeenCalledTimes(2);
    expect(moduleAvailability).toHaveBeenNthCalledWith(1, expect.any(Object), "hr");
    expect(moduleAvailability).toHaveBeenNthCalledWith(2, expect.any(Object), "crm");
  });

  it('normalises "HR", "hr" and " hr " to the same memo entry', async () => {
    const moduleAvailability = jest.fn(
      (_user: CurrentUserContext, _key: string): Promise<ModuleAvailabilityResult> =>
        Promise.resolve({ available: true }),
    );
    const actor = makeActor();
    const ctx = createAuthContext(actor, { moduleAvailability });

    await ctx.moduleAvailable("HR");
    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable(" hr ");

    expect(moduleAvailability).toHaveBeenCalledTimes(1);
    expect(moduleAvailability).toHaveBeenCalledWith(actor, "hr");
  });

  it("exposes the actor reference unchanged", () => {
    const actor = makeActor({ userId: "specific-user" });
    const moduleAvailability = jest.fn(
      (_user: CurrentUserContext, _key: string): Promise<ModuleAvailabilityResult> =>
        Promise.resolve({ available: true }),
    );
    const ctx = createAuthContext(actor, { moduleAvailability });

    expect(ctx.actor).toBe(actor);
  });

  it("propagates a rejecting lookup rather than resolving to available", async () => {
    const error = new Error("lookup failed");
    const moduleAvailability = jest.fn(
      (_user: CurrentUserContext, _key: string): Promise<ModuleAvailabilityResult> =>
        Promise.reject(error),
    );
    const ctx = createAuthContext(makeActor(), { moduleAvailability });

    await expect(ctx.moduleAvailable("hr")).rejects.toThrow("lookup failed");
  });
});
