import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { LeavePolicySummaryController } from "./leave-policy-summary.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("LeavePolicySummaryController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, LeavePolicySummaryController)).toBe("hr");
  });

  describe("HR module DISABLED — administration handler is refused", () => {
    it("GET /hr/leave-policy (getSummary) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePolicySummaryController, "getSummary", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("getSummary passes when module is available (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePolicySummaryController, "getSummary", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
