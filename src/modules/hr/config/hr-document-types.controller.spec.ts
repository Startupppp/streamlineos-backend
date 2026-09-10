import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrDocumentTypesController } from "./hr-document-types.controller";
import {
  makeGuardCtx,
  makeGuardRequest,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrDocumentTypesController — dual-access reads, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — read handlers serve both HR admins and self-service employees", () => {
    expect(reflector.get(REQUIRE_MODULE, HrDocumentTypesController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const guard = new ModuleGuard(new Reflector());

    it("GET /hr/document-types (list) is reachable without HR module (self:onboarding-docs path)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesController, "list", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });

    it("GET /hr/document-types/:documentTypeId (getOne) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrDocumentTypesController, "getOne", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("bite proof — adding @RequireModule would cause the above tests to fail", () => {
    it("ModuleGuard blocks when @RequireModule(hr) is set on a gated class", async () => {
      const gatedGuard = new ModuleGuard(new Reflector());
      const fakeClass = class FakeGatedController {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const handler = () => undefined;
      const req = makeGuardRequest(memberUser, MODULE_DISABLED);
      const ctx: ExecutionContext = {
        getHandler: () => handler,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);
    });
  });
});
