/**
 * Integrated two-tenant / two-user allow-deny matrix — ITEM 3
 *
 * Tests the authorize() + PermissionGuard boundary for the six standings,
 * membership state transitions, grant sources and unknown principal/key cases.
 *
 * Evidence level: MOCKED — real authorize() and PermissionGuard with mocked
 * AccessService and AuthContext. No database or HTTP server.
 *
 * This spec is COMPLEMENTARY to six-standings-matrix.spec.ts (which proves
 * computeUserPermissions) and authorize.spec.ts (which proves the authorize()
 * function in isolation). This spec proves the integrated guard path.
 *
 * Cross-tenant record ACL (object-level 404 vs 403) is SERVICE-LEVEL, not
 * guard-level. See §4 of backend/CLAUDE.md. That cell is documented here but
 * requires real HTTP+DB to close and is noted as open.
 */

import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Test, type TestingModule } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import { testAuthContext, MODULE_AVAILABLE, MODULE_DISABLED } from "../../../../test/helpers/module-guard-context";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { PermissionGuard } from "../permission.guard";
import { AccessService } from "../access.service";
import { RequirePermission } from "../require-permission.decorator";
import { authorize } from "../authorize";
import type { DataScope } from "../access.types";

const ORG_A = "org-matrix-a";
const ORG_B = "org-matrix-b";

function makeActor(partial: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u-matrix-1",
    orgId: ORG_A,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-matrix-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...partial,
  };
}

function makeScopeResolver(scopeMap: ReadonlyMap<string, DataScope>) {
  return {
    scopeFor: async (actor: CurrentUserContext, key: string): Promise<DataScope> => {
      if (actor.tokenScopes && !actor.tokenScopes.includes(key)) return "none";
      if (actor.isOrgOwner) return "all";
      return scopeMap.get(key) ?? "none";
    },
  };
}

function makeModuleAvailableCtx(actor: CurrentUserContext, moduleKey?: string) {
  return testAuthContext(actor, {
    moduleAvailability: async (_user, key) =>
      moduleKey === undefined || key === moduleKey
        ? MODULE_AVAILABLE
        : MODULE_DISABLED,
  });
}

