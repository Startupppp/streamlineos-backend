/**
 * Universal communication proof — ITEM 4
 *
 * Proves:
 * (a) An ordinary active member with ZERO enabled paid modules still resolves
 *     inbox / calendar / chat keys, because EMPLOYEE_SELF_SERVICE_GRANTS are
 *     merged before any role is read.
 * (b) Privately-scoped surfaces (a channel the member is not in) are denied
 *     at the authorize() level when the scope returned is "none".
 * (c) An org owner or admin with full billing:* customer authority does NOT
 *     receive platform promotion authority (blog:posts:manage,
 *     billing:promotions:view/manage).
 *
 * Evidence level: MOCKED — real AccessPermissionResolver and authorize() with
 * fake DB chain and AuthContext. No HTTP server, no Redis, no database.
 *
 * HTTP + realtime layer evidence: cannot be proved with mocks. The claim
 * that navigation, direct URL, HTTP and realtime agree requires a live
 * session and is noted as open.
 */

import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { testAuthContext, MODULE_AVAILABLE, MODULE_DISABLED } from "../../../../test/helpers/module-guard-context";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { PLATFORM_ONLY_PERMISSION_KEYS } from "../../../common/rbac/grantability";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { authorize } from "../authorize";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { isCoreModuleKey } from "../../../common/rbac/module-registry";

const UNIVERSAL_MEMBER_KEYS: ReadonlyArray<[string, string]> = [
  ["inbox",    "mail:inbox:view"],
  ["calendar", "calendar:read"],
  ["chat",     "chat:channels:read"],
  ["calendar", "calendar:write"],
  ["chat",     "chat:messages:read"],
  ["chat",     "chat:messages:write"],
  ["inbox",    "mail:messages:send"],
];

function zeroModuleCtx(actor: CurrentUserContext) {
  return testAuthContext(actor, {
    moduleAvailability: async (_u, moduleKey) =>
      isCoreModuleKey(moduleKey) ? MODULE_AVAILABLE : MODULE_DISABLED,
  });
}

function makeActor(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-universal-1",
    orgId: "org-universal",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-universal",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...partial,
  };
}

function buildZeroModuleMemberResolver(): AccessPermissionResolver {
  const db = {
    query: {},
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
            limit: () => Promise.resolve([]),
          }),
        }),
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({ isOwner: false, status: "ACTIVE", id: 1, role: "MEMBER" }),
  );
}

describe("universal communication: zero-paid-module member resolves inbox / calendar / chat keys", () => {
  it("each Home surface key is present in EMPLOYEE_SELF_SERVICE_GRANTS (source proof)", () => {
    const universal = new Set(EMPLOYEE_SELF_SERVICE_GRANTS.map((g) => g.permissionKey));
    for (const [surface, key] of UNIVERSAL_MEMBER_KEYS) {
      expect({ surface, present: universal.has(key) }).toMatchObject({ surface, present: true });
    }
  });

  it.each(UNIVERSAL_MEMBER_KEYS)(
    "module 'chat', 'mail', 'calendar' are not plan-gated — isCoreModuleKey returns true for each namespace",
    (_surface, key) => {
      const ns = key.split(":")[0]!;
      expect(isCoreModuleKey(ns)).toBe(true);
    },
  );

  it("a zero-paid-module member resolves every Home surface through computeUserPermissions", async () => {
    const resolver = buildZeroModuleMemberResolver();
    const { perms } = await resolver.computeUserPermissions("org-universal", "u-universal-1", 1);
    for (const [surface, key] of UNIVERSAL_MEMBER_KEYS) {
      expect({ surface, scope: perms[key] }).toMatchObject({ surface, scope: expect.anything() });
    }
  });

  it("a zero-paid-module member resolves each Home surface through the full authorize() path", async () => {
    const resolver = buildZeroModuleMemberResolver();
    const actor = makeActor({});
    const ctx = zeroModuleCtx(actor);

    for (const [surface, key] of UNIVERSAL_MEMBER_KEYS) {
      const { perms } = await resolver.computeUserPermissions("org-universal", "u-universal-1", 1);
      const scopeMap = new Map(Object.entries(perms) as [string, import("../access.types").DataScope][]);
      const result = await authorize(
        { scopeFor: async (_u, k) => scopeMap.get(k) ?? "none" },
        ctx,
        key,
      );
      expect({ surface, allow: result.allow }).toMatchObject({ surface, allow: true });
    }
  });
});

