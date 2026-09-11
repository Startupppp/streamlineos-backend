import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrOnboardingDocsAdminController } from "./hr-onboarding-docs-admin.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrOnboardingDocsAdminController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, HrOnboardingDocsAdminController)).toBe("hr");
  });

  describe("HR module DISABLED — all admin handlers refused", () => {
    it("GET /hr/onboarding-docs/summary is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "summary", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("GET /hr/onboarding-docs (list) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /hr/onboarding-docs (create) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "create", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("PATCH /hr/onboarding-docs/:docId (review) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "review", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("list handler passes (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
