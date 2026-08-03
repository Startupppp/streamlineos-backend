import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { authorize, type AccessResolver } from "./authorize";
import type { DataScope } from "./access.types";

function makeCtx(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "ENGINEERING",
    permissions: [],
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    ...partial,
  };
}

function makeResolver(map: Map<string, DataScope>, enabledModules: string[]): AccessResolver {
  return {
    resolveUserPermissions: () => Promise.resolve(map),
    isModuleEnabled: (_orgId, moduleKey) => Promise.resolve(enabledModules.includes(moduleKey)),
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
    expect(result).toEqual({ allow: true, scope: "team", permissions: ["hr:employees:view"] });
  });

  it("returns the granted keys excluding none-scoped grants for downstream hydration", async () => {
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
    expect(result.permissions).toEqual(["hr:employees:view", "hr:analytics:read"]);
  });

  it("denies with FORBIDDEN when the permission is not in the resolved map", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
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

  it("skips the module gate for internal settings and self keys", async () => {
    const resolver = makeResolver(new Map([["settings:rbac:manage", "all"]]), []);
    const result = await authorize(resolver, makeCtx(), "settings:rbac:manage");
    expect(result).toEqual({ allow: true, scope: "all", permissions: ["settings:rbac:manage"] });
  });

  it("BOLA: passes ctx.orgId to resolveUserPermissions (not from request params)", async () => {
    const capturedOrgIds: string[] = [];
    const resolver: AccessResolver = {
      resolveUserPermissions: async (orgId) => {
        capturedOrgIds.push(orgId);
        return new Map([["hr:employees:view", "all" as DataScope]]);
      },
      isModuleEnabled: async () => true,
    };
    await authorize(resolver, makeCtx({ orgId: "org-legitimate" }), "hr:employees:view");
    expect(capturedOrgIds).toEqual(["org-legitimate"]);
  });

  it("allows the org owner with no grants and the module disabled", async () => {
    const resolver = makeResolver(new Map(), []);
    const result = await authorize(resolver, makeCtx({ isOrgOwner: true }), "hr:employees:manage");
    expect(result).toEqual({ allow: true, scope: "all" });
  });

  it("allows an org admin with no module grant and the module disabled", async () => {
    const resolver = makeResolver(new Map([["settings:manage", "all"]]), []);
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result).toEqual({ allow: true, scope: "all" });
  });

  it("still denies a plain member whose module access was revoked", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:manage");
    expect(result).toEqual({ allow: false, scope: "none", reason: "FORBIDDEN" });
  });

  it("does not entitlement-gate a namespace no organization can enable", async () => {
    const resolver = makeResolver(new Map([["directory:people:view", "all"]]), []);
    const result = await authorize(resolver, makeCtx(), "directory:people:view");
    expect(result).toEqual({
      allow: true,
      scope: "all",
      permissions: ["directory:people:view"],
    });
  });

  it("denies with FORBIDDEN when tokenScopes does not include the permission key, even for an org owner", async () => {
    const resolver = makeResolver(new Map(), []);
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
    expect(result).toEqual({ allow: true, scope: "team", permissions: ["hr:employees:view"] });
  });

  it("intersects the returned permissions array with tokenScopes when non-null", async () => {
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
    expect(result.permissions).toEqual(
      expect.arrayContaining(["hr:employees:view", "hr:analytics:read"]),
    );
    expect(result.permissions).not.toContain("hr:payroll:view");
  });
});