describe("private channel / mailbox denial holds even for a universal member", () => {
  it("a key the member does not hold in their scope map is denied, regardless of universal status", async () => {
    const actor = makeActor({});
    const ctx = zeroModuleCtx(actor);

    // A private channel that the member is not a participant of:
    // the service would return "none" for the key (or not grant it at all).
    // authorize() receives "none" from scopeFor → FORBIDDEN.
    const result = await authorize(
      { scopeFor: async () => "none" },
      ctx,
      "chat:channels:read",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("the test is not vacuous — an authorized member whose scopeFor returns 'all' is allowed", async () => {
    const actor = makeActor({});
    const ctx = zeroModuleCtx(actor);
    const result = await authorize(
      { scopeFor: async () => "all" },
      ctx,
      "chat:channels:read",
    );
    expect(result.allow).toBe(true);
  });
});

describe("platform promotion authority: org owner with billing:* is REFUSED blog/promotions keys", () => {
  it("PLATFORM_ONLY_PERMISSION_KEYS includes blog:posts:manage and billing:promotions:view/manage", () => {
    expect(PLATFORM_ONLY_PERMISSION_KEYS.has("blog:posts:manage")).toBe(true);
    expect(PLATFORM_ONLY_PERMISSION_KEYS.has("billing:promotions:view")).toBe(true);
    expect(PLATFORM_ONLY_PERMISSION_KEYS.has("billing:promotions:manage")).toBe(true);
  });

  it("an org owner's resolved permission map does NOT contain platform-only keys (allCatalogScopes excludes them)", async () => {
    const resolver = new AccessPermissionResolver(
      () => ({ query: {}, select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }), innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }) }) }) }) }) as unknown as Db,
      (read) => read() as Promise<never>,
      new Set<string>(),
      new Map(),
      1000,
      memberRowReader({ isOwner: true, status: "ACTIVE", id: 1, role: "OWNER" }),
    );

    const { perms } = await resolver.computeUserPermissions("org-owner", "u-owner", 1);

    for (const key of PLATFORM_ONLY_PERMISSION_KEYS) {
      expect({ key, scope: perms[key] }).toMatchObject({ key, scope: undefined });
    }
  });

  it("the test is not vacuous — the org owner DOES hold ordinary billing keys like billing:subscription:view", async () => {
    const resolver = new AccessPermissionResolver(
      () => ({ query: {}, select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }), innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }) }) }) }) }) as unknown as Db,
      (read) => read() as Promise<never>,
      new Set<string>(),
      new Map(),
      1000,
      memberRowReader({ isOwner: true, status: "ACTIVE", id: 1, role: "OWNER" }),
    );

    const { perms } = await resolver.computeUserPermissions("org-owner", "u-owner", 1);
    expect(perms["billing:subscription:view"]).toBe("all");
  });

  it("authorize() returns FORBIDDEN for an org owner requesting blog:posts:manage — scopeFor returns none (not in catalog grants)", async () => {
    // allCatalogScopes() skips platform-only keys, so scopeFor returns "none" for blog:posts:manage.
    // The test proves the guard bites: it is not a vacuous 404 from a missing route.
    const actor = makeActor({ isOrgOwner: true });
    const ctx = zeroModuleCtx(actor);

    // A resolver that mimics allCatalogScopes() (org owner path): returns "all" for ordinary keys
    // but "none" for platform-only keys, because they were excluded from the map.
    const result = await authorize(
      {
        scopeFor: async (_u, key) =>
          PLATFORM_ONLY_PERMISSION_KEYS.has(key) ? "none" : "all",
      },
      ctx,
      "blog:posts:manage",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("'billing:promotions' namespace is not plan-gated (it is in PLATFORM_ONLY, not the org module catalog)", () => {
    // isCoreModuleKey("billing") is true (billing is not plan-gated — it is always available
    // to the org). The platform-only GUARD is through PLATFORM_ONLY_PERMISSION_KEYS in
    // allCatalogScopes() and isPlatformOnlyPermission(). A route gated on billing:promotions:manage
    // would pass the module-availability check but fail at scopeFor returning "none".
    expect(isCoreModuleKey("billing")).toBe(true);
    expect(PLATFORM_ONLY_PERMISSION_KEYS.has("billing:promotions:manage")).toBe(true);
  });

  it("Note: INTERNAL_API_SECRET requirement for /platform/* routes is a separate guard layer. " +
     "This spec proves the PERMISSION-CATALOG layer only.", () => {
    expect(true).toBe(true); // documented; live HTTP evidence required to close the INTERNAL_API_SECRET path
  });
});
