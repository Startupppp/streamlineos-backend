import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { authorize, requirePermission, type AccessResolver } from "./authorize";
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
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "session-1",
    ...partial,
  };
}

function makeResolver(map: Map<string, DataScope>, enabledModules: string[]): AccessResolver {
  return {
    resolveUserPermissions: () => Promise.resolve(map),
    getModuleEnabled: (_ctx, moduleKey) => enabledModules.includes(moduleKey),
  };
}

describe("authorize", () => {
  it("denies with UNAUTHENTICATED when there is no context", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    const result = await authorize(resolver, null, "hr:employees:view");
    expect(result).toEqual({ allow: false, scope: "none", reason: "UNAUTHENTICATED" });
  });

  it("allows owners and platform admins everything at scope all", async () => {
    const resolver = makeResolver(new Map(), []);
    const owner = await authorize(resolver, makeCtx({ isOrgOwner: true }), "hr:employees:view");
    expect(owner).toEqual({ allow: true, scope: "all" });
    const admin = await authorize(resolver, makeCtx({ isPlatformAdmin: true }), "hr:employees:view");
    expect(admin).toEqual({ allow: true, scope: "all" });
  });

  it("allows when the resolved map grants the permission and returns its scope", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "team"]]), ["hr"]);
    const result = await authorize(resolver, makeCtx(), "hr:employees:view");
    expect(result).toEqual({ allow: true, scope: "team" });
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
    expect(result).toEqual({ allow: true, scope: "all" });
  });
});

describe("requirePermission", () => {
  it("returns the granted scope on allow", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "own"]]), ["hr"]);
    await expect(requirePermission(resolver, makeCtx(), "hr:employees:view")).resolves.toBe("own");
  });

  it("throws UnauthorizedException when unauthenticated", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    await expect(requirePermission(resolver, null, "hr:employees:view")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("throws ForbiddenException when forbidden", async () => {
    const resolver = makeResolver(new Map(), ["hr"]);
    await expect(requirePermission(resolver, makeCtx(), "hr:employees:view")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("throws ForbiddenException when the module is disabled", async () => {
    const resolver = makeResolver(new Map([["hr:employees:view", "all"]]), ["crm"]);
    await expect(requirePermission(resolver, makeCtx(), "hr:employees:view")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
