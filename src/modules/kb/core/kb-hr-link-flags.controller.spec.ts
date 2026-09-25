import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Test, type TestingModule } from "@nestjs/testing";
import { testAuthContext } from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { KbHrLinkFlagsController } from "./kb-hr-link-flags.controller";
import type { KbHrLinkFlagsService } from "./kb-hr-link-flags.service";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-flags",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const EFFECTIVE = { link: true, search: false, ai: false };
const ADMIN_VIEW = { stored: EFFECTIVE, effective: EFFECTIVE, hrModuleEnabled: true };

describe("KbHrLinkFlagsController authorisation", () => {
  let moduleRef: TestingModule;
  let guard: PermissionGuard;
  let controller: KbHrLinkFlagsController;
  const resolveUserPermissions = jest.fn();
  const flags = {
    getEffective: jest.fn(),
    getAdmin: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    resolveUserPermissions.mockReset();
    flags.getEffective.mockReset().mockResolvedValue(EFFECTIVE);
    flags.getAdmin.mockReset().mockResolvedValue(ADMIN_VIEW);
    flags.update.mockReset().mockResolvedValue(ADMIN_VIEW);
    moduleRef = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        Reflector,
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions,
            getModuleState: async () => true,
            scopeFor: async (currentUser: CurrentUserContext, key: string) =>
              (await resolveUserPermissions(currentUser.orgId, currentUser.userId)).get(key) ?? "none",
            buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
              moduleAvailabilityResolver(
                { isCoreModule: () => false, getModuleMap, getPlanLockedModules: async () => [] },
                { getUserDeniedModules: async () => new Set<string>() },
              ),
          },
        },
      ],
    }).compile();
    guard = moduleRef.get(PermissionGuard);
    controller = new KbHrLinkFlagsController(flags as unknown as KbHrLinkFlagsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  function contextFor(handler: (...args: never[]) => unknown): ExecutionContextHost {
    const actor = { ...user };
    const authContext = testAuthContext(actor, {
      moduleAvailability: async () => ({ available: true }),
    });
    return new ExecutionContextHost([{ user: actor, authContext }], KbHrLinkFlagsController, handler);
  }

  it.each([
    ["GET /kb/hr-link/config", "kb:pages:view", KbHrLinkFlagsController.prototype.config],
    ["GET /kb/settings/hr-link-flags", "kb:settings:manage", KbHrLinkFlagsController.prototype.getAdmin],
    ["PATCH /kb/settings/hr-link-flags", "kb:settings:manage", KbHrLinkFlagsController.prototype.update],
  ])("%s requires %s, and the guard refuses a caller without it", async (_route, key, handler) => {
    expect(new Reflector().get(REQUIRE_PERMISSION, handler)).toBe(key);
    resolveUserPermissions.mockResolvedValue(new Map());

    await expect(guard.canActivate(contextFor(handler))).rejects.toThrow(ForbiddenException);
  });

  it("does not let the member key stand in for the admin key", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([["kb:pages:view", "all"]]));

    await expect(guard.canActivate(contextFor(KbHrLinkFlagsController.prototype.getAdmin))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(contextFor(KbHrLinkFlagsController.prototype.update))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("lets a member read the effective switches, scoped to their own organisation", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([["kb:pages:view", "all"]]));

    await expect(guard.canActivate(contextFor(KbHrLinkFlagsController.prototype.config))).resolves.toBe(true);
    await expect(controller.config(user)).resolves.toEqual(EFFECTIVE);
    expect(flags.getEffective).toHaveBeenCalledWith("org-flags");
  });

  it("lets an administrator read and change the stored switches, acting as themselves in their own organisation", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([["kb:settings:manage", "all"]]));

    await expect(guard.canActivate(contextFor(KbHrLinkFlagsController.prototype.update))).resolves.toBe(true);
    await expect(controller.getAdmin(user)).resolves.toEqual(ADMIN_VIEW);
    await expect(controller.update({ link: true }, user)).resolves.toEqual(ADMIN_VIEW);
    expect(flags.getAdmin).toHaveBeenCalledWith("org-flags");
    expect(flags.update).toHaveBeenCalledWith(user, { link: true });
  });
});
