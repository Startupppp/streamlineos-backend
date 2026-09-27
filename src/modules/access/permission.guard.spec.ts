import { testAuthContext } from "../../../test/helpers/module-guard-context";
import {
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Test, type TestingModule } from "@nestjs/testing";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import { CATALOG_KEY_SET } from "./access-policy";
import { Public } from "../../common/auth/public.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";

const GATED_KEY = "settings:rbac:manage";
const UNCATALOGUED_KEY = "nosuchmodule:nosuchresource:view";

class GuardTestController {
  withoutPermission(): void {}

  @Public()
  publicRoute(): void {}

  @RequirePermission("settings:rbac:manage")
  protectedRoute(): void {}

  @Public()
  @RequirePermission("settings:rbac:manage")
  publicAuthenticationRoute(): void {}

  @RequirePermission(UNCATALOGUED_KEY)
  uncataloguedKeyRoute(): void {}
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
});