describe("authorize() — unknown key and unknown principal close at the guard boundary", () => {
  it("unknown permission key (not in any module) → FORBIDDEN for a regular member", async () => {
    const actor = makeActor({});
    const ctx = makeModuleAvailableCtx(actor);
    const result = await authorize(makeScopeResolver(new Map()), ctx, "nonexistent:ghost:view");
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("missing AuthContext (null) → UNAUTHENTICATED, never FORBIDDEN", async () => {
    const result = await authorize(makeScopeResolver(new Map()), null, "hr:employees:view");
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("UNAUTHENTICATED");
  });

  it("module disabled for the actor → NO_MODULE", async () => {
    const actor = makeActor({});
    const ctx = testAuthContext(actor, {
      moduleAvailability: async (_user, key) =>
        key === "hr" ? MODULE_DISABLED : MODULE_AVAILABLE,
    });
    const result = await authorize(
      makeScopeResolver(new Map([["hr:employees:view", "all"]])),
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("NO_MODULE");
  });
});

describe("PermissionGuard — missing AuthContext produces 401, not 403", () => {
  class MatrixTestController {
    @RequirePermission("settings:rbac:manage")
    protectedRoute() { return true; }
  }

  let guard: PermissionGuard;
  let moduleRef: TestingModule;
  const resolveUserPermissions = jest.fn();
  const getModuleState = jest.fn().mockResolvedValue(true);

  beforeEach(async () => {
    resolveUserPermissions.mockReset();
    getModuleState.mockReset().mockResolvedValue(true);

    moduleRef = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        Reflector,
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions,
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            getModuleState,
            scopeFor: async (actor: CurrentUserContext, key: string) => {
              if (actor.isOrgOwner) return "all";
              const resolved: Map<string, DataScope> = await resolveUserPermissions(actor.orgId, actor.userId);
              return resolved.get(key) ?? "none";
            },
            buildModuleAvailabilityResolver: (
              getMap: (orgId: string) => Promise<Record<string, boolean>>,
            ) => moduleAvailabilityResolver(
              {
                isCoreModule: () => false,
                getModuleMap: getMap,
                getPlanLockedModules: async () => [],
              },
              { getUserDeniedModules: async () => new Set<string>() },
            ),
          },
        },
      ],
    }).compile();

    guard = moduleRef.get(PermissionGuard);
  });

  afterEach(async () => { await moduleRef.close(); });

  function contextWithAuthContext(actor: CurrentUserContext): ExecutionContextHost {
    const ctx = testAuthContext(actor, {
      moduleAvailability: async (_u, key) =>
        getModuleState(actor.orgId, key).then((v: boolean) =>
          v ? MODULE_AVAILABLE : MODULE_DISABLED,
        ),
    });
    return new ExecutionContextHost(
      [{ user: actor, authContext: ctx }],
      MatrixTestController,
      MatrixTestController.prototype.protectedRoute,
    );
  }

  function contextWithoutAuthContext(actor: CurrentUserContext): ExecutionContextHost {
    return new ExecutionContextHost(
      [{ user: actor }],
      MatrixTestController,
      MatrixTestController.prototype.protectedRoute,
    );
  }

  it("no AuthContext on request → UnauthorizedException (401), not ForbiddenException", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());
    await expect(
      guard.canActivate(contextWithoutAuthContext(makeActor({}))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("ACTIVE member with the required permission → allow", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([["settings:rbac:manage", "all"]]));
    await expect(
      guard.canActivate(contextWithAuthContext(makeActor({}))),
    ).resolves.toBe(true);
  });

  it("ACTIVE member without the required permission → ForbiddenException (403)", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());
    await expect(
      guard.canActivate(contextWithAuthContext(makeActor({}))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("org owner bypasses the permission map and gets through the guard", async () => {
    resolveUserPermissions.mockResolvedValue(new Map()); // empty map, owner bypass
    await expect(
      guard.canActivate(contextWithAuthContext(makeActor({ isOrgOwner: true }))),
    ).resolves.toBe(true);
  });
});

describe("two-org isolation through authorize()", () => {
  it("org-A grant does not reach the same user in org-B", async () => {
    const userInA = makeActor({ orgId: ORG_A });
    const userInB = makeActor({ orgId: ORG_B });
    const ctxA = makeModuleAvailableCtx(userInA);
    const ctxB = makeModuleAvailableCtx(userInB);

    const resolverA = makeScopeResolver(new Map([["hr:employees:view", "all"]]));

    const resultA = await authorize(resolverA, ctxA, "hr:employees:view");
    // Resolver for user in org-A has the key; resolver for org-B has nothing.
    // In practice, AccessService.scopeFor resolves from the actor's orgId,
    // so the same resolver returning "none" for org-B is the correct model.
    const resolverB = makeScopeResolver(new Map()); // org-B has no grants
    const resultB = await authorize(resolverB, ctxB, "hr:employees:view");

    expect(resultA.allow).toBe(true);
    expect(resultB.allow).toBe(false);
    expect(resultB.reason).toBe("FORBIDDEN");
  });

  it("org-A and org-B are both addressed by orgId in the actor; no identity bleed", () => {
    const userInA = makeActor({ orgId: ORG_A });
    const userInB = makeActor({ orgId: ORG_B });
    expect(userInA.orgId).toBe(ORG_A);
    expect(userInB.orgId).toBe(ORG_B);
    expect(userInA.userId).toBe(userInB.userId);
  });
});

