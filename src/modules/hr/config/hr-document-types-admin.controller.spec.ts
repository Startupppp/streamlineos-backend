import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrDocumentTypesAdminController } from "./hr-document-types-admin.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrDocumentTypesAdminController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, HrDocumentTypesAdminController)).toBe("hr");
  });

  describe("HR module DISABLED — all mutation handlers refused", () => {
    it("POST /hr/document-types (create) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesAdminController, "create", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("PATCH /hr/document-types/:documentTypeId (update) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesAdminController, "update", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("DELETE /hr/document-types/:documentTypeId (remove) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesAdminController, "remove", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("create passes when module is available (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesAdminController, "create", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
