import { testAuthContext } from "../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { authorize } from "./authorize";
import type { DataScope } from "./access.types";
import type { AuthContext } from "../../common/auth/auth-context";
import { isCoreModuleKey } from "./entitlements.service";

function makeCtx(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
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

function makeResolver(map: Map<string, DataScope>) {
  return {
    scopeFor: async (ctx: CurrentUserContext, key: string): Promise<DataScope> => {
      if (ctx.tokenScopes && !ctx.tokenScopes.includes(key)) return "none";
      if (ctx.isOrgOwner) return "all";
      return map.get(key) ?? "none";
    },
  };
}

type CtxOptions =
  | boolean
  | ((key: string) => boolean)
  | {
      enabledModules?: readonly string[];
      planLockedModules?: readonly string[];
      onPlanLockedRead?: () => void;
      deniedModules?: Set<string>;
    };

function ctxFor(actor: CurrentUserContext, options: CtxOptions = true): AuthContext {
  return testAuthContext(actor, {
    moduleAvailability: async (_user, moduleKey) => {
      if (isCoreModuleKey(moduleKey)) return { available: true };

      if (typeof options === "boolean")
        return options ? { available: true } : { available: false, reason: "org-disabled" };

      if (typeof options === "function")
        return options(moduleKey)
          ? { available: true }
          : { available: false, reason: "org-disabled" };

      const {
        enabledModules = [],
        planLockedModules = [],
        onPlanLockedRead,
        deniedModules = new Set<string>(),
      } = options;

      if (deniedModules.has(moduleKey)) return { available: false, reason: "org-disabled" };
      if (enabledModules.includes(moduleKey)) return { available: true };
      onPlanLockedRead?.();
      if (planLockedModules.includes(moduleKey)) return { available: false, reason: "org-disabled" };
      return { available: false, reason: "org-disabled" };
    },
  });
}

describe("authorize", () => {
  it("denies with UNAUTHENTICATED when there is no context", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(resolver, null, "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "UNAUTHENTICATED" });
  });


  it("allows when the resolved map grants the permission and returns its scope", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "team"]]));
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:view");
    expect(result).toEqual({ allow: true, scope: "team" });
  });

  it("does not carry a permissions list in the allow result", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["hr:employees:view", "team"],
        ["hr:analytics:read", "all"],
        ["hr:payroll:view", "none"],
      ]),
    );
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:view");
    expect(result.allow).toBe(true);
    expect(result).not.toHaveProperty("permissions");
  });

  it("denies with FORBIDDEN when the permission is not in the resolved map", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("fails closed on a completely unknown key that appears in no module catalog", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(resolver, ctxFor(makeCtx()), "nonexistent:ghost:action");
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("fails closed on a malformed key with no module segment", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(resolver, ctxFor(makeCtx()), "bare-key");
    expect(result.allow).toBe(false);
  });

  /**
   * These two asked an org owner and expected NO_MODULE, and had never passed:
   * `isCoreModuleKey` treats an unknown module as core, so availability answers
   * yes and the deny comes from `scopeFor` instead — and an org owner's
   * `scopeFor` returns "all" for every key by design (access.service.ts:655).
   * Unknown-module-is-core is deliberate too: the registry lists what is *plan
   * gated*, not what exists, so treating an absent entry as gated would 402
   * `settings`, `tasks` and every other ungated namespace.
   *
   * So the guarantee is real but it is FORBIDDEN from `scopeFor`, not NO_MODULE
   * from availability, and it holds for everyone who is not an org owner. These
   * two pin that, and the owner case is pinned below so the wrong assertion is
   * not reintroduced as a bug report.
   */
  /**
   * The org owner is denied here too, and that is the point of the catalogue.
   *
   * Owner bypass is still the design for every key that means something: an
   * owner's `scopeFor` returns "all" and nothing above overrides it. But a key
   * in no catalogue is not a permission an owner holds, it is a permission that
   * does not exist — a typo in a `@RequirePermission`, most likely — and
   * allowing it is the one case where the bypass turns a mistake into an open
   * door. The catalogue check runs before the bypass for exactly that reason,
   * and `gated-keys-are-catalogued.spec.ts` guarantees every real key is in it,
   * so nothing legitimate is caught by this.
   */
  it("denies an org owner a key that appears in no catalogue", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(
      resolver,
      ctxFor(makeCtx({ isOrgOwner: true })),
      "nonexistent:ghost:action",
    );
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("still denies an org owner a key their token scopes exclude", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(
      resolver,
      ctxFor(makeCtx({ isOrgOwner: true, tokenScopes: ["hr:employees:view"] })),
      "nonexistent:ghost:action",
    );
    expect(result.allow).toBe(false);
  });

  it("denies with FORBIDDEN when the resolved scope is none", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "none"]]));
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("denies with NO_MODULE when the key's module is not enabled", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "all"]]));
    const result = await authorize(
      resolver,
      ctxFor(makeCtx(), { enabledModules: ["crm"] }),
      "hr:employees:view",
    );
    expect(result).toEqual({
      allow: false,
      scope: "none",
      reason: "NO_MODULE",
      moduleReason: "org-disabled",
    });
  });

  it("reads the canonical plan-lock input when an org has no module row", async () => {
    const onPlanLockedRead = jest.fn();
    const result = await authorize(
      makeResolver(new Map([["hr:employees:view", "all"]])),
      ctxFor(makeCtx(), { enabledModules: [], planLockedModules: ["hr"], onPlanLockedRead }),
      "hr:employees:view",
    );

    expect(result).toEqual({
      allow: false,
      scope: "none",
      reason: "NO_MODULE",
      moduleReason: "org-disabled",
    });
    expect(onPlanLockedRead).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical user-deny input before the org module state", async () => {
    const result = await authorize(
      makeResolver(new Map([["hr:employees:view", "all"]])),
      ctxFor(makeCtx(), { enabledModules: ["hr"], deniedModules: new Set(["hr"]) }),
      "hr:employees:view",
    );

    expect(result).toEqual({
      allow: false,
      scope: "none",
      reason: "NO_MODULE",
      moduleReason: "org-disabled",
    });
  });

  it("keeps employee self-service available without the HR module", async () => {
    const resolver = makeResolver(new Map([["self:leaves", "own"]]));
    const result = await authorize(
      resolver,
      ctxFor(makeCtx(), { enabledModules: ["build"] }),
      "self:leaves",
    );
    expect(result).toEqual({ allow: true, scope: "own" });
  });

  it("BOLA: passes ctx.orgId to the capability seam (not from request params)", async () => {
    const capturedOrgIds: string[] = [];
    const resolver = {
      scopeFor: async (ctx: CurrentUserContext): Promise<DataScope> => {
        capturedOrgIds.push(ctx.orgId);
        return "all";
      },
    };
    await authorize(resolver, ctxFor(makeCtx({ orgId: "org-legitimate" })), "hr:employees:view");
    expect(capturedOrgIds).toEqual(["org-legitimate"]);
  });

  it("denies the org owner when the module is disabled", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(
      resolver,
      ctxFor(makeCtx({ isOrgOwner: true }), { enabledModules: [] }),
      "hr:employees:manage",
    );
    expect(result).toEqual({
      allow: false,
      scope: "none",
      reason: "NO_MODULE",
      moduleReason: "org-disabled",
    });
  });

  it("denies an org admin when the module is disabled", async () => {
    const resolver = makeResolver(new Map([["settings:manage", "all"]]));
    const result = await authorize(
      resolver,
      ctxFor(makeCtx(), { enabledModules: [] }),
      "hr:employees:manage",
    );
    expect(result).toEqual({
      allow: false,
      scope: "none",
      reason: "NO_MODULE",
      moduleReason: "org-disabled",
    });
  });

  it("AC-04: holding settings:manage alone does NOT grant an unrelated permission", async () => {
    const resolver = makeResolver(new Map([["settings:manage", "all"]]));
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:payroll:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("AC-04: holding settings:rbac:manage alone does NOT grant an unrelated permission", async () => {
    const resolver = makeResolver(new Map([["settings:rbac:manage", "all"]]));
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("AC-04: a structural org admin is unaffected, because computeUserPermissions already resolves every key to all", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["settings:manage", "all"],
        ["hr:employees:manage", "all"],
      ]),
    );
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:manage");
    expect(result.allow).toBe(true);
    expect(result.scope).toBe("all");
  });

  it("AC-04: a scoped grant keeps its own scope instead of being widened to all", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["settings:manage", "all"],
        ["hr:employees:view", "own"],
      ]),
    );
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:view");
    expect(result.scope).toBe("own");
  });

  it("still denies a plain member whose module access was revoked", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(resolver, ctxFor(makeCtx()), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("does not entitlement-gate a namespace no organization can enable", async () => {
    const resolver = makeResolver(new Map([["directory:people:view", "all"]]));
    const result = await authorize(
      resolver,
      ctxFor(makeCtx(), { enabledModules: [] }),
      "directory:people:view",
    );
    expect(result).toEqual({ allow: true, scope: "all" });
  });

  it("denies with FORBIDDEN when tokenScopes does not include the permission key, even for an org owner", async () => {
    const resolver = makeResolver(new Map());
    const result = await authorize(
      resolver,
      ctxFor(makeCtx({ isOrgOwner: true, tokenScopes: ["crm:leads:view"] })),
      "hr:employees:view",
    );
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("tokenScopes null bypasses the token scope gate and behaves identically to an unrestricted session", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "team"]]));
    const result = await authorize(resolver, ctxFor(makeCtx({ tokenScopes: null })), "hr:employees:view");
    expect(result).toEqual({ allow: true, scope: "team" });
  });

  it("still grants access to a key within the tokenScopes budget", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["hr:employees:view", "team"],
        ["hr:analytics:read", "all"],
        ["hr:payroll:view", "all"],
      ]),
    );
    const result = await authorize(
      resolver,
      ctxFor(makeCtx({ tokenScopes: ["hr:employees:view", "hr:analytics:read"] })),
      "hr:employees:view",
    );
    expect(result.allow).toBe(true);
    expect(result).not.toHaveProperty("permissions");
  });
});
