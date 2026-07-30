import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { authorize, type AccessResolver } from "./authorize";
import type { DataScope } from "./access.types";

function makeCtx(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "ENGINEERING",
    permissions: [],
    enabledModules: ["hr", "crm"],
    plan: null,
    isOrgOwner: false,
    sessionId: "session-1",
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
});

