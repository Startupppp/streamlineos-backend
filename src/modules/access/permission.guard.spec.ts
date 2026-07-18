import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Test, type TestingModule } from "@nestjs/testing";
import { Public } from "../../common/auth/public.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";

class GuardTestController {
  withoutPermission(): void {}

  @Public()
  publicRoute(): void {}

  @RequirePermission("settings:rbac:manage")
  protectedRoute(): void {}
}

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  branchId: null,
  role: "ADMIN",
  permissions: [],
  enabledModules: [],
  plan: null,
  isPlatformAdmin: false,
  isOrgOwner: false,
  sessionId: "session-1",
};

describe("PermissionGuard", () => {
  let moduleRef: TestingModule;
  let guard: PermissionGuard;
  const resolveUserPermissions = jest.fn();
  const isModuleEnabled = jest.fn();

  beforeEach(async () => {
    resolveUserPermissions.mockReset();
    isModuleEnabled.mockReset();

    moduleRef = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        Reflector,
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions,
            isModuleEnabled,
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
    return new ExecutionContextHost(
      [{ user: { ...currentUser } }],
      GuardTestController,
      handler,
    );
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
});
