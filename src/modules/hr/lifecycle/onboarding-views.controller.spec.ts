import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { OnboardingViewsController } from "./onboarding-views.controller";
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

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("OnboardingViewsController — self-service, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — employment documents are platform-core per CLAUDE.md §8", () => {
    expect(reflector.get(REQUIRE_MODULE, OnboardingViewsController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const disabledGuard = new ModuleGuard(
      new Reflector(),
      {
        moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
      } as unknown as AccessService,
    );

    it("GET /hr/onboarding-docs/me (listMine) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(OnboardingViewsController, "listMine", memberUser)),
      ).resolves.toBe(true);
    });

    it("POST /hr/onboarding-docs/me (createMine) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(OnboardingViewsController, "createMine", memberUser)),
      ).resolves.toBe(true);
    });

    it("GET /hr/onboarding-docs/me/:docId/file (getMyFile) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(OnboardingViewsController, "getMyFile", memberUser)),
      ).resolves.toBe(true);
    });
  });

  describe("bite proof — adding @RequireModule would cause all three tests above to fail", () => {
    it("ModuleGuard throws when @RequireModule is set (proves the above tests are load-bearing)", async () => {
      const reflectorWithGate = new Reflector();
      const gatedGuard = new ModuleGuard(
        reflectorWithGate,
        {
          moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
        } as unknown as AccessService,
      );
      const fakeClass = class FakeGatedController {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const handler = () => undefined;
      const ctx: ExecutionContext = {
        getHandler: () => handler,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => ({ user: memberUser }) }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow();
    });
  });
});
