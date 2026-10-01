import { testAuthContext } from "../../../test/helpers/module-guard-context";
import {
  ForbiddenException,
  HttpException,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Test, type TestingModule } from "@nestjs/testing";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import { CATALOG_KEY_SET } from "./access-policy";
import { Public } from "../../common/auth/public.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../../common/rbac/data-scope";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";
import { REQUIRE_PERMISSION, RequirePermission } from "./require-permission.decorator";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";

const GATED_KEY = "settings:rbac:manage";
const UNCATALOGUED_KEY = "nosuchmodule:nosuchresource:view";
const TS_ENTRIES = "timesheets:entries:view";
const TS_TEAM = "timesheets:team:view";
const TS_APPROVALS = "timesheets:approvals:view";
const BILLING_KEY = "billing:subscription:view";

class GuardTestController {
  withoutPermission(): void {}

  @Public()
  publicRoute(): void {}

  @RequirePermission("settings:rbac:manage")
  protectedRoute(): void {}

  @Public()
  @RequirePermission("settings:rbac:manage")
  publicAuthenticationRoute(): void {}

  @SetMetadata(REQUIRE_PERMISSION, UNCATALOGUED_KEY)
  uncataloguedKeyRoute(): void {}

  @RequirePermission(TS_ENTRIES, TS_TEAM, TS_APPROVALS)
  anyOfThreeRoute(): void {}

  @RequirePermission(TS_ENTRIES, GATED_KEY)
  crossNamespaceRoute(): void {}

  @RequirePermission(BILLING_KEY, GATED_KEY)
  billingOrSettingsRoute(): void {}

  @SetMetadata(REQUIRE_PERMISSION, [UNCATALOGUED_KEY, "alsonosuch:ghost:view"])
  onlyTyposRoute(): void {}
}

/** A hand-set empty list. The decorator's tuple makes `@RequirePermission()` a compile error, but metadata is also settable directly. */
function handlerWithNoKeys(): (() => void) {
  const handler = function emptyKeyList(): void {};
  Reflect.defineMetadata(REQUIRE_PERMISSION, [], handler);
  return handler;
}

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

