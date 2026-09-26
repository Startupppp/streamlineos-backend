import { createAuthContext, type AuthContextLookups } from "./auth-context";
import type { CurrentUserContext } from "./backend-claims";
import type { MembershipState } from "./membership-state.service";
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

const LIVE: MembershipState = {
  active: true,
  isOwner: false,
  role: "MEMBER",
  membershipId: 7,
};

function makeLookups(
  overrides: Partial<AuthContextLookups> = {},
): AuthContextLookups & {
  moduleAvailability: jest.Mock;
  membershipState: jest.Mock;
  mfaState: jest.Mock;
} {
  return {
    moduleAvailability: jest.fn(
      (): Promise<ModuleAvailabilityResult> => Promise.resolve({ available: true }),
    ),
    membershipState: jest.fn(() => Promise.resolve(LIVE)),
    mfaState: jest.fn(() => Promise.resolve({ enforced: false, satisfied: true })),
    ...overrides,
  } as AuthContextLookups & {
    moduleAvailability: jest.Mock;
    membershipState: jest.Mock;
    mfaState: jest.Mock;
  };
}

describe("createAuthContext — module availability", () => {
  it("calls the lookup only once for two moduleAvailable calls with the same key", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable("hr");

    expect(lookups.moduleAvailability).toHaveBeenCalledTimes(1);
  });

  it("calls the lookup once per distinct key", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable("crm");

    expect(lookups.moduleAvailability).toHaveBeenCalledTimes(2);
    expect(lookups.moduleAvailability).toHaveBeenNthCalledWith(1, expect.any(Object), "hr");
    expect(lookups.moduleAvailability).toHaveBeenNthCalledWith(2, expect.any(Object), "crm");
  });

  it('normalises "HR", "hr" and " hr " to the same memo entry', async () => {
    const lookups = makeLookups();
    const actor = makeActor();
    const ctx = createAuthContext(actor, lookups);

    await ctx.moduleAvailable("HR");
    await ctx.moduleAvailable("hr");
    await ctx.moduleAvailable(" hr ");

    expect(lookups.moduleAvailability).toHaveBeenCalledTimes(1);
    expect(lookups.moduleAvailability).toHaveBeenCalledWith(actor, "hr");
  });

  it("shares one in-flight promise with concurrent callers", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await Promise.all([ctx.moduleAvailable("hr"), ctx.moduleAvailable("hr")]);

    expect(lookups.moduleAvailability).toHaveBeenCalledTimes(1);
  });

  it("exposes the actor reference unchanged", () => {
    const actor = makeActor({ userId: "specific-user" });
    const ctx = createAuthContext(actor, makeLookups());

    expect(ctx.actor).toBe(actor);
  });

  it("propagates a rejecting lookup rather than resolving to available", async () => {
    const lookups = makeLookups({
      moduleAvailability: jest.fn(() => Promise.reject(new Error("lookup failed"))),
    });
    const ctx = createAuthContext(makeActor(), lookups);

    await expect(ctx.moduleAvailable("hr")).rejects.toThrow("lookup failed");
    await expect(ctx.moduleAvailable("hr")).rejects.toThrow("lookup failed");
  });
});

describe("createAuthContext — membership", () => {
  it("resolves the authority once for two membership calls", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await ctx.membership();
    await ctx.membership();

    expect(lookups.membershipState).toHaveBeenCalledTimes(1);
    expect(lookups.membershipState).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("shares one in-flight membership promise with concurrent callers", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await Promise.all([ctx.membership(), ctx.membership()]);

    expect(lookups.membershipState).toHaveBeenCalledTimes(1);
  });

  it("uses a seeded membership without calling the authority at all", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups, LIVE);

    await expect(ctx.membership()).resolves.toBe(LIVE);
    expect(lookups.membershipState).not.toHaveBeenCalled();
  });

  it("reads no membership for an actor with no organization, and reports none", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor({ orgId: "" }), lookups);

    await expect(ctx.membership()).resolves.toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
    expect(lookups.membershipState).not.toHaveBeenCalled();
  });

  it("propagates a rejecting membership lookup rather than reporting an active member", async () => {
    const lookups = makeLookups({
      membershipState: jest.fn(() => Promise.reject(new Error("membership unavailable"))),
    });
    const ctx = createAuthContext(makeActor(), lookups);

    await expect(ctx.membership()).rejects.toThrow("membership unavailable");
  });
});

describe("createAuthContext — MFA", () => {
  it("resolves the policy once for two mfa calls", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor(), lookups);

    await ctx.mfa();
    await ctx.mfa();

    expect(lookups.mfaState).toHaveBeenCalledTimes(1);
    expect(lookups.mfaState).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("reads no MFA policy for an actor with no organization, exactly as membership() reads no membership row", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor({ orgId: "" }), lookups);

    await ctx.mfa();

    expect(lookups.mfaState).not.toHaveBeenCalled();
  });

  it("does not report an org-less actor as MFA-exempt, because an empty orgId asked of the policy answers enforced:false and silently waives the requirement", async () => {
    const lookups = makeLookups();
    const ctx = createAuthContext(makeActor({ orgId: "" }), lookups);

    await expect(ctx.mfa()).resolves.toEqual({
      enforced: true,
      satisfied: false,
    });
  });

  it("memoises the org-less answer as one promise rather than recomputing it per caller", async () => {
    const ctx = createAuthContext(makeActor({ orgId: "" }), makeLookups());

    expect(ctx.mfa()).toBe(ctx.mfa());
  });

  it("propagates a rejecting policy rather than reporting MFA satisfied", async () => {
    const lookups = makeLookups({
      mfaState: jest.fn(() => Promise.reject(new Error("policy unavailable"))),
    });
    const ctx = createAuthContext(makeActor(), lookups);

    await expect(ctx.mfa()).rejects.toThrow("policy unavailable");
  });
});

describe("createAuthContext — the three facts are independent", () => {
  it("a failing module lookup does not poison membership or MFA", async () => {
    const lookups = makeLookups({
      moduleAvailability: jest.fn(() => Promise.reject(new Error("modules down"))),
    });
    const ctx = createAuthContext(makeActor(), lookups);

    await expect(ctx.moduleAvailable("hr")).rejects.toThrow("modules down");
    await expect(ctx.membership()).resolves.toBe(LIVE);
    await expect(ctx.mfa()).resolves.toEqual({ enforced: false, satisfied: true });
  });

  it("binds every lookup to its own actor and organization", async () => {
    const lookups = makeLookups();
    const other = makeLookups();
    const first = createAuthContext(makeActor(), lookups);
    const second = createAuthContext(
      makeActor({ userId: "user-2", orgId: "org-2" }),
      other,
    );

    await Promise.all([first.membership(), second.membership()]);

    expect(lookups.membershipState).toHaveBeenCalledWith("user-1", "org-1");
    expect(other.membershipState).toHaveBeenCalledWith("user-2", "org-2");
  });
});
