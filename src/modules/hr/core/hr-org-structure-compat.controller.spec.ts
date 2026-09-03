import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrOrgStructureCompatController } from "./hr-org-structure-compat.controller";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeGuardCtx(
  ctrl: Function,
  methodName: string,
  user: Partial<CurrentUserContext>,
): ExecutionContext {
  const handler = (ctrl.prototype as Record<string, unknown>)[methodName] as Function;
  return {
    getHandler: () => handler,
    getClass: () => ctrl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const orgAdminUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrOrgStructureCompatController — settings namespace, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — org structure (locations, teams) is a global resource used by all modules, not HR-specific", () => {
    expect(reflector.get(REQUIRE_MODULE, HrOrgStructureCompatController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const disabledGuard = new ModuleGuard(
      new Reflector(),
      {
        moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
      } as unknown as AccessService,
    );

    it("GET /hr/org/locations (listLocations) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(HrOrgStructureCompatController, "listLocations", orgAdminUser)),
      ).resolves.toBe(true);
    });

    it("GET /hr/org/teams (listTeams) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(HrOrgStructureCompatController, "listTeams", orgAdminUser)),
      ).resolves.toBe(true);
    });

    it("POST /hr/org/locations (createLocation) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(HrOrgStructureCompatController, "createLocation", orgAdminUser)),
      ).resolves.toBe(true);
    });
  });

  describe("bite proof — adding @RequireModule would block org-wide structure management", () => {
    it("ModuleGuard blocks when @RequireModule(hr) is set on a gated class", async () => {
      const gatedGuard = new ModuleGuard(
        new Reflector(),
        {
          moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
        } as unknown as AccessService,
      );
      const fakeClass = class FakeGated {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const ctx: ExecutionContext = {
        getHandler: () => () => undefined,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => ({ user: orgAdminUser }) }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);
    });
  });
});
