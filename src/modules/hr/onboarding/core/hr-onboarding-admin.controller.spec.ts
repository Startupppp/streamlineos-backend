import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../../common/rbac/require-module.decorator";
import { HrOnboardingAdminController } from "./hr-onboarding-admin.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrOnboardingAdminController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, HrOnboardingAdminController)).toBe("hr");
  });

  describe("HR module DISABLED — all administration handlers refused", () => {
    it("GET /onboarding (getProgress) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "getProgress", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /onboarding (initiate) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "initiate", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("GET /onboarding/templates (listTemplates) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "listTemplates", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /onboarding/reminders (sendReminders) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "sendReminders", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("GET /onboarding/:userId (getUserTasks) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "getUserTasks", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("getProgress passes when module is available (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingAdminController, "getProgress", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
