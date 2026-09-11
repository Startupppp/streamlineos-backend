import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { LeavePoliciesController } from "./leave-policies.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("LeavePoliciesController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, LeavePoliciesController)).toBe("hr");
  });

  describe("HR module DISABLED — all administration handlers are refused", () => {
    it("GET /hr/leave-policies (list) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePoliciesController, "list", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /hr/leave-policies (create) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePoliciesController, "create", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("PATCH /hr/leave-policies/:policyId (update) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePoliciesController, "update", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("DELETE /hr/leave-policies/:policyId (remove) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePoliciesController, "remove", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("list passes when module is available (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(LeavePoliciesController, "list", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