describe("PermissionGuard", () => {
  let moduleRef: TestingModule;
  let guard: PermissionGuard;
  const resolveUserPermissions = jest.fn();
  const isModuleEnabled = jest.fn();
  const getModuleState = jest.fn();

  beforeEach(async () => {
    resolveUserPermissions.mockReset();
    isModuleEnabled.mockReset();
    getModuleState.mockReset().mockResolvedValue(true);

    moduleRef = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        Reflector,
        {
          provide: DiscoveryService,
          useValue: { getControllers: () => [] },
        },
        {
          provide: MetadataScanner,
          useValue: { getAllMethodNames: () => [] },
        },
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions,
            isModuleEnabled,
            getModuleState,
            scopeFor: async (currentUser: CurrentUserContext, key: string) => {
              if (currentUser.isOrgOwner) return "all";
              return (await resolveUserPermissions(currentUser.orgId, currentUser.userId)).get(key) ?? "none";
            },
            buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) => moduleAvailabilityResolver(
              {
                isCoreModule: () => false,
                getModuleMap,
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

  afterEach(async () => {
    await moduleRef.close();
  });

  function contextFor(
    handler: GuardTestController[keyof GuardTestController],
    currentUser: CurrentUserContext = user,
  ): ExecutionContextHost {
    const actor = { ...currentUser };
    const authContext = testAuthContext(actor, {
      moduleAvailability: async (_actor, moduleKey) =>
        (await getModuleState(actor.orgId, moduleKey)) === false
          ? { available: false, reason: "org-disabled" }
          : { available: true },
    });
    return new ExecutionContextHost(
      [{ user: actor, authContext }],
      GuardTestController,
      handler,
    );
  }

  interface GuardRequest {
    user: CurrentUserContext;
    rbacScope?: DataScope;
  }

  function requestContextFor(
    handler: GuardTestController[keyof GuardTestController],
    currentUser: CurrentUserContext = user,
  ): { request: GuardRequest; context: ExecutionContextHost } {
    const actor = { ...currentUser };
    const authContext = testAuthContext(actor, {
      moduleAvailability: async (_actor, moduleKey) =>
        (await getModuleState(actor.orgId, moduleKey)) === false
          ? { available: false, reason: "org-disabled" }
          : { available: true },
    });
    const request: GuardRequest = { user: actor, rbacScope: undefined };
    Object.assign(request, { authContext });
    return {
      request,
      context: new ExecutionContextHost([request], GuardTestController, handler),
    };
  }

  function contextWithoutAuthContext(
    handler: GuardTestController[keyof GuardTestController],
    currentUser: CurrentUserContext = user,
  ): ExecutionContextHost {
    return new ExecutionContextHost(
      [{ user: { ...currentUser } }],
      GuardTestController,
      handler,
    );
  }

  async function denialStatus(decision: Promise<boolean>): Promise<number> {
    try {
      await decision;
    } catch (error: unknown) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
    throw new Error("expected the guard to deny, but it allowed the request");
  }

  it("denies guarded handlers without permission metadata", async () => {
    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.withoutPermission)),
    ).rejects.toThrow(new ForbiddenException("Permission denied"));
    expect(resolveUserPermissions).not.toHaveBeenCalled();
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });

  it("allows explicitly public handlers without resolving permissions", async () => {
    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.publicRoute)),
    ).resolves.toBe(true);
    expect(resolveUserPermissions).not.toHaveBeenCalled();
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });

  it("allows handlers when the required permission is granted", async () => {
    resolveUserPermissions.mockResolvedValue(
      new Map([["settings:rbac:manage", "all"]]),
    );

    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
    ).resolves.toBe(true);
  });

  it("denies handlers when the required permission is absent", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());

    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
    ).rejects.toThrow(new ForbiddenException("Permission denied"));
  });

  it("does not let public authentication metadata bypass an explicit permission", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());

    await expect(
      guard.canActivate(
        contextFor(GuardTestController.prototype.publicAuthenticationRoute),
      ),
    ).rejects.toThrow(new ForbiddenException("Permission denied"));
  });

  it("does not apply the owner bypass without explicit permission metadata", async () => {
    await expect(
      guard.canActivate(
        contextFor(GuardTestController.prototype.withoutPermission, {
          ...user,
          isOrgOwner: true,
        }),
      ),
    ).rejects.toThrow(new ForbiddenException("Permission denied"));
  });

  it("preserves the owner bypass after explicit permission metadata", async () => {
    await expect(
      guard.canActivate(
        contextFor(GuardTestController.prototype.protectedRoute, {
          ...user,
          isOrgOwner: true,
        }),
      ),
    ).resolves.toBe(true);
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("denies a route whose required key is absent from the backend catalog, even for a caller who holds real keys", async () => {
    expect(CATALOG_KEY_SET.has(UNCATALOGUED_KEY)).toBe(false);
    expect(CATALOG_KEY_SET.has(GATED_KEY)).toBe(true);
    resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

    await expect(
      guard.canActivate(
        contextFor(GuardTestController.prototype.uncataloguedKeyRoute),
      ),
    ).rejects.toThrow(new ForbiddenException("Permission denied"));

    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
    ).resolves.toBe(true);
  });

  it("throws UnauthorizedException, never a permission denial, when the request carries no AuthContext", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

    await expect(
      guard.canActivate(
        contextWithoutAuthContext(GuardTestController.prototype.protectedRoute),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      await denialStatus(
        guard.canActivate(
          contextWithoutAuthContext(
            GuardTestController.prototype.protectedRoute,
          ),
        ),
      ),
    ).toBe(401);
    expect(resolveUserPermissions).not.toHaveBeenCalled();

    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
    ).resolves.toBe(true);
  });

  it("answers a disabled module with ModuleDisabledException (402), not a permission denial", async () => {
    getModuleState.mockResolvedValue(false);
    resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

    const decision = guard.canActivate(
      contextFor(GuardTestController.prototype.protectedRoute),
    );
    await expect(decision).rejects.toBeInstanceOf(ModuleDisabledException);
    expect(
      await denialStatus(
        guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
      ),
    ).toBe(402);
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("answers a plain denial on an enabled module with ForbiddenException (403), so 402 and 403 cannot collapse into one", async () => {
    getModuleState.mockResolvedValue(true);
    resolveUserPermissions.mockResolvedValue(new Map());

    const decision = guard.canActivate(
      contextFor(GuardTestController.prototype.protectedRoute),
    );
    await expect(decision).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
    ).rejects.not.toBeInstanceOf(ModuleDisabledException);
    expect(
      await denialStatus(
        guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
      ),
    ).toBe(403);
    expect(resolveUserPermissions).toHaveBeenCalled();
  });

  describe("a route naming several keys — the caller needs any one of them", () => {
    it("admits a manager who holds only timesheets:team:view", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[TS_TEAM, "team"]]));

      await expect(
        guard.canActivate(contextFor(GuardTestController.prototype.anyOfThreeRoute)),
      ).resolves.toBe(true);
    });

    it("admits an approver who holds only timesheets:approvals:view", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[TS_APPROVALS, "own"]]));

      await expect(
        guard.canActivate(contextFor(GuardTestController.prototype.anyOfThreeRoute)),
      ).resolves.toBe(true);
    });

    it("admits an employee who holds only timesheets:entries:view", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[TS_ENTRIES, "own"]]));

      await expect(
        guard.canActivate(contextFor(GuardTestController.prototype.anyOfThreeRoute)),
      ).resolves.toBe(true);
    });

    it("refuses with 403 a caller holding none of the three, even while holding other real keys", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

      expect(
        await denialStatus(
          guard.canActivate(contextFor(GuardTestController.prototype.anyOfThreeRoute)),
        ),
      ).toBe(403);
    });

    it("refuses a route whose every key is a typo, so a misspelling cannot open a surface", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

      expect(
        await denialStatus(
          guard.canActivate(contextFor(GuardTestController.prototype.onlyTyposRoute)),
        ),
      ).toBe(403);
    });

    it("refuses an empty key list rather than reading it as no declaration at all", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

      expect(
        await denialStatus(guard.canActivate(contextFor(handlerWithNoKeys()))),
      ).toBe(403);
    });

    it("puts the BROADEST allowing scope in req.rbacScope, so a BE-113 consumer is not silently narrowed", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([
          [TS_ENTRIES, "own"],
          [TS_TEAM, "team"],
          [TS_APPROVALS, "own"],
        ]),
      );

      const { request, context } = requestContextFor(
        GuardTestController.prototype.anyOfThreeRoute,
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.rbacScope).toBe("team");
    });

    it("still reports a single-key route's own scope unchanged", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "own"]]));

      const { request, context } = requestContextFor(
        GuardTestController.prototype.protectedRoute,
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.rbacScope).toBe("own");
    });

    it("answers 401 when no AuthContext is attached, outranking every module and permission denial", async () => {
      getModuleState.mockResolvedValue(false);
      resolveUserPermissions.mockResolvedValue(new Map());

      expect(
        await denialStatus(
          guard.canActivate(
            contextWithoutAuthContext(GuardTestController.prototype.anyOfThreeRoute),
          ),
        ),
      ).toBe(401);
    });

    it("answers 402 for a disabled module even when the other key is merely unheld, never collapsing BE-23 into a 403", async () => {
      getModuleState.mockImplementation(async (_orgId: string, moduleKey: string) =>
        moduleKey !== "timesheets",
      );
      resolveUserPermissions.mockResolvedValue(new Map());

      const decision = guard.canActivate(
        contextFor(GuardTestController.prototype.crossNamespaceRoute),
      );
      await expect(decision).rejects.toBeInstanceOf(ModuleDisabledException);
      expect(
        await denialStatus(
          guard.canActivate(contextFor(GuardTestController.prototype.crossNamespaceRoute)),
        ),
      ).toBe(402);
    });

    it("names the FIRST declared key's module in the 402 when both namespaces are off", async () => {
      getModuleState.mockResolvedValue(false);
      resolveUserPermissions.mockResolvedValue(new Map());

      try {
        await guard.canActivate(
          contextFor(GuardTestController.prototype.crossNamespaceRoute),
        );
        throw new Error("expected the guard to deny");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ModuleDisabledException);
        if (!(error instanceof ModuleDisabledException)) throw error;
        const body: unknown = error.getResponse();
        expect(Reflect.get(Object(Reflect.get(Object(body), "details")), "moduleKey")).toBe(
          "timesheets",
        );
      }
    });

    it("refuses an impersonated caller admitted by the NON-billing key, so an OR is no way into billing", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

      await expect(
        guard.canActivate(
          contextFor(GuardTestController.prototype.billingOrSettingsRoute, {
            ...user,
            impersonation: {
              realActorUserId: "operator-1",
              realSessionId: "session-op",
              impersonationSessionId: "imp-1",
            },
          }),
        ),
      ).rejects.toThrow(
        new ForbiddenException("Billing actions are not available during impersonation"),
      );
    });

    it("admits that same caller when they are not impersonating", async () => {
      resolveUserPermissions.mockResolvedValue(new Map([[GATED_KEY, "all"]]));

      await expect(
        guard.canActivate(
          contextFor(GuardTestController.prototype.billingOrSettingsRoute),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("single-key routes are behaviourally untouched", () => {
    it("stores a bare string, not an array, so every metadata consumer reads what it read before", () => {
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION, GuardTestController.prototype.protectedRoute),
      ).toBe(GATED_KEY);
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION, GuardTestController.prototype.anyOfThreeRoute),
      ).toEqual([TS_ENTRIES, TS_TEAM, TS_APPROVALS]);
    });

    it("still refuses a principal who lacks the one key, however many other keys they hold", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([
          [TS_ENTRIES, "all"],
          [TS_TEAM, "all"],
          [TS_APPROVALS, "all"],
        ]),
      );

      expect(
        await denialStatus(
          guard.canActivate(contextFor(GuardTestController.prototype.protectedRoute)),
        ),
      ).toBe(403);
    });
  });
});
