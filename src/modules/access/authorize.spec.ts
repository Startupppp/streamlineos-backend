import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { authorize, type AccessResolver } from "./authorize";
import type { DataScope } from "./access.types";
import {
  moduleAvailabilityResolver,
  type ModuleAvailabilityResolver,
} from "../../common/rbac/module-availability";
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

function makeResolver(
  map: Map<string, DataScope>,
  enabledModules: string[],
  options: {
    deniedModules?: Set<string>;
    planLockedModules?: readonly string[];
    onPlanLockedRead?: () => void;
    useModuleState?: boolean;
    moduleState?: boolean;
  } = {},
): AccessResolver {
  const availabilityResolver = (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
  ): ModuleAvailabilityResolver =>
    moduleAvailabilityResolver(
      {
        isCoreModule: isCoreModuleKey,
        getModuleMap,
        getPlanLockedModules: async () => {
          options.onPlanLockedRead?.();
          return options.planLockedModules ?? [];
        },
      },
      {
        getUserDeniedModules: async () => options.deniedModules ?? new Set<string>(),
      },
    );

  return {
    scopeFor: async (ctx, key) => {
      if (
        ctx.tokenScopes &&
        !ctx.tokenScopes.includes(key)
      ) return "none";
      if (ctx.isOrgOwner) return "all";
      return map.get(key) ?? "none";
    },
    getModuleState: async (_orgId, moduleKey) =>
      enabledModules.includes(moduleKey)
        ? true
        : options.useModuleState
          ? options.moduleState
          : false,
    buildModuleAvailabilityResolver: availabilityResolver,
  };
}

describe("authorize", () => {
  it("denies with UNAUTHENTICATED when there is no context", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, null, "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "UNAUTHENTICATED" });
  });


  it("allows when the resolved map grants the permission and returns its scope", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "team"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: true, scope: "team" });
  });

  it("does not carry a permissions list in the allow result", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["hr:employees:view", "team"],
        ["hr:analytics:read", "all"],
        ["hr:payroll:view", "none"],
      ]),
      ["hr"],
    );
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result.allow).toBe(true);
    expect(result).not.toHaveProperty("permissions");
  });

  it("denies with FORBIDDEN when the permission is not in the resolved map", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("fails closed on a completely unknown key that appears in no module catalog", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "nonexistent:ghost:action");
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("fails closed on a malformed key with no module segment", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "bare-key");
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
  it("allows an org owner an unknown key, because owner bypass is the design", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(
      resolver,
      makeCtx({ isOrgOwner: true }),
      "nonexistent:ghost:action",
    );
    expect(result).toEqual({ allow: true, scope: "all" });
  });

  it("still denies an org owner a key their token scopes exclude", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(
      resolver,
      makeCtx({ isOrgOwner: true, tokenScopes: ["hr:employees:view"] }),
      "nonexistent:ghost:action",
    );
    expect(result.allow).toBe(false);
  });

  it("denies with FORBIDDEN when the resolved scope is none", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "none"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("denies with NO_MODULE when the key's module is not enabled", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "all"]]), ["crm"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "NO_MODULE" });
  });

  it("reads the canonical plan-lock input when an org has no module row", async () => {
    const onPlanLockedRead = jest.fn();
    const result = await authorize(
      makeResolver(new Map([ ["hr:employees:view", "all"] ]), [], {
        planLockedModules: ["hr"],
        onPlanLockedRead,
        useModuleState: true,
      }),
      makeCtx(),
      "hr:employees:view",
    );

    expect(result).toEqual({ allow: false, scope: "none", reason: "NO_MODULE" });
    expect(onPlanLockedRead).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical user-deny input before the org module state", async () => {
    const result = await authorize(
      makeResolver(new Map([["hr:employees:view", "all"]]), ["hr"], {
        deniedModules: new Set(["hr"]),
      }),
      makeCtx(),
      "hr:employees:view",
    );

    expect(result).toEqual({ allow: false, scope: "none", reason: "NO_MODULE" });
  });

  it("keeps employee self-service available without the HR module", async () => {
    const resolver = makeResolver(new Map([["self:leaves", "own"]]), ["build"]);
    const result = await authorize(resolver, makeCtx(), "self:leaves");
    expect(result).toEqual({ allow: true, scope: "own" });
  });

  it("BOLA: passes ctx.orgId to the capability seam (not from request params)", async () => {
    const capturedOrgIds: string[] = [];
    const resolver: AccessResolver = {
      scopeFor: async (ctx) => {
        capturedOrgIds.push(ctx.orgId);
        return "all";
      },
      getModuleState: async () => true,
      buildModuleAvailabilityResolver: (getModuleMap) =>
        moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        }),
    };
    await authorize(resolver, makeCtx({ orgId: "org-legitimate" }), "hr:employees:view");
    expect(capturedOrgIds).toEqual(["org-legitimate"]);
  });

  it("denies the org owner when the module is disabled", async () => {
    const resolver = makeResolver(new Map(), []);
    const result = await authorize(resolver, makeCtx({ isOrgOwner: true }), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "NO_MODULE" });
  });

  it("denies an org admin when the module is disabled", async () => {
    const resolver = makeResolver(new Map([["settings:manage", "all"]]), []);
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "NO_MODULE" });
  });

  it("AC-04: holding settings:manage alone does NOT grant an unrelated permission", async () => {
    const resolver = makeResolver(new Map([["settings:manage", "all"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:payroll:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("AC-04: holding settings:rbac:manage alone does NOT grant an unrelated permission", async () => {
    const resolver = makeResolver(new Map([["settings:rbac:manage", "all"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("AC-04: a structural org admin is unaffected, because computeUserPermissions already resolves every key to all", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["settings:manage", "all"],
        ["hr:employees:manage", "all"],
      ]),
      ["hr"],
    );
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result.allow).toBe(true);
    expect(result.scope).toBe("all");
  });

  it("AC-04: a scoped grant keeps its own scope instead of being widened to all", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["settings:manage", "all"],
        ["hr:employees:view", "own"],
      ]),
      ["hr"],
    );
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result.scope).toBe("own");
  });

  it("still denies a plain member whose module access was revoked", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("does not entitlement-gate a namespace no organization can enable", async () => {
    const resolver = makeResolver(new Map([["directory:people:view", "all"]]), []);
    const result = await authorize(resolver, makeCtx(), "directory:people:view");
    expect(result).toEqual({ allow: true, scope: "all" });
  });

  it("denies with FORBIDDEN when tokenScopes does not include the permission key, even for an org owner", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(
      resolver,
      makeCtx({ isOrgOwner: true, tokenScopes: ["crm:leads:view"] }),
      "hr:employees:view",
    );
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("tokenScopes null bypasses the token scope gate and behaves identically to an unrestricted session", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "team"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx({ tokenScopes: null }), "hr:employees:view");
    expect(result).toEqual({ allow: true, scope: "team" });
  });

  it("still grants access to a key within the tokenScopes budget", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["hr:employees:view", "team"],
        ["hr:analytics:read", "all"],
        ["hr:payroll:view", "all"],
      ]),
      ["hr"],
    );
    const result = await authorize(
      resolver,
      makeCtx({ tokenScopes: ["hr:employees:view", "hr:analytics:read"] }),
      "hr:employees:view",
    );
    expect(result.allow).toBe(true);
    expect(result).not.toHaveProperty("permissions");
  });
});