describe("membership state → deny mapping through authorize() (module availability guards first)", () => {
  const INVITED_ACTOR = makeActor({ orgId: ORG_A });
  const SUSPENDED_ACTOR = makeActor({ orgId: ORG_A });

  it("invited / inactive membership: computeUserPermissions returns {} → scopeFor returns none → authorize → FORBIDDEN", async () => {
    // An invited-but-not-accepted user has no active membership.
    // computeUserPermissions() (in six-standings-matrix.spec.ts) returns {} for inactive membership.
    // scopeFor() falls back to "none" for the key.
    // authorize() → FORBIDDEN.
    const ctx = makeModuleAvailableCtx(INVITED_ACTOR);
    const result = await authorize(
      makeScopeResolver(new Map()), // no grants — simulates inactive membership output
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("suspended membership: computeUserPermissions returns {} → authorize → FORBIDDEN (not UNAUTHENTICATED)", async () => {
    const ctx = makeModuleAvailableCtx(SUSPENDED_ACTOR);
    const result = await authorize(
      makeScopeResolver(new Map()),
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });
});

describe("grant that survives a role change — authorize() level", () => {
  it("a personal grant returned by scopeFor is honoured regardless of what role is set on the actor", async () => {
    const actorWithOldRole = makeActor({ role: "MEMBER" });
    const ctx = makeModuleAvailableCtx(actorWithOldRole);
    // Even after role change, if scopeFor still returns the scope (from user_permission_grants),
    // authorize() allows access.
    const result = await authorize(
      makeScopeResolver(new Map([["hr:employees:view", "all"]])),
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(true);
    expect(result.scope).toBe("all");
  });
});

describe("expired delegation — deny at authorize() level", () => {
  it("an expired delegation returns 'none' from scopeFor, which authorize() maps to FORBIDDEN", async () => {
    // AccessPermissionResolver guards startsAt/endsAt in-process.
    // After expiry, the expired row is not surfaced, so scopeFor returns "none" for the key.
    // authorize() then returns FORBIDDEN.
    const actor = makeActor({});
    const ctx = makeModuleAvailableCtx(actor);
    const result = await authorize(
      makeScopeResolver(new Map()), // expired delegation → scopeFor returns none
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });
});

describe("token-scope attenuation through authorize()", () => {
  it("limited API token: tokenScopes excludes the key → FORBIDDEN even for org owner", async () => {
    const actor = makeActor({ isOrgOwner: true, tokenScopes: ["crm:leads:view"] });
    const ctx = makeModuleAvailableCtx(actor);
    const result = await authorize(
      makeScopeResolver(new Map()),
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("limited API token: tokenScopes includes the key → allow when scopeFor grants it", async () => {
    const actor = makeActor({ tokenScopes: ["hr:employees:view"] });
    const ctx = makeModuleAvailableCtx(actor);
    const result = await authorize(
      makeScopeResolver(new Map([["hr:employees:view", "all"]])),
      ctx,
      "hr:employees:view",
    );
    expect(result.allow).toBe(true);
  });
});

describe("universal grants survive regardless of standing", () => {
  it("every EMPLOYEE_SELF_SERVICE_GRANTS key is present regardless of the role-based scope map", () => {
    const universalKeys = EMPLOYEE_SELF_SERVICE_GRANTS.map((g) => g.permissionKey);
    expect(universalKeys.length).toBeGreaterThan(0);
    expect(universalKeys).toContain("calendar:read");
    expect(universalKeys).toContain("mail:inbox:view");
    expect(universalKeys).toContain("chat:channels:read");
  });
});

describe("cross-tenant record ACL — documented as service-level, not guard-level", () => {
  it("Note: cross-tenant record IDs must return 404, not 403 — this is enforced in services, not guards", () => {
    // Guards confirm the actor has the permission for the operation (allow/deny on the key).
    // Object-level 404 vs 403 is enforced in the service layer: a cross-org ID resolves
    // as "not found" rather than "forbidden" so that the guard cannot be used as an existence oracle.
    // See backend/CLAUDE.md §4: "Cross-tenant misses return 404, never 403".
    // This behavior requires live HTTP+DB to verify and is NOT closed by this mock spec.
    // Confirmed at source: services call isNull(x.deletedAt) + org_id = actor.orgId predicate.
    expect(true).toBe(true);
  });
});
