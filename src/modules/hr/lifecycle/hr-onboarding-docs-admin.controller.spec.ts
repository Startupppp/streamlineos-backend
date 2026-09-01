import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrOnboardingDocsAdminController } from "./hr-onboarding-docs-admin.controller";
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

function makeAccessSvc(available: boolean): AccessService {
  return {
    moduleAvailability: jest.fn().mockResolvedValue(
      available ? { available: true } : { available: false, reason: "org-disabled" },
    ),
  } as unknown as AccessService;
}

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrOnboardingDocsAdminController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, HrOnboardingDocsAdminController)).toBe("hr");
  });

  describe("HR module DISABLED — all admin handlers refused", () => {
    it("GET /hr/onboarding-docs/summary is blocked", async () => {
      const guard = new ModuleGuard(reflector, makeAccessSvc(false));
      await expect(
        guard.canActivate(makeGuardCtx(HrOnboardingDocsAdminController, "summary", memberUser)),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("GET /hr/onboarding-docs (list) is blocked", async () => {
      const guard = new ModuleGuard(reflector, makeAccessSvc(false));
      await expect(
        guard.canActivate(makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser)),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /hr/onboarding-docs (create) is blocked", async () => {
      const guard = new ModuleGuard(reflector, makeAccessSvc(false));
      await expect(
        guard.canActivate(makeGuardCtx(HrOnboardingDocsAdminController, "create", memberUser)),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("PATCH /hr/onboarding-docs/:docId (review) is blocked", async () => {
      const guard = new ModuleGuard(reflector, makeAccessSvc(false));
      await expect(
        guard.canActivate(makeGuardCtx(HrOnboardingDocsAdminController, "review", memberUser)),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("list handler passes (proving gate is the only blocker)", async () => {
      const guard = new ModuleGuard(reflector, makeAccessSvc(true));
      await expect(
        guard.canActivate(makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser)),
      ).resolves.toBe(true);
    });
  });
});
